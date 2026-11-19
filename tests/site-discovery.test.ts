import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
	pickCompanySite,
	resolveNewsListPage,
	discoverCompanySite,
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
