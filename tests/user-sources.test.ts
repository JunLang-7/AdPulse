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

	const ok = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://sd-example.com/robots.txt": { status: 200, body: "User-agent: *\nAllow: /\n" },
		"https://sd-example.com/news": { status: 200, body: HTML },
	}), "2026-11-18T00:02:00.000Z");
	assert.equal(ok.outcome, "ok");
	assert.equal(ok.created, 2);

	const again = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://sd-example.com/robots.txt": { status: 200, body: "User-agent: *\nAllow: /\n" },
		"https://sd-example.com/news": { status: 200, body: HTML },
	}), "2026-11-18T00:03:00.000Z");
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

	const pageFail = await service.refresh("owner-1", source.id, fakeFetcher({
		"https://sd-example.com/robots.txt": { status: 404, body: "not found" },
	}), "2026-11-18T00:02:00.000Z");
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
