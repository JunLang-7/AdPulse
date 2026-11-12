import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { discoverSource } from "../packages/runtime/dist/index.js";

const officialUrl = "https://www.haier.com/about_haier/xinwen/20260102_123.shtml";
const secondUrl = "https://www.haier.com/about_haier/xinwen/20260103_124.shtml";

function reply(fields: object, exitCode = 0) {
	return {
		stdout: JSON.stringify({
			schema_version: 1, ok: true, channel: "web", action: "search", backend: "exa", ...fields,
		}),
		exitCode,
	};
}

test("Agent-Reach discovery returns only scoped, deduplicated index leads", async () => {
	const result = await discoverSource("haier_news", "products", process.execPath, async (bin, args) => {
		assert.equal(bin, process.execPath);
		assert.deepEqual(args, [
			"web", "search", "site:www.haier.com 海尔品牌资讯 新品发布 新产品上市",
			"--backend", "exa", "--limit", "5", "--timeout", "12",
		]);
		return reply({ items: [
			{ title: "合成新品发布", url: `${officialUrl}?tracking=1#top`, published_at: "2026-01-02T08:00:00+08:00", text: "合成正文", raw: { debug: true } },
			{ title: "重复", url: officialUrl },
			{ title: "外站转载", url: officialUrl.replace("www.haier.com", "www.haier.com.example.test") },
			{ title: "站内非新闻", url: "https://www.haier.com/products/123" },
			{ title: "日期无法确认", url: secondUrl, published_at: "2026-02-30" },
		] });
	});
	assert.deepEqual(result, {
		sourceKey: "haier_news",
		topic: "products",
		provider: "agent-reach/exa",
		verification: "unverified",
		candidates: [
			{ title: "合成新品发布", url: officialUrl, indexedPublishedAt: "2026-01-02" },
			{ title: "日期无法确认", url: secondUrl, indexedPublishedAt: null },
		],
	});
});

test("discovery propagates a rate limit without retrying or leaking the upstream message", async () => {
	let calls = 0;
	await assert.rejects(discoverSource("weichai_news", "campaigns", process.execPath, async (_bin, args) => {
		calls++;
		assert.equal(args[2], "site:www.weichai.com/group/weichai/cn/media-hub/news2/ 潍柴 参展 展会 活动");
		return reply({ ok: false, error: { code: "RATE_LIMITED", message: "private query" } }, 1);
	}), { message: "Agent-Reach discovery failed (RATE_LIMITED)" });
	assert.equal(calls, 1);
});

test("discovery accepts categorized and direct Weichai news on the same approved host", async () => {
	const hub = "https://www.weichai.com/group/weichai/cn/media-hub/news2/";
	const direct = `${hub}2026010312345678901/index.html`;
	const categorized = `${hub}important-news/2026010412345678901/index.html`;
	const { candidates } = await discoverSource("weichai_news", "products", process.execPath, async (_bin, args) => {
		assert.equal(args[2], "site:www.weichai.com/group/weichai/cn/media-hub/news2/ 潍柴 新品 发布");
		return reply({ items: [
			{ title: "新版栏目直链", url: `${direct}?tracking=1` },
			{ title: "分类栏目文章", url: categorized },
			{ title: "其他子域名", url: direct.replace("www.weichai.com", "m.weichai.com") },
			{ title: "栏目列表", url: `${hub}index.html` },
			{ title: "其他站内页面", url: direct.replace("/news2/", "/products/") },
		] });
	});
	assert.deepEqual(candidates.map(({ url }) => url), [direct, categorized]);
});

test("discovery rejects an unsupported response or unsuccessful process", async () => {
	for (const response of [
		reply({ schema_version: 2, items: [] }),
		reply({ items: [] }, 1),
	]) {
		await assert.rejects(discoverSource("haier_news", "products", process.execPath, async () => response),
			/unsupported response/);
	}
});

test("the operator discovery command needs explicit configuration and no database", () => {
	assert.throws(() => execFileSync(process.execPath, [
		"scripts/sources.mjs", "discover", "haier_news", "products",
	], {
		env: { SystemRoot: process.env.SystemRoot },
		stdio: "pipe",
		encoding: "utf8",
	}), { status: 1, stderr: /set AGENT_REACH_BIN/ });
});
