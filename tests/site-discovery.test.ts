import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
	pickCompanySite,
	resolveNewsListPage,
	discoverCompanySite,
	discoverCompanySites,
} from "../packages/runtime/dist/index.js";
import type { SourceFetcher } from "../packages/core/dist/index.js";

const fakeBin = resolve("agent-reach");

const result = (items: unknown): string =>
	JSON.stringify({ schema_version: 1, ok: true, channel: "web", action: "search", backend: "exa", items });

test("pickCompanySite：排除门户/百科，同 host 新闻 URL 优先，分数排序", () => {
	const pick = pickCompanySite([
		{ title: "某企业_百度百科", url: "https://baike.baidu.com/item/某企业" },
		{ title: "某企业新闻中心", url: "https://www.some-shandong.com/xwzx/list.html" },
		{ title: "某企业 - 首页", url: "https://www.some-shandong.com/" },
		{ title: "某企业报道 - 搜狐", url: "https://www.sohu.com/a/123" },
		{ title: "不合法条目", url: "not-a-url" },
	]);
	assert.ok(pick);
	assert.equal(pick.host, "www.some-shandong.com");
	assert.match(pick.listUrl, /xwzx/);
	assert.equal(pickCompanySite([
		{ title: "只有门户", url: "https://www.zhihu.com/question/1" },
	]), null, "全是门户时返回 null，不猜");
});

test("resolveNewsListPage：站内锚文本含新闻词则跳到列表页；原 URL 已是新闻页则原样", async () => {
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			return {
				status: 200,
				bytes: 100,
				body: `<a href="/about">关于我们</a><a href="/xwzx/list.html">新闻中心</a>`,
			};
		},
	};
	const fromHome = await resolveNewsListPage({ host: "www.some-shandong.com", listUrl: "https://www.some-shandong.com/" }, fetcher);
	assert.equal(fromHome, "https://www.some-shandong.com/xwzx/list.html");
	const direct = await resolveNewsListPage({ host: "www.some-shandong.com", listUrl: "https://www.some-shandong.com/news" }, fetcher);
	assert.equal(direct, "https://www.some-shandong.com/news", "本身已是新闻路径不再二次跳");
});

test("discoverCompanySite：搜索→挑站→定位列表页；无 Exa 时走 Bing 兑底", async () => {
	const calls: string[][] = [];
	const runReach = async (_executable: string, args: string[]) => {
		calls.push(args);
		return { stdout: result([
			{ title: "某企业官网首页", url: "https://www.jd-example.com/" },
			{ title: "门户转载", url: "https://www.sohu.com/a/9" },
		]), exitCode: 0 };
	};
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			// 首页必须写清企业名（验证防假冒）；新闻页返回列表链接。
			if (new URL(url).pathname === "/")
				return { status: 200, bytes: 80, body: `<title>某企业官方网站</title><a href="/news/index.html">新闻动态</a>` };
			return { status: 200, bytes: 50, body: `<a href="/news/index.html">新闻动态</a>` };
		},
	};
	const site = await discoverCompanySite("某 企业", fakeBin, { runReach, fetcher });
	assert.deepEqual(calls[0]?.slice(0, 4), ["web", "search", "某 企业 官网", "--backend"]);
	assert.equal(site.host, "www.jd-example.com");
	assert.equal(site.listUrl, "https://www.jd-example.com/news/index.html");
	assert.match(site.via, /官网首页/);

	const upstream = async () => ({
		stdout: JSON.stringify({ schema_version: 1, ok: false, channel: "web", action: "search", backend: null, items: [], error: { code: "RATE_LIMITED" } }),
		exitCode: 0,
	});
	// Exa 限流 → 转 Bing 兑底（注入 RSS 响应，不访问真实网络）。
	const bingFetcher = (): SourceFetcher => ({
		async fetchText() {
			return {
				status: 200,
				bytes: 100,
				body: `<rss><channel><item><title>某企业官网</title><link>https://www.fallback-example.com/</link></item></channel></rss>`,
			};
		},
	});
	const fallbackFetcher: SourceFetcher = {
		async fetchText(url: string) {
			if (new URL(url).pathname === "/")
				return { status: 200, bytes: 80, body: `<title>某企业官方网站</title><a href="/news/list.html">集团新闻</a>` };
			return { status: 200, bytes: 50, body: `<a href="/news/list.html">集团新闻</a>` };
		},
	};
	const viaBing = await discoverCompanySite("某企业", fakeBin, {
		runReach: upstream,
		fetcher: fallbackFetcher,
		bingFetcherFor: bingFetcher,
	});
	assert.equal(viaBing.host, "www.fallback-example.com");
});

// ===== 回归：数据接口/非 HTML 候选不能当列表页（#180） =====

test("resolveNewsListPage：候选是数据接口时改用站内已验证的新闻页", async () => {
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			if (url.endsWith("newsroom.json")) return { status: 200, bytes: 19, body: '{"newsroom":[]}' };
			if (url === "https://www.hisense-example.com/")
				return { status: 200, bytes: 60, body: `<html><a href="/xwzx/index.html">新闻中心</a></html>` };
			return { status: 200, bytes: 60, body: `<html><a href="/xwzx/2026/1118/1.html">新闻</a></html>` };
		},
	};
	const resolved = await resolveNewsListPage({
		host: "www.hisense-example.com",
		listUrl: "https://www.hisense-example.com/cn/zh/newsroom.json",
	}, fetcher);
	assert.equal(resolved, "https://www.hisense-example.com/xwzx/index.html", "数据接口地址不进入来源");
});

test("resolveNewsListPage：非 HTML 响应返回 null，不猜地址", async () => {
	const fetcher: SourceFetcher = {
		async fetchText() {
			return { status: 200, bytes: 10, body: '{"ok":true}' };
		},
	};
	assert.equal(await resolveNewsListPage({ host: "api-example.com", listUrl: "https://api-example.com/api/list" }, fetcher), null);
});

test("resolveNewsListPage：抓不到候选页时返回 null（不回落未验证地址）", async () => {
	const fetcher: SourceFetcher = {
		async fetchText() {
			throw new Error("blocked by WAF");
		},
	};
	assert.equal(await resolveNewsListPage({ host: "blocked-example.com", listUrl: "https://blocked-example.com/news" }, fetcher), null);
});

test("discoverCompanySite：首选候选的列表页是数据接口时换下一个候选", async () => {
	const runReach = async () => ({
		stdout: result([
			{ title: "某企业官网", url: "https://www.first-example.com/cn/newsroom.json" },
			{ title: "某企业官网", url: "https://www.second-example.com/" },
		]),
		exitCode: 0,
	});
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			const parsed = new URL(url);
			if (parsed.pathname === "/")
				return { status: 200, bytes: 80, body: `<title>某企业官方网站</title><a href="/news/index.html">新闻动态</a>` };
			if (parsed.host === "www.first-example.com")
				return { status: 200, bytes: 19, body: '{"newsroom":[]}' };
			return { status: 200, bytes: 60, body: `<html><a href="/news/index.html">新闻动态</a></html>` };
		},
	};
	const site = await discoverCompanySite("某企业", fakeBin, { runReach, fetcher });
	assert.equal(site.host, "www.second-example.com", "首选候选的列表页不可用时换下一个候选");
	assert.equal(site.listUrl, "https://www.second-example.com/news/index.html");
});

test("resolveNewsListPage：查询声明 JSON 输出的地址也不算列表页", async () => {
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			if (url.endsWith("/news?format=json")) return { status: 200, bytes: 12, body: '{"list":[]}' };
			if (url === "https://www.query-example.com/")
				return { status: 200, bytes: 60, body: `<html><a href="/xwzx/index.html">新闻中心</a></html>` };
			return { status: 200, bytes: 60, body: `<html><a href="/xwzx/2026/1118/1.html">新闻</a></html>` };
		},
	};
	const resolved = await resolveNewsListPage({
		host: "www.query-example.com",
		listUrl: "https://www.query-example.com/news?format=json",
	}, fetcher);
	assert.equal(resolved, "https://www.query-example.com/xwzx/index.html");
});

test("discoverCompanySite：列表页解析最多试 3 个候选，不放大请求", async () => {
	const hosts = ["h1", "h2", "h3", "h4"].map((prefix) => `${prefix}.example.com`);
	const runReach = async () => ({
		stdout: result(hosts.map((host) => ({ title: "某企业官网", url: `https://${host}/list` }))),
		exitCode: 0,
	});
	let listFetches = 0;
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			const parsed = new URL(url);
			if (parsed.pathname === "/list") {
				listFetches += 1;
				return { status: 200, bytes: 8, body: '{"a":1}' };
			}
			return { status: 200, bytes: 60, body: `<title>某企业官方网站</title><a href="/about">关于我们</a>` };
		},
	};
	await assert.rejects(
		() => discoverCompanySite("某企业", fakeBin, { runReach, fetcher }),
		/no usable HTML news list page/,
	);
	assert.equal(listFetches, 3, "4 个候选里只检查前 3 个，避免单次登记放大请求");
});

test("discoverCompanySite：搜索前几名是音乐/股票站时，仍能找到第 9 位的真官网", async () => {
	// 2026-11-19 实测：「歌尔股份」Bing 结果前 8 位是音乐/视频/股票/百科，官网在第 9 位。
	const hits = [
		{ title: "歌尔股份的歌单 - 酷我音乐", url: "https://www.kuwo.cn/playlist/1" },
		{ title: "歌尔股份 - QQ音乐", url: "https://y.qq.com/n/ryqq/singer/1" },
		{ title: "歌尔股份相关视频 - 哔哩哔哩", url: "https://www.bilibili.com/video/BV1xx" },
		{ title: "歌尔股份 - 抖音", url: "https://www.douyin.com/user/1" },
		{ title: "歌尔股份 - 咪咕音乐", url: "https://music.migu.cn/v3/music/1" },
		{ title: "歌尔股份 - 网易云音乐", url: "https://music.163.com/#/artist?id=1" },
		{ title: "歌尔股份_百度百科", url: "https://baike.baidu.com/item/歌尔股份" },
		{ title: "歌尔股份 - 酷狗音乐", url: "https://www.kugou.com/singer/1.html" },
		{ title: "歌尔股份有限公司-官方网站", url: "https://www.goertek.com/" },
		{ title: "歌尔股份 - 东方财富", url: "https://quote.eastmoney.com/sz002241.html" },
	];
	const runReach = async () => ({ stdout: result(hits), exitCode: 0 });
	let homeFetches = 0;
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			const parsed = new URL(url);
			if (parsed.hostname === "www.goertek.com") {
				if (parsed.pathname === "/")
					return { status: 200, bytes: 80, body: `<title>歌尔股份有限公司-官方网站</title><a href="/news/index.html">新闻中心</a>` };
				return { status: 200, bytes: 60, body: `<html><a href="/news/2026/1118/1.html">歌尔发布新一代声学方案</a></html>` };
			}
			homeFetches += 1;
			return { status: 200, bytes: 40, body: "<title>歌尔股份</title>" };
		},
	};
	const site = await discoverCompanySite("歌尔股份", fakeBin, { runReach, fetcher });
	assert.equal(site.host, "www.goertek.com", "音乐/视频/股票站先被排除，不再占用验证名额");
	assert.equal(site.listUrl, "https://www.goertek.com/news/index.html");
	assert.equal(homeFetches, 0, "非官方站被黑名单直接过滤，不发请求");
});

test("discoverCompanySite：同一品牌多个站时，列表页真能解析出条目的优先", async () => {
	// 实测：midea.cn 是商城站（首页无新闻、列表页解析不出条目），官网是 midea.com.cn。
	const runReach = async () => ({
		stdout: result([
			{ title: "美的-官方网站", url: "https://www.midea.cn/" },
			{ title: "美的集团-官方网站", url: "https://www.midea.com.cn/" },
		]),
		exitCode: 0,
	});
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			const parsed = new URL(url);
			if (parsed.hostname === "www.midea.cn")
				return { status: 200, bytes: 60, body: `<title>美的-官方网站</title><a href="/about">关于美的</a>` };
			if (parsed.pathname === "/")
				return { status: 200, bytes: 60, body: `<title>美的集团-官方网站</title><a href="/zh/about-midea/news">新闻</a>` };
			return {
				status: 200, bytes: 120,
				body: `<html>
<a href="/zh/about-midea/news/news-20220719">美的空调率先发布碳足迹评估报告 2022年7月19日</a>
<a href="/zh/about-midea/news/news-20210325">美的集团与上海交通大学签订战略合作协议 2021年3月25日</a>
</html>`,
			};
		},
	};
	const site = await discoverCompanySite("美的", fakeBin, { runReach, fetcher });
	assert.equal(site.listUrl, "https://www.midea.com.cn/zh/about-midea/news", "选能解析出新闻的站，而不是商城首页");
});

test("discoverCompanySites：一遍搜到商城站时，用「<企业> 新闻中心」补一轮找到真官网", async () => {
	const queries: string[] = [];
	const aggregator = {
		async search(query: string) {
			queries.push(query);
			if (query.includes("新闻中心"))
				return {
					hits: [{ title: "美的集团-新闻中心", url: "https://www.midea.com.cn/zh/about-midea/news" }],
					providers: [{ provider: "bing", label: "Bing", status: "ok", detail: null }],
				};
			return {
				hits: [{ title: "美的商城-官方网站", url: "https://www.midea.cn/" }],
				providers: [{ provider: "bing", label: "Bing", status: "ok", detail: null }],
			};
		},
	};
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			const parsed = new URL(url);
			if (parsed.hostname === "www.midea.cn")
				return { status: 200, bytes: 60, body: `<title>美的商城-官方网站</title><a href="/about">关于我们</a>` };
			if (parsed.pathname === "/")
				return { status: 200, bytes: 60, body: `<title>美的集团-官方网站</title><a href="/zh/about-midea/news">新闻</a>` };
			return {
				status: 200, bytes: 120,
				body: `<html>
<a href="/zh/about-midea/news/news-20220719">美的空调率先发布碳足迹评估报告 2022年7月19日</a>
</body></html>`,
			};
		},
	};
	const sites = await discoverCompanySites("美的", fakeBin, { aggregator, fetcher });
	assert.equal(sites[0]?.host, "www.midea.com.cn", "补一轮搜索后选到有新闻列表的官网");
	assert.deepEqual(queries, ["美的", "美的 新闻中心"], "只在第一遍没有可用条目时才补搜");
});

test("discoverCompanySites：第一遍没有可用条目时升级补搜，咨询全部源（不被免费源短路）", async () => {
	const calls: Array<{ query: string; enoughHits?: number | undefined }> = [];
	const aggregator = {
		async search(query: string, overrides?: { enoughHits?: number }) {
			calls.push(overrides?.enoughHits === undefined ? { query } : { query, enoughHits: overrides.enoughHits });
			if (query.includes("新闻中心"))
				return {
					hits: [{ title: "美的集团-新闻中心", url: "https://www.midea.com.cn/zh/about-midea/news" }],
					providers: [{ provider: "serper", label: "Serper", status: "ok", detail: null }],
				};
			// 第一遍：免费源返回 8 条垃圾（商城/字典），凑够默认门槛就会短路付费源。
			return {
				hits: [
					{ title: "美的商城-官方网站", url: "https://www.midea.cn/" },
					...Array.from({ length: 7 }, (_, i) => ({ title: `垃圾结果 ${i}`, url: `https://junk-${i}.example.com/` })),
				],
				providers: [{ provider: "bing", label: "Bing", status: "ok", detail: null }],
			};
		},
	};
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			const parsed = new URL(url);
			if (parsed.hostname === "www.midea.cn")
				return { status: 200, bytes: 60, body: `<title>美的商城-官方网站</title><a href="/about">关于我们</a>` };
			if (parsed.hostname.startsWith("junk-"))
				return { status: 200, bytes: 40, body: "<title>垃圾</title>" };
			if (parsed.pathname === "/")
				return { status: 200, bytes: 60, body: `<title>美的集团-官方网站</title><a href="/zh/about-midea/news">新闻</a>` };
			return {
				status: 200, bytes: 120,
				body: `<html><a href="/zh/about-midea/news/news-20220719">美的空调率先发布碳足迹评估报告 2022年7月19日</a></body></html>`,
			};
		},
	};
	const sites = await discoverCompanySites("美的", fakeBin, { aggregator, fetcher });
	assert.equal(sites[0]?.host, "www.midea.com.cn");
	assert.equal(calls.length, 2, "第一遍没有可用条目，只升级一次补搜");
	assert.equal(calls[1]?.enoughHits, Number.POSITIVE_INFINITY, "补搜解除免费源短路，付费源必须被咨询");
});

test("挑站排序：字典/组词站标题含品牌名不再压过真官网", () => {
	const pick = pickCompanySite([
		{ title: "美的拼音_美组词_怎么读_什么意思-字典-组词典", url: "https://www.zcdian.com/zi/513gso.html" },
		{ title: "美的首页", url: "https://www.midea.com.cn/zh" },
		{ title: "美的商城 - 智慧生活可以更美的", url: "https://www.midea.cn/" },
	]);
	assert.ok(pick);
	assert.equal(pick.host, "www.midea.com.cn", "官网排第一，字典站被重罚、商城站没有新闻信号");
});

test("discoverCompanySite：官网首页连不上（socket hang up）时仍可用列表页判归属", async () => {
	// 实测 www.midea.com.cn/ 直连挂掉，但 /zh 与新闻页都正常。
	const runReach = async () => ({
		stdout: result([{ title: "美的首页", url: "https://www.midea.com.cn/zh" }]),
		exitCode: 0,
	});
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			if (url === "https://www.midea.com.cn/") throw new Error("socket hang up");
			if (url === "https://www.midea.com.cn/zh")
				return { status: 200, bytes: 80, body: `<title>美的首页</title><a href="/zh/about-midea/news">新闻</a>` };
			return {
				status: 200, bytes: 120,
				body: `<html><a href="/zh/about-midea/news/news-20220719">美的空调率先发布碳足迹评估报告 2022年7月19日</a></body></html>`,
			};
		},
	};
	const site = await discoverCompanySite("美的", fakeBin, { runReach, fetcher });
	assert.equal(site.host, "www.midea.com.cn");
	assert.equal(site.listUrl, "https://www.midea.com.cn/zh/about-midea/news", "首页挂掉不影响：沿站内新闻入口定位列表页");
});
