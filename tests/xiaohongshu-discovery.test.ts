import assert from "node:assert/strict";
import test from "node:test";
import { discoverXiaohongshu } from "../packages/runtime/dist/index.js";

const noteUrl = "https://www.xiaohongshu.com/explore/abc123?xsec_token=token-1";
const shortUrl = "https://xhslink.com/a/xyz";

function reply(fields: object, exitCode = 0) {
	return {
		stdout: JSON.stringify({
			schema_version: 1, ok: true, channel: "xiaohongshu", action: "search", ...fields,
		}),
		exitCode,
	};
}

test("xiaohongshu discovery maps notes and drops invalid, foreign and duplicate items", async () => {
	const result = await discoverXiaohongshu("露营 好物", 5, process.execPath, async (bin, args) => {
		assert.equal(bin, process.execPath);
		assert.deepEqual(args, ["xiaohongshu", "search", "露营 好物", "--limit", "5"]);
		return reply({ items: [
			{ title: "  露营好物分享  ", url: noteUrl, author: "笔记作者", published_at: "2026-01-02T08:00:00+08:00" },
			{ title: "重复笔记", url: noteUrl, author: "另一个", published_at: "2026-01-03" },
			{ title: "外站", url: "https://www.xiaohongshu.com.example.test/explore/x", published_at: "2026-01-03" },
			{ title: "非https", url: "http://www.xiaohongshu.com/explore/y", published_at: "2026-01-03" },
			{ title: "日期无效", url: "https://www.xiaohongshu.com/explore/date", published_at: "2026-02-30" },
		] });
	});
	assert.deepEqual(result, [
		{ title: "露营好物分享", url: noteUrl, author: "笔记作者", indexedPublishedAt: "2026-01-02" },
		{ title: "日期无效", url: "https://www.xiaohongshu.com/explore/date", author: null, indexedPublishedAt: null },
	]);
});

test("xiaohongshu discovery accepts the short-link host and rejects credentials", async () => {
	const result = await discoverXiaohongshu("笔记", 5, process.execPath, async () => {
		return reply({ items: [
			{ title: "短链", url: shortUrl, published_at: "2026-01-03" },
			{ title: "带凭据", url: "https://user:pass@www.xiaohongshu.com/explore/z", published_at: "2026-01-03" },
		] });
	});
	assert.deepEqual(result.map(({ url }) => url), [shortUrl]);
});

test("xiaohongshu discovery preserves the xsec_token query string", async () => {
	const withToken = "https://www.xiaohongshu.com/discovery/item/64abc?xsec_token=AB123def&xsec_source=pc_search";
	const result = await discoverXiaohongshu("口红", 5, process.execPath, async (_bin, args) => {
		assert.deepEqual(args, ["xiaohongshu", "search", "口红", "--limit", "5"]);
		return reply({ items: [{ title: "口红试色", url: withToken, published_at: "2026-01-02" }] });
	});
	assert.equal(result[0]?.url, withToken);
});

test("xiaohongshu discovery maps a login failure without leaking the upstream message", async () => {
	let calls = 0;
	await assert.rejects(discoverXiaohongshu("笔记", 5, process.execPath, async (_bin, args) => {
		calls++;
		assert.equal(args[0], "xiaohongshu");
		return reply({ ok: false, error: { code: "NEED_LOGIN", message: "private session cookie" } }, 1);
	}), { message: "Agent-Reach xiaohongshu discovery failed (NEED_LOGIN)" });
	assert.equal(calls, 1);
});

test("xiaohongshu discovery needs an absolute pinned executable", async () => {
	await assert.rejects(discoverXiaohongshu("笔记", 5, undefined),
		{ message: "set AGENT_REACH_BIN to the absolute path of the pinned Agent-Reach executable" });
	await assert.rejects(discoverXiaohongshu("笔记", 5, "agent-reach"),
		{ message: "set AGENT_REACH_BIN to the absolute path of the pinned Agent-Reach executable" });
});

test("xiaohongshu discovery rejects an unsupported response or unsuccessful process", async () => {
	for (const response of [
		reply({ schema_version: 2, items: [] }),
		reply({ channel: "web", items: [] }),
		reply({ items: [] }, 1),
	]) {
		await assert.rejects(discoverXiaohongshu("笔记", 5, process.execPath, async () => response),
			/unsupported response/);
	}
});
