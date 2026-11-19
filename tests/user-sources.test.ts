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
	assert.match(result.reason ?? "", /没有解析出可用条目/);
	assert.equal(result.created, 0);
	const [stored] = await service.list("owner-1");
	assert.equal(stored?.lastOutcome, "failed");
	assert.equal(stored?.listUrl, "https://www.inspur.com/lcjtww/gylc32/2315125/index.html", "失败时不改地址");
	const items = await storage.transaction(async (tx) => (await tx.sourceItems.all()).filter((i) => i.sourceKey.startsWith("user:")));
	assert.equal(items.length, 0);
});
