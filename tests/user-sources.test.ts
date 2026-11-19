import assert from "node:assert/strict";
import test from "node:test";
import {
	UserSourceError,
	UserSourceService,
	parseUserListPage,
	extractDate,
	type SourceFetcher,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const HTML = `
<html><body>
<a href="/news/a.html">山东某集团 2026年11月18日 发布经营数据</a>
<a href="/news/b.shtml">山东某集团 new 工厂投产仪式在济南举行</a>
<a href="/news/b.shtml">山东某集团 new 工厂投产仪式在济南举行</a>
<a href="https://other.com/news/c.html">外站链接不算</a>
<a href="/about">首页</a>
<a href="/news/d.html">短标题</a>
<a href="/news/e.html">更多</a>
<a href="https://evil.example/news/f.html">跨域绝对链接不算</a>
</body></html>`;

const fakeFetcher = (routes: Record<string, { status: number; body: string } | null>): SourceFetcher => ({
	async fetchText(url: string) {
		const hit = routes[url];
		if (!hit) throw new Error("blocked by test");
		return { status: hit.status, bytes: hit.body.length, body: hit.body };
	},
});

test("列表解析：只留站内、标题长度足够的锚文本，去重，上限生效", () => {
	const items = parseUserListPage(HTML, "https://sd-example.com/news", "sd-example.com");
	assert.deepEqual(items.map((i) => i.itemKey), [
		"https://sd-example.com/news/a.html",
		"https://sd-example.com/news/b.shtml",
	], "外站、导航、短标题都被过滤，重复链接去重");
	assert.match(items[0]!.title, /发布经营数据/);
});

test("日期抽取：从 URL 或标题提取 YYYY-MM-DD，抽不到为 null", () => {
	assert.equal(extractDate("https://x.com/news/2026/1118/a.html", "标题 2026年11月18日 发布"), "2026-11-18");
	assert.equal(extractDate("https://x.com/news/a.html", "没有日期的标题"), null);
});

test("refresh：robots 禁止时不写条目，允许时入库并更新 lastOutcome", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "山东某集团",
		listUrl: "https://sd-example.com/news",
		subject: { kind: "brand", name: "山东某集团" },
	}, "2026-11-18T00:00:00.000Z");

	const disallowed = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://sd-example.com/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /news\n" },
	}), "2026-11-18T00:01:00.000Z");
	assert.equal(disallowed.outcome, "failed");
	assert.match(disallowed.reason ?? "", /robots/);

	const listed = await service.list("owner-1");
	assert.equal(listed[0]?.lastOutcome, "failed");

	// 刷新有 5 分钟冷却（见 UserSourceService）：后续刷新必须拉开时间，否则会被 429 拦住。
	const ok = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://sd-example.com/robots.txt": { status: 200, body: "User-agent: *\nAllow: /\n" },
		"https://sd-example.com/news": { status: 200, body: HTML },
	}), "2026-11-18T00:10:00.000Z");
	assert.equal(ok.outcome, "ok");
	assert.equal(ok.created, 2);

	const again = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://sd-example.com/robots.txt": { status: 200, body: "User-agent: *\nAllow: /\n" },
		"https://sd-example.com/news": { status: 200, body: HTML },
	}), "2026-11-18T00:20:00.000Z");
	assert.equal(again.created, 0);
	assert.equal(again.updated, 2, "同 URL 二次采集只更新不重复建条目");

	const stored = await storage.transaction(async (tx) => (await tx.sourceItems.all()).filter((i) => i.sourceKey.startsWith("user:")));
	assert.equal(stored.length, 2);
	assert.ok(stored.every((i) => i.status === "active" && i.contentScope === "title_link_only"));
	assert.ok(stored.some((i) => i.publishedAt === "2026-11-18"), "标题里的日期被抽出");
});

test("refresh：robots 5xx 保守放弃；列表页失败不改条目", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "山东某集团",
		listUrl: "https://sd-example.com/news",
		subject: { kind: "brand", name: "山东某集团" },
	}, "2026-11-18T00:00:00.000Z");
	const conservative = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://sd-example.com/robots.txt": { status: 500, body: "oops" },
	}), "2026-11-18T00:01:00.000Z");
	assert.equal(conservative.outcome, "failed");

	// 刷新有 5 分钟冷却：第二次尝试拉开到冷却之后。
	const pageFail = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://sd-example.com/robots.txt": { status: 404, body: "not found" },
	}), "2026-11-18T00:10:00.000Z");
	assert.equal(pageFail.outcome, "failed", "列表页抓不到（fetcher 抛错）也不写条目");
	const stored = await storage.transaction(async (tx) => (await tx.sourceItems.all()).filter((i) => i.sourceKey.startsWith("user:")));
	assert.equal(stored.length, 0);
});

test("归属：他人看不到、也操作不了你的站点；host 唯一；删除清理条目", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "山东某集团",
		listUrl: "https://sd-example.com/news",
		subject: { kind: "brand", name: "山东某集团" },
	}, "2026-11-18T00:00:00.000Z");
	assert.deepEqual(await service.list("owner-2"), [], "他人列表为空");
	await assert.rejects(
		() => service.refresh("owner-2", source.id, fakeFetcher({}), "2026-11-18T00:01:00.000Z"),
		(error: unknown) => error instanceof UserSourceError && error.status === 404,
	);
	await assert.rejects(
		() => service.add("owner-1", {
			label: "再次添加",
			listUrl: "https://sd-example.com/news/other",
			subject: { kind: "brand", name: "山东某集团" },
		}, "2026-11-18T00:01:00.000Z"),
		(error: unknown) => error instanceof UserSourceError && error.status === 409,
	);
	await service.refresh("owner-1", source.id, fakeFetcher({
		"https://sd-example.com/robots.txt": { status: 404, body: "not found" },
		"https://sd-example.com/news": { status: 200, body: HTML },
	}), "2026-11-18T00:02:00.000Z");
	await service.remove("owner-1", source.id);
	const stored = await storage.transaction(async (tx) => (await tx.sourceItems.all()).filter((i) => i.sourceKey.startsWith("user:")));
	assert.equal(stored.length, 0, "删除站点时条目一并清理");
});

// ===== 回归：实测页面把导航/产品链接当线索（#180） =====
// 2026-11-19 真实抓取样本（截断）：潍柴新闻列表页的页头/产品菜单、浪潮「供应链」页的产品列。
const WEICHAI_NAV_HTML = `<html><body>
<a href="/subsidiary/weichaipower/cn/services-and-support/service-contact/index.html">400-618-3066</a>
<a href="/subsidiary/weichaipower/cn/products/powertrain/engine/construction-engine/mining-dump-truck/index.html">工程机械用发动机</a>
<a href="/subsidiary/weichaipower/cn/products/powertrain/components/hydraulics/pumps/index.html">液压</a>
<a href="/subsidiary/weichaipower/cn/products/powertrain/new-energy/motor/vehicle/index.html">电机</a>
</body></html>`;

const INSPUR_PRODUCTS_HTML = `<html><body>
<a href="/lcjtww/2526546/index.html">存储</a>
<a href="/lcjtww/smart-operator-platform/index.html">广电融媒软件产品</a>
<a href="/lcjtww/led-security-cloud-platform/index.html">公共电子屏联播联控平台</a>
<a href="/lcjtww/communication/index.html">通信软件及服务产品</a>
</body></html>`;

/** 海信 newsroom.json 兜底解析出来的条目：标题就是站内路径。 */
const PATH_TITLE_HTML = `<html><body>
<a href="/content/hisense/cn/zh/ifa-2026">/content/hisense/cn/zh/ifa-2026</a>
<a href="/content/hisense/cn/zh/tresor-cuican">/content/hisense/cn/zh/tresor-cuican</a>
</body></html>`;

test("列表解析：导航/产品页不产条目（潍柴、浪潮实测样本）", () => {
	assert.deepEqual(parseUserListPage(WEICHAI_NAV_HTML, "https://www.weichaipower.com/media-hub/news/index.html", "www.weichaipower.com"), []);
	assert.deepEqual(parseUserListPage(INSPUR_PRODUCTS_HTML, "https://www.inspur.com/lcjtww/gylc32/2315125/index.html", "www.inspur.com"), []);
});

test("列表解析：路径型标题与纯电话号被拒，真文章保留", () => {
	assert.deepEqual(parseUserListPage(PATH_TITLE_HTML, "https://www.hisense.com/", "www.hisense.com"), []);

	const mixed = `<html><body>
<a href="/about">首页</a>
<a href="/contact">400-618-3066</a>
<a href="/news/2026/1118/1.html">潍柴动力发布全新动力系统 2026年11月18日</a>
</body></html>`;
	const items = parseUserListPage(mixed, "https://www.weichaipower.com/news/index.html", "www.weichaipower.com");
	assert.deepEqual(items.map((i) => i.itemKey), ["https://www.weichaipower.com/news/2026/1118/1.html"]);
});

test("列表解析：文章信号越强越靠前（日期 > 长 id > .shtml）", () => {
	const html = `<html><body>
<a href="/media-hub/news/important/1.shtml">潍柴动力与某公司达成战略合作</a>
<a href="/media-hub/news/20260825_294291.shtml">潍柴动力发布全新动力系统 2026年8月25日</a>
<a href="/news2/2026010312345678901/index.html">新版栏目直链发布会现场报道</a>
</body></html>`;
	const items = parseUserListPage(html, "https://www.weichaipower.com/media-hub/news/index.html", "www.weichaipower.com");
	assert.deepEqual(items.map((i) => i.title), [
		"潍柴动力发布全新动力系统 2026年8月25日",
		"新版栏目直链发布会现场报道",
		"潍柴动力与某公司达成战略合作",
	]);
});

test("refresh：列表页是数据接口时回退到站内新闻入口，并持久化纠正后的地址", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "山东某集团",
		listUrl: "https://sd-example.com/cn/zh/newsroom.json",
		subject: { kind: "brand", name: "山东某集团" },
	}, "2026-11-18T00:00:00.000Z");
	const newsHtml = `<html><body>
<a href="/xwzx/2026/1118/1.html">山东某集团 2026年11月18日 发布经营数据</a>
<a href="/xwzx/2026/1117/2.html">山东某集团 2026年11月17日 新工厂投产</a>
</body></html>`;
	const result = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://sd-example.com/robots.txt": { status: 200, body: "User-agent: *\nAllow: /\n" },
		"https://sd-example.com/cn/zh/newsroom.json": { status: 200, body: '{"newsroom":[{"url":"/content/x"}]}' },
		"https://sd-example.com/": { status: 200, body: `<html><body><a href="/xwzx/list.html">新闻中心</a></body></html>` },
		"https://sd-example.com/xwzx/list.html": { status: 200, body: newsHtml },
	}), "2026-11-18T00:01:00.000Z");
	assert.equal(result.outcome, "ok");
	assert.equal(result.created, 2);
	const [stored] = await service.list("owner-1");
	assert.equal(stored?.listUrl, "https://sd-example.com/xwzx/list.html", "纠正后的列表页写回来源，避免每次重复探测");
});

test("refresh：选到导航/产品页且无可用条目时如实失败，不写条目也不改地址", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "浪潮集团",
		listUrl: "https://www.inspur.com/lcjtww/gylc32/2315125/index.html",
		subject: { kind: "brand", name: "浪潮集团" },
	}, "2026-11-18T00:00:00.000Z");
	const result = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://www.inspur.com/robots.txt": { status: 404, body: "not found" },
		"https://www.inspur.com/lcjtww/gylc32/2315125/index.html": { status: 200, body: INSPUR_PRODUCTS_HTML },
		"https://www.inspur.com/": { status: 200, body: `<html><body><a href="/about">关于我们</a></body></html>` },
	}), "2026-11-18T00:01:00.000Z");
	assert.equal(result.outcome, "failed");
	assert.match(result.reason ?? "", /没有找到可用条目/);
	assert.equal(result.created, 0);
	const [stored] = await service.list("owner-1");
	assert.equal(stored?.lastOutcome, "failed");
	assert.equal(stored?.listUrl, "https://www.inspur.com/lcjtww/gylc32/2315125/index.html", "失败时不改地址");
	const items = await storage.transaction(async (tx) => (await tx.sourceItems.all()).filter((i) => i.sourceKey.startsWith("user:")));
	assert.equal(items.length, 0);
});

// ===== 三级兜底：同域 JSON → sitemap → 搜索（#180 后续） =====

test("兜底一级：同域 JSON 列表按白名单字段解析，日期取自索引", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "海信集团",
		listUrl: "https://hs-example.com/cn/zh/newsroom.json",
		subject: { kind: "brand", name: "海信集团" },
	}, "2026-11-18T00:00:00.000Z");
	const payload = JSON.stringify({
		columns: ["path", "title", "published"],
		data: [
			{ path: "/cn/zh/company/newsroom/1670", title: "海信与东帝汶签署战略合作，推进数字化与可持续发展", published: "2026-11-10" },
			{ path: "/cn/zh/company/newsroom/1671", title: "海信发布新一代智能家电整体解决方案", published: "2026-11-08" },
		],
	});
	const result = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://hs-example.com/robots.txt": { status: 404, body: "not found" },
		"https://hs-example.com/cn/zh/newsroom.json": { status: 200, body: payload },
		"https://hs-example.com/": { status: 200, body: `<html><a href="/about">关于我们</a></html>` },
	}), "2026-11-18T00:01:00.000Z");
	assert.equal(result.outcome, "ok");
	assert.equal(result.created, 2);
	const items = await storage.transaction(async (tx) => (await tx.sourceItems.all()).filter((i) => i.sourceKey.startsWith("user:")));
	assert.deepEqual(items.map((i) => i.publishedAt).sort(), ["2026-11-08", "2026-11-10"], "JSON 索引里的日期被采用");
	assert.ok(items.every((i) => !i.title.startsWith("/")), "标题取白名单字段，不做路径猜测");
});

test("兜底二级：无新闻入口的站走 sitemap，标题按上限抓文章页", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "美的",
		listUrl: "https://md-example.com/",
		subject: { kind: "brand", name: "美的" },
	}, "2026-11-18T00:00:00.000Z");
	const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://md-example.com/news/2026/1112/1.html</loc><lastmod>2026-11-12</lastmod></url>
  <url><loc>https://md-example.com/news/2026/1110/2.html</loc><lastmod>2026-11-10</lastmod></url>
  <url><loc>https://md-example.com/about</loc></url>
</urlset>`;
	let articleFetches = 0;
	const fetcher = fakeFetcher({
		"https://md-example.com/robots.txt": { status: 200, body: "User-agent: *\nAllow: /\nSitemap: https://md-example.com/sitemap.xml\n" },
		"https://md-example.com/": { status: 200, body: `<html><a href="/about">关于我们</a></html>` },
		"https://md-example.com/sitemap.xml": { status: 200, body: sitemap },
		"https://md-example.com/news/2026/1112/1.html": { status: 200, body: `<html><head><title>美的发布新一代家庭能源方案</title></head></html>` },
		"https://md-example.com/news/2026/1110/2.html": { status: 200, body: `<html><head><title>美的与多家渠道商达成年度合作</title></head></html>` },
	});
	const counted = {
		async fetchText(url: string) {
			if (url.includes("/news/2026/") && url.endsWith(".html")) articleFetches += 1;
			return fetcher.fetchText(url, { maxBytes: 512 * 1024, timeoutMs: 15_000 });
		},
	};
	const result = await service.refresh("owner-1", source.id, counted, "2026-11-18T00:01:00.000Z");
	assert.equal(result.outcome, "ok");
	assert.equal(result.created, 2);
	assert.equal(articleFetches, 2, "标题缺失才抓文章页，且只抓候选条目");
	const items = await storage.transaction(async (tx) => (await tx.sourceItems.all()).filter((i) => i.sourceKey.startsWith("user:")));
	assert.deepEqual(items.map((i) => i.title).sort(), ["美的与多家渠道商达成年度合作", "美的发布新一代家庭能源方案"]);
	assert.deepEqual(items.map((i) => i.publishedAt).sort(), ["2026-11-10", "2026-11-12"], "lastmod 作为日期");
});

test("兜底二级：sitemap 自带 news:title 时不再抓文章页", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "美的",
		listUrl: "https://md2-example.com/",
		subject: { kind: "brand", name: "美的" },
	}, "2026-11-18T00:00:00.000Z");
	const sitemap = `<?xml version="1.0"?><urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url><loc>https://md2-example.com/news/2026/1112/1.html</loc>
    <lastmod>2026-11-12</lastmod><news:title>美的发布新一代家庭能源方案</news:title></url>
</urlset>`;
	let articleFetches = 0;
	const fetcher = fakeFetcher({
		"https://md2-example.com/robots.txt": { status: 404, body: "not found" },
		"https://md2-example.com/": { status: 200, body: `<html><a href="/about">关于我们</a></html>` },
		"https://md2-example.com/sitemap.xml": { status: 200, body: sitemap },
	});
	const counted = {
		async fetchText(url: string) {
			if (url.includes("/news/2026/") && url.endsWith(".html")) articleFetches += 1;
			return fetcher.fetchText(url, { maxBytes: 512 * 1024, timeoutMs: 15_000 });
		},
	};
	const result = await service.refresh("owner-1", source.id, counted, "2026-11-18T00:01:00.000Z");
	assert.equal(result.outcome, "ok");
	assert.equal(articleFetches, 0, "索引已给标题，不再请求文章页");
});

test("兜底三级：站内搜索只取同域命中，标题+链接来自搜索结果", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "九阳",
		listUrl: "https://jy-example.com/",
		subject: { kind: "brand", name: "九阳" },
	}, "2026-11-18T00:00:00.000Z");
	const queries: string[] = [];
	const result = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://jy-example.com/robots.txt": { status: 404, body: "not found" },
		"https://jy-example.com/": { status: 200, body: `<html><a href="/about">关于我们</a></html>` },
	}), "2026-11-18T00:01:00.000Z", {
		searchFallback: async (query) => {
			queries.push(query);
			return [
				{ title: "九阳发布 2026 年新品豆浆机", url: "https://jy-example.com/news/2026/1118/1.html" },
				{ title: "别家媒体的九阳报道", url: "https://other-example.com/news/2.html" },
			];
		},
	});
	assert.equal(result.outcome, "ok");
	assert.equal(result.created, 1, "跨域命中被丢弃");
	assert.deepEqual(queries, ["九阳 新闻"], "每次刷新最多一次搜索");
	const items = await storage.transaction(async (tx) => (await tx.sourceItems.all()).filter((i) => i.sourceKey.startsWith("user:")));
	assert.equal(items[0]?.title, "九阳发布 2026 年新品豆浆机");
});

test("三级兜底全失败时如实失败，原因写明试过哪些入口", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "某企业",
		listUrl: "https://none-example.com/",
		subject: { kind: "brand", name: "某企业" },
	}, "2026-11-18T00:00:00.000Z");
	const result = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://none-example.com/robots.txt": { status: 404, body: "not found" },
		"https://none-example.com/": { status: 200, body: `<html><a href="/about">关于我们</a></html>` },
	}), "2026-11-18T00:01:00.000Z", { searchFallback: async () => [] });
	assert.equal(result.outcome, "failed");
	assert.match(result.reason ?? "", /sitemap 与搜索/);
});

test("兜底一级'：页面指向数据接口的新闻链接会被跟随（海信 newsroom.json 形态）", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "海信集团",
		listUrl: "https://hs2-example.com/cn/zh",
		subject: { kind: "brand", name: "海信集团" },
	}, "2026-11-18T00:00:00.000Z");
	const payload = JSON.stringify({ data: [
		{ path: "/cn/zh/company/newsroom/1670", title: "海信与东帝汶签署战略合作，推进数字化与可持续发展", published: "2026-11-10" },
	] });
	const result = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://hs2-example.com/robots.txt": { status: 404, body: "not found" },
		"https://hs2-example.com/cn/zh": { status: 200, body: `<html><a href="/cn/zh/newsroom.json">/cn/zh/newsroom.json</a></html>` },
		"https://hs2-example.com/cn/zh/newsroom.json": { status: 200, body: payload },
	}), "2026-11-18T00:01:00.000Z");
	assert.equal(result.outcome, "ok");
	assert.equal(result.created, 1);
	const [stored] = await service.list("owner-1");
	assert.equal(stored?.listUrl, "https://hs2-example.com/cn/zh/newsroom.json", "跟随数据接口后写回真实列表地址");
});

test("兜底三级：搜索结果里的首页/关于页不算条目", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "某企业",
		listUrl: "https://hp-example.com/",
		subject: { kind: "brand", name: "某企业" },
	}, "2026-11-18T00:00:00.000Z");
	const result = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://hp-example.com/robots.txt": { status: 404, body: "not found" },
		"https://hp-example.com/": { status: 200, body: `<html><a href="/about">关于我们</a></html>` },
	}), "2026-11-18T00:01:00.000Z", {
		searchFallback: async () => [
			{ title: "某企业股份有限公司-官方网站", url: "https://hp-example.com/" },
			{ title: "某企业发展历程与简介", url: "https://hp-example.com/about" },
		],
	});
	assert.equal(result.outcome, "failed", "首页/关于页不是文章，宁可失败也不入库");
	assert.equal(result.created, 0);
});

// ===== 异步发现：只给企业名时先建 discovering 行并入队 =====

test("beginDiscovery：建 discovering 行并入队一次，重复提交返回 409", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.beginDiscovery("owner-1", { label: "歌尔股份", subject: { kind: "brand", name: "歌尔股份" } }, "2026-11-19T00:00:00.000Z");
	assert.equal(source.status, "discovering");
	assert.equal(source.host, null);
	assert.equal(source.listUrl, null);
	assert.equal(source.discoveryStartedAt, "2026-11-19T00:00:00.000Z");

	const jobs = await storage.transaction(async (tx) => await tx.jobs.all());
	const queued = jobs.filter((job) => job.task.kind === "discover_user_source");
	assert.equal(queued.length, 1, "只入队一条发现任务");
	assert.deepEqual(queued[0]?.task, { kind: "discover_user_source", sourceId: source.id });

	await assert.rejects(
		() => service.beginDiscovery("owner-1", { label: "歌尔股份", subject: { kind: "brand", name: "歌尔股份" } }, "2026-11-19T00:00:01.000Z"),
		(error: unknown) => error instanceof UserSourceError && error.status === 409 && error.code === "discovery_pending",
	);
});

test("refresh：发现中、没有 host 时拒绝，不发起任何请求", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.beginDiscovery("owner-1", { label: "某企业", subject: { kind: "brand", name: "某企业" } }, "2026-11-19T00:00:00.000Z");
	let fetches = 0;
	const fetcher = { async fetchText() { fetches += 1; return { status: 200, bytes: 0, body: "" }; } };
	await assert.rejects(
		() => service.refresh("owner-1", source.id, fetcher, "2026-11-19T00:10:00.000Z"),
		(error: unknown) => error instanceof UserSourceError && error.status === 409 && error.code === "source_not_ready",
	);
	assert.equal(fetches, 0);
});

test("finishDiscovery：写回站点并转为 active；host 已被本人占用时如实失败", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const pending = await service.beginDiscovery("owner-1", { label: "歌尔股份", subject: { kind: "brand", name: "歌尔股份" } }, "2026-11-19T00:00:00.000Z");
	const active = await service.finishDiscovery(pending.id, { host: "www.goertek.com", listUrl: "https://www.goertek.com/news/index.html" }, "2026-11-19T00:01:00.000Z");
	assert.equal(active.status, "active");
	assert.equal(active.host, "www.goertek.com");

	const second = await service.beginDiscovery("owner-1", { label: "歌尔股份子公司", subject: { kind: "brand", name: "歌尔股份" } }, "2026-11-19T00:02:00.000Z");
	await assert.rejects(
		() => service.finishDiscovery(second.id, { host: "www.goertek.com", listUrl: "https://www.goertek.com/news/" }, "2026-11-19T00:03:00.000Z"),
		(error: unknown) => error instanceof UserSourceError && error.status === 409 && error.code === "host_exists",
	);
	await service.failDiscovery(second.id, "这个网站已经添加过", "2026-11-19T00:03:00.000Z");
	const [failed] = (await service.list("owner-1")).filter((s) => s.id === second.id);
	assert.equal(failed?.status, "failed");
	assert.match(failed?.lastReason ?? "", /已经添加过/);
});

// ===== 换站回退：一个网站不行就换另一个 =====

const MD_ARTICLES = `<html><body>
<a href="/zh/about-midea/news/news-20220719">美的空调率先发布碳足迹和减碳量评估报告 2022年7月19日</a>
<a href="/zh/about-midea/news/news-20210325">美的集团与上海交通大学签订战略合作协议 2021年3月25日</a>
</body></html>`;

test("refresh：注册站采不到内容时换到备选官网，并把 host 一起写回", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "美的",
		listUrl: "https://www.midea.cn/",
		subject: { kind: "brand", name: "美的" },
	}, "2026-11-19T00:00:00.000Z");
	const result = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://www.midea.cn/robots.txt": { status: 404, body: "not found" },
		"https://www.midea.cn/": { status: 200, body: `<html><a href="/about">关于我们</a></html>` },
	}), "2026-11-19T00:01:00.000Z", {
		discoverSites: async () => [
			{ host: "www.midea.com.cn", listUrl: "https://www.midea.com.cn/zh/about-midea/news" },
		],
		fetcherFor: (host) => host === "www.midea.com.cn"
			? fakeFetcher({
				"https://www.midea.com.cn/robots.txt": { status: 404, body: "not found" },
				"https://www.midea.com.cn/zh/about-midea/news": { status: 200, body: MD_ARTICLES },
			})
			: fakeFetcher({}),
	});
	assert.equal(result.outcome, "ok");
	assert.equal(result.created, 2, "备选站点采到了真实新闻");
	const [stored] = await service.list("owner-1");
	assert.equal(stored?.host, "www.midea.com.cn", "host 换成真正能采的站");
	assert.equal(stored?.listUrl, "https://www.midea.com.cn/zh/about-midea/news");
});

test("refresh：备选站点已被本人登记过时不抢，失败原因列出试过的站", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const first = await service.add("owner-1", {
		label: "美的商城",
		listUrl: "https://www.midea.cn/",
		subject: { kind: "brand", name: "美的" },
	}, "2026-11-19T00:00:00.000Z");
	await service.add("owner-1", {
		label: "美的集团",
		listUrl: "https://www.midea.com.cn/zh/about-midea/news",
		subject: { kind: "brand", name: "美的" },
	}, "2026-11-19T00:00:01.000Z");
	const result = await service.refresh("owner-1", first.id, fakeFetcher({
		"https://www.midea.cn/robots.txt": { status: 404, body: "not found" },
		"https://www.midea.cn/": { status: 200, body: `<html><a href="/about">关于我们</a></html>` },
	}), "2026-11-19T00:01:00.000Z", {
		discoverSites: async () => [
			{ host: "www.midea.com.cn", listUrl: "https://www.midea.com.cn/zh/about-midea/news" },
		],
		fetcherFor: () => fakeFetcher({}),
	});
	assert.equal(result.outcome, "failed");
	assert.match(result.reason ?? "", /已尝试备选站点：www\.midea\.com\.cn/);
	assert.equal((await service.list("owner-1")).find((s) => s.id === first.id)?.host, "www.midea.cn", "不抢已登记的站");
});

test("refresh：当前站 robots 不可达时仍会换到备选站点", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "海尔",
		listUrl: "https://www.haier.net/",
		subject: { kind: "brand", name: "海尔" },
	}, "2026-11-19T00:00:00.000Z");
	const result = await service.refresh("owner-1", source.id, fakeFetcher({}), "2026-11-19T00:01:00.000Z", {
		discoverSites: async () => [
			{ host: "www.haier.com", listUrl: "https://www.haier.com/about_haier/xinwen/" },
		],
		fetcherFor: (host) => host === "www.haier.com"
			? fakeFetcher({
				"https://www.haier.com/robots.txt": { status: 404, body: "not found" },
				"https://www.haier.com/about_haier/xinwen/": { status: 200, body: `<html><body>
<a href="/about_haier/xinwen/2026/1118/1.shtml">海尔官宣全球品牌代言人 2026年11月18日</a>
<a href="/about_haier/xinwen/2026/1110/2.shtml">海尔发布新一代智慧家庭方案 2026年11月10日</a>
</body></html>` },
			})
			: fakeFetcher({}),
	});
	assert.equal(result.outcome, "ok", "robots 被挡不应直接放弃换站");
	const [stored] = await service.list("owner-1");
	assert.equal(stored?.host, "www.haier.com");
	assert.equal(result.created, 2);
});

// ===== 简中偏好：sitemap 优先中文地图、多子地图下钻、站点排序偏好简中 =====

test("sitemap 兜底：robots 声明多语言地图时优先中文地图，并下钻 sitemapindex 子地图", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	// 海尔形态：英文站首页采不到，robots 声明 25 个分语言 sitemap，新闻在 cn → other.xml。
	const source = await service.add("owner-1", {
		label: "海尔",
		listUrl: "https://www.haier.com/press-events/news/",
		subject: { kind: "brand", name: "海尔" },
	}, "2026-11-19T00:00:00.000Z");
	const robots = `User-agent: *\nDisallow: /ru/\nSitemap: https://www.haier.com/iq/sitemap.xml\nSitemap: https://www.haier.com/cn/sitemap.xml\nSitemap: https://www.haier.com/tz/sitemap.xml\n`;
	const cnIndex = `<?xml version="1.0"?><sitemapindex>
  <sitemap><loc>https://www.haier.com/cn/sitemap/product.xml</loc></sitemap>
  <sitemap><loc>https://www.haier.com/cn/sitemap/other.xml</loc></sitemap>
</sitemapindex>`;
	const productMap = `<?xml version="1.0"?><urlset>
  <url><loc>https://www.haier.com/cn/promo/20261110/w1.html</loc><lastmod>2026-11-10</lastmod></url>
</urlset>`;
	const otherMap = `<?xml version="1.0"?><urlset>
  <url><loc>https://www.haier.com/about_haier/xinwen/20260522_291331.shtml</loc><lastmod>2026-11-19</lastmod></url>
  <url><loc>https://www.haier.com/about_haier/xinwen/20260520_291300.shtml</loc><lastmod>2026-11-18</lastmod></url>
</urlset>`;
	const fetched: string[] = [];
	const fetcher = {
		async fetchText(url: string) {
			fetched.push(url);
			const routes: Record<string, string> = {
				"https://www.haier.com/robots.txt": robots,
				"https://www.haier.com/press-events/news/": `<html><a href="/about">关于我们</a></html>`,
				"https://www.haier.com/cn/sitemap.xml": cnIndex,
				"https://www.haier.com/cn/sitemap/product.xml": productMap,
				"https://www.haier.com/cn/promo/20261110/w1.html": `<html><head><title>海尔洗衣机限时促销活动介绍价格参考-海尔官网</title></head></html>`,
				"https://www.haier.com/cn/sitemap/other.xml": otherMap,
				"https://www.haier.com/about_haier/xinwen/20260522_291331.shtml": `<html><head><title>海尔官宣全球品牌代言人</title></head></html>`,
				"https://www.haier.com/about_haier/xinwen/20260520_291300.shtml": `<html><head><title>海尔发布新一代智慧家庭方案</title></head></html>`,
			};
			const body = routes[url];
			if (body === undefined) return { status: 404, bytes: 0, body: "" };
			return { status: 200, bytes: body.length, body };
		},
	};
	const result = await service.refresh("owner-1", source.id, fetcher, "2026-11-19T00:01:00.000Z");
	assert.equal(result.outcome, "ok");
	assert.equal(result.created, 2, "中文子地图里的新闻文章被采到");
	assert.ok(!fetched.includes("https://www.haier.com/iq/sitemap.xml"), "非中文地图不优先");
	assert.ok(fetched.includes("https://www.haier.com/cn/sitemap/other.xml"), "下钻到含新闻的子地图");
	const items = await storage.transaction(async (tx) => (await tx.sourceItems.all()).filter((i) => i.sourceKey.startsWith("user:")));
	assert.deepEqual(items.map((i) => i.title).sort(), ["海尔发布新一代智慧家庭方案", "海尔官宣全球品牌代言人"]);
	assert.deepEqual(items.map((i) => i.publishedAt).sort(), ["2026-11-18", "2026-11-19"], "lastmod 作为日期");
});

test("sitemap 兜底：条目过少时试新闻文章的父目录作为列表页", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "海尔",
		listUrl: "https://www.haier.com/press-events/news/",
		subject: { kind: "brand", name: "海尔" },
	}, "2026-11-19T00:00:00.000Z");
	const robots = `User-agent: *\nSitemap: https://www.haier.com/cn/sitemap.xml\n`;
	const cnIndex = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://www.haier.com/cn/sitemap/other.xml</loc></sitemap></sitemapindex>`;
	const otherMap = `<?xml version="1.0"?><urlset>
  <url><loc>https://www.haier.com/about_haier/xinwen/20260522_291331.shtml</loc><lastmod>2026-11-19</lastmod></url>
</urlset>`;
	const routes: Record<string, string> = {
		"https://www.haier.com/robots.txt": robots,
		"https://www.haier.com/press-events/news/": `<html><a href="/about">关于我们</a></html>`,
		"https://www.haier.com/cn/sitemap.xml": cnIndex,
		"https://www.haier.com/cn/sitemap/other.xml": otherMap,
		"https://www.haier.com/about_haier/xinwen/20260522_291331.shtml": `<html><head><title>618开门红海尔拿下天猫大家电TOP1-海尔官网</title></head></html>`,
		// 父目录：真正的中文新闻列表页
		"https://www.haier.com/about_haier/xinwen/": `<html><body>
<a href="/about_haier/xinwen/20260522_291331.shtml">618开门红4小时，海尔拿下天猫大家电TOP1 2026年05月22日</a>
<a href="/about_haier/xinwen/20260520_291300.shtml">海尔官宣全球品牌代言人 2026年05月20日</a>
<a href="/about_haier/xinwen/20260518_291280.shtml">海尔发布新一代智慧家庭方案 2026年05月18日</a>
</body></html>`,
	};
	const fetcher = {
		async fetchText(url: string) {
			const body = routes[url];
			if (body === undefined) return { status: 404, bytes: 0, body: "" };
			return { status: 200, bytes: body.length, body };
		},
	};
	const result = await service.refresh("owner-1", source.id, fetcher, "2026-11-19T00:01:00.000Z");
	assert.equal(result.outcome, "ok");
	assert.equal(result.created, 3, "父目录列表页的三条新闻全被采到");
	const [stored] = await service.list("owner-1");
	assert.equal(stored?.listUrl, "https://www.haier.com/about_haier/xinwen/", "列表页纠正为父目录");
});
