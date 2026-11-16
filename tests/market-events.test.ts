import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MarketEventError, MarketEventService, TaskService, type MarketEventInput } from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

import { eventInput, taskInput } from "./market-event-fixtures.ts";

test("market events: owner isolation, scoped deduplication and retries never create Sessions", async () => {
	const db = new MemoryStorage(); const events = new MarketEventService(db);
	const created = await events.create("alice", "key", eventInput());
	assert.equal(created.status, "created");
	assert.equal(created.version.candidate.status, "evidence_ready");
	assert.deepEqual(await events.create("alice", "key", eventInput()), created);
	const duplicate = await events.create("alice", "other", { ...eventInput(), title: "换标题重试" });
	assert.equal(duplicate.status, "duplicate"); assert.equal(duplicate.version.id, created.version.id);
	await assert.rejects(events.create("alice", "key", { ...eventInput(), title: "不同请求" }), (e: unknown) => e instanceof MarketEventError && e.status === 409);
	assert.equal(await events.detail("bob", created.version.eventId), null);
	assert.deepEqual(await events.list("bob"), []);
	const bob = await events.create("bob", "key", eventInput()); assert.notEqual(bob.version.eventId, created.version.eventId);
	assert.equal((await events.list("alice")).length, 1);
	await db.transaction(async tx => { for (const table of [tx.sessions, tx.jobs, tx.deliveries, tx.notificationItems]) assert.deepEqual(await table.all(), []); });
});
test("market events: missing/link/title/search/excerpt evidence remains explicit", async () => {
	for (const scope of ["link_only", "title_only", "search_snippet", "excerpt"] as const) {
		const input = eventInput(); input.eventTime = null; input.conditions = null;
		input.sources[0] = { ...input.sources[0]!, scope, content: scope === "link_only" ? null : "测试摘要", origin: scope === "search_snippet" ? "search" : "unknown", publishedAt: null };
		input.citations = { subject: null, eventTime: null, conditions: null };
		const result = await new MarketEventService(new MemoryStorage()).create("alice", "k", input);
		assert.equal(result.version.candidate.status, "insufficient"); assert.equal(result.version.input.eventTime, null);
		assert.equal(result.version.input.sources[0]?.publishedAt, null); assert.equal(result.version.input.sources[0]?.scope, scope);
		assert.ok(result.version.candidate.reasons.includes("事件时间未知"));
	}
});
test("market events: domain refuses fabricated citations, unsafe links and search body claims", async () => {
	const service = new MarketEventService(new MemoryStorage());
	const quote = eventInput(); quote.citations.subject = { sourceIndex: 0, quote: "根本不存在" };
	await assert.rejects(service.create("a", "x", quote), /citation not found/);
	for (const url of ["javascript:alert(1)", "https://user:pass@example.com", "file:///tmp/test"]) {
		const input = eventInput(); input.sources[0]!.url = url; await assert.rejects(service.create("a", "x", input), /source URL/);
	}
	const search = eventInput(); search.sources[0]!.origin = "search";
	await assert.rejects(service.create("a", "x", search), /search results are not body/);
});
test("market events: foreign task references fail atomically, own version/reason retained", async () => {
	const db = new MemoryStorage(); const task = await new TaskService(db).create("bob", "task", taskInput); const events = new MarketEventService(db);
	const input = eventInput(); input.taskRefs = [{ taskId: task.taskId, taskVersion: 1, reason: "人工关联" }];
	await assert.rejects(events.create("alice", "k", input), /task not found/); assert.deepEqual(await events.list("alice"), []);
	const own = await events.create("bob", "k", input); assert.equal(own.version.input.taskRefs[0]?.reason, "人工关联");
	await assert.rejects(events.revise("alice", own.version.eventId, "r", 1, eventInput(), "伪造"), /event not found/);
});
test("market events: immutable history and stable material references; editorial edits do not advance evidence", async () => {
	const events = new MarketEventService(new MemoryStorage()); const first = await events.create("a", "1", eventInput());
	const editorial = await events.revise("a", first.version.eventId, "2", 1, { ...eventInput(), title: "更清楚的标题" }, "更正标题");
	assert.equal(editorial.version.evidenceRevision, 1);
	assert.deepEqual(editorial.version.materials, first.version.materials);
	const correction = structuredClone(editorial.version.input); correction.sources[0]!.content += " 新增证据。";
	const next = await events.revise("a", first.version.eventId, "3", 2, correction, "补充原文"); assert.equal(next.version.evidenceRevision, 2);
	assert.deepEqual(await events.revise("a", first.version.eventId, "3", 2, correction, "补充原文"), next);
	await assert.rejects(events.revise("a", first.version.eventId, "4", 1, correction, "过期修订"), /version conflict/);
	const detail = await events.detail("a", first.version.eventId); assert.equal(detail?.versions.length, 3);
	assert.deepEqual(detail?.versions[2], first.version); assert.notEqual(next.version.materials[0]?.id, first.version.materials[0]?.id);
	const unchanged = await events.revise("a", first.version.eventId, "5", 3, correction, "重复提交"); assert.equal(unchanged.status, "unchanged");
});
test("market events: reposts require explicit revision; source aliases prevent duplicate event creation", async () => {
	const events = new MarketEventService(new MemoryStorage()); const first = await events.create("a", "1", eventInput());
	const repost = eventInput(); repost.sources.push({ ...repost.sources[0]!, url: "https://example.net/repost", origin: "repost" });
	const revision = await events.revise("a", first.version.eventId, "2", 1, repost, "补充转载依据");
	const separate = eventInput(); separate.occurrenceKey = "换标识"; separate.title = "转载标题"; separate.sources = [repost.sources[1]!];
	const duplicate = await events.create("a", "3", separate); assert.equal(duplicate.status, "duplicate"); assert.equal(duplicate.version.id, revision.version.id);
});
test("market events: five pinned guance cases retain simulations, unknown fields and original date precision", async () => {
	const fixtures = JSON.parse(readFileSync(new URL("./fixtures/market-events-guance.json", import.meta.url), "utf8")) as MarketEventInput[];
	assert.equal(fixtures.length, 5); const events = new MarketEventService(new MemoryStorage());
	for (const input of fixtures) {
		const result = await events.create("a", input.occurrenceKey, input);
		assert.equal(result.version.input.provenance.simulated, true); assert.match(result.version.input.provenance.reference!, /01ba5c2992/);
		assert.equal(result.version.input.sources[0]?.url, null); assert.match(result.version.input.sources[0]!.publishedAt!, /^\d{4}-\d{2}-\d{2}$/);
		assert.equal(result.version.candidate.status, "insufficient");
		await assert.rejects(events.revise("a", result.version.eventId, input.occurrenceKey+"-real", 1, { ...input, provenance: { simulated: false, reference: null, transformation: null } }, "去掉模拟"), /simulation provenance/);
	}
});
test("market events: automatic input reuses contract but retains title-only limitations and refuses purged items", async () => {
	const db = new MemoryStorage(); const events = new MarketEventService(db);
	await db.transaction(tx => tx.sourceItems.put({ id: "source-1", sourceKey: "haier_news", itemKey: "one", title: "人造列表标题", itemUrl: "https://example.com/list/item", publishedAt: null, firstSeenAt: "2026-11-16T00:00:00Z", lastSeenAt: "2026-11-16T01:00:00Z", titleUpdatedAt: null, contentScope: "title_link_only", status: "active" }));
	const result = await events.importSourceItem("a", "key", "source-1", { kind: "brand", name: "测试品牌" }, "announcement");
	assert.equal(result.version.method, "source_item"); assert.equal(result.version.sourceItemId, "source-1"); assert.equal(result.version.input.sources[0]?.scope, "title_only");
	assert.equal(result.version.candidate.status, "insufficient");
	assert.equal((await events.importSourceItem("a", "key2", "source-1", { kind: "brand", name: "测试品牌" }, "announcement")).status, "duplicate");
	await db.transaction(async tx => { const item = await tx.sourceItems.get("source-1"); assert.ok(item); await tx.sourceItems.put({ ...item, status: "purged", title: "" }); });
	await assert.rejects(events.importSourceItem("b", "3", "source-1", { kind: "brand", name: "测试品牌" }, "announcement"), /source item not found/);
});

test("market events: copied automatic materials keep their original reference and acquisition method after manual revision", async () => {
	const db = new MemoryStorage(); const service = new MarketEventService(db);
	await db.transaction(tx => tx.sourceItems.put({ id: "public", sourceKey: "haier_news", itemKey: "public", title: "列表标题", itemUrl: "https://example.com/public", publishedAt: null, firstSeenAt: "2026-11-16T00:00:00Z", lastSeenAt: "2026-11-16T01:00:00Z", titleUpdatedAt: null, contentScope: "title_link_only", status: "active" }));
	const first = await service.importSourceItem("a", "1", "public", { kind: "brand", name: "测试品牌" }, "announcement");
	const next = await service.revise("a", first.version.eventId, "2", 1, { ...first.version.input, title: "编辑标题" }, "编辑说明");
	assert.equal(next.version.method, "manual"); assert.deepEqual(next.version.materials, first.version.materials);
	assert.equal(next.version.materials[0]?.method, "source_item"); assert.equal(next.version.materials[0]?.sourceItemId, "public");
});
test("market events: a shared article does not merge different subjects or event categories", async () => {
	const service = new MarketEventService(new MemoryStorage());
	const first = await service.create("a", "1", eventInput());
	const second = await service.create("a", "2", { ...eventInput(), subject: { kind: "competitor", name: "另一品牌" } });
	const third = await service.create("a", "3", { ...eventInput(), type: "campaign" });
	assert.equal(new Set([first.version.eventId, second.version.eventId, third.version.eventId]).size, 3);
});
test("market events: a correction may mark material simulated, subsequent revisions cannot remove it", async () => {
	const service = new MarketEventService(new MemoryStorage()); const first = await service.create("a", "1", eventInput());
	const marked = { ...eventInput(), provenance: { simulated: true, reference: "synthetic-fixture", transformation: "correcting original classification" } };
	const corrected = await service.revise("a", first.version.eventId, "2", 1, marked, "更正为模拟材料");
	assert.equal(corrected.version.candidate.status, "insufficient");
	await assert.rejects(service.revise("a", first.version.eventId, "3", 2, eventInput(), "去掉标记"), /simulation provenance/);
});
