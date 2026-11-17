import assert from "node:assert/strict";
import test from "node:test";
import { MarketEventService, RETENTION_DAYS } from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { eventInput } from "./market-event-fixtures.ts";

/** 固定时钟：生命周期全部断言都基于绝对时刻，不受运行环境影响。 */
function clock() {
	let now = "2026-11-17T10:00:00.000Z";
	return { now: () => now, set: (value: string) => { now = value; } };
}

test("事件生命周期：锚点取最后业务更新，365 天后到期", async () => {
	const storage = new MemoryStorage();
	const service = new MarketEventService(storage, () => "2026-11-17T10:00:00.000Z");
	const created = await service.create("owner", "key-1", eventInput());
	const lifecycle = await service.lifecycle("owner", created.version.eventId);
	assert.ok(lifecycle);
	assert.equal(lifecycle.anchor, "2026-11-17T10:00:00.000Z");
	assert.equal(lifecycle.anchorSource, "last_business_update");
	assert.equal(lifecycle.retentionDays, RETENTION_DAYS);
	assert.equal(lifecycle.expiresAt, "2027-11-17T10:00:00.000Z");
	assert.equal(lifecycle.state, "active");
	assert.equal(lifecycle.expired, false);
});

test("事件生命周期：补录旧公告不会一录入就到期", async () => {
	const storage = new MemoryStorage();
	// 事件时间与来源发布时间都是 2020 年，但录入发生在 2026-11-17。
	const input = { ...eventInput(), eventTime: "2020-05-01", sources: [{ ...eventInput().sources[0]!, publishedAt: "2020-05-01" }] };
	const service = new MarketEventService(storage, () => "2026-11-17T10:00:00.000Z");
	const created = await service.create("owner", "key-1", input);
	const lifecycle = await service.lifecycle("owner", created.version.eventId);
	assert.equal(lifecycle?.expired, false, "按录入时间计时，不按外部发布时间");
	assert.equal(lifecycle?.expiresAt, "2027-11-17T10:00:00.000Z");
});

test("事件生命周期：到期即限访——详情、列表、修订都不再返回", async () => {
	const storage = new MemoryStorage();
	const time = clock();
	const service = new MarketEventService(storage, time.now);
	const created = await service.create("owner", "key-1", eventInput());
	const eventId = created.version.eventId;

	// 到期前一毫秒仍可用。
	time.set("2027-11-17T09:59:59.999Z");
	assert.ok(await service.detail("owner", eventId));
	assert.equal((await service.list("owner")).length, 1);

	// 到期时刻起：不可读、不出现在列表。
	time.set("2027-11-17T10:00:00.000Z");
	assert.equal(await service.detail("owner", eventId), null);
	assert.equal((await service.list("owner")).length, 0);
	const lifecycle = await service.lifecycle("owner", eventId);
	assert.equal(lifecycle?.state, "expired");
	assert.equal(lifecycle?.expired, true, "状态查询仍可解释「为什么打不开」");

	// 修订必须被拒绝，且不能通过写入续期。
	await assert.rejects(
		() => service.revise("owner", eventId, "key-2", 1, { ...eventInput(), title: "到期后改名" }, "试图续期"),
		(error: { status?: number }) => error.status === 404,
	);
	assert.equal((await service.lifecycle("owner", eventId))?.expired, true, "拒绝后仍然到期");
});

test("事件生命周期：幂等重放不能返回到期事件", async () => {
	const storage = new MemoryStorage();
	const time = clock();
	const service = new MarketEventService(storage, time.now);
	const created = await service.create("owner", "key-1", eventInput());
	time.set("2027-11-17T10:00:00.000Z");
	await assert.rejects(
		() => service.create("owner", "key-1", eventInput()),
		(error: { status?: number }) => error.status === 404,
	);
	assert.ok(created.version.eventId);
});

test("事件生命周期：判定只看事件版本，读取不推进锚点", async () => {
	const storage = new MemoryStorage();
	const time = clock();
	const service = new MarketEventService(storage, time.now);
	const created = await service.create("owner", "key-1", eventInput());
	time.set("2026-12-01T00:00:00.000Z");
	await service.list("owner");
	await service.detail("owner", created.version.eventId);
	const lifecycle = await service.lifecycle("owner", created.version.eventId);
	assert.equal(lifecycle?.anchor, "2026-11-17T10:00:00.000Z", "查看与筛选不续期");

	// 真正修订才推进锚点。
	const revised = await service.revise("owner", created.version.eventId, "key-2", 1, { ...eventInput(), title: "修订后的标题" }, "补充标题");
	assert.equal(revised.version.version, 2);
	const after = await service.lifecycle("owner", created.version.eventId);
	assert.equal(after?.anchor, "2026-12-01T00:00:00.000Z", "修订推进锚点");
});
