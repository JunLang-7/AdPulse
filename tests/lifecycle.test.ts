import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
	AuthenticationService,
	ComparisonService,
	EvidenceService,
	InvestigationAlertService,
	NotificationQueue,
	TaskService,
	MS_PER_DAY,
	RETENTION_DAYS,
	taskLifecycleIn,
} from "../packages/core/dist/index.js";
import { MemoryStorage, PostgresStorage } from "../packages/storage/dist/index.js";
import { selectionEvidence, selectionFixture } from "./selection-helpers.ts";

const taskInput = {
	product: "【模拟】生命周期任务",
	strategy: { objective: "咨询", audience: [], channels: { ads: {} }, sellingPoints: [] },
	observation: {},
	rules: { metricKey: "cost_per_consultation" as const, metricDefinition: "单次咨询成本", currency: "CNY", unit: "分", statWindowDays: 1, alertThresholdMinor: 100, minimumSpendMinor: 0, minimumConsultations: 0, maxPushRounds: 3 },
};

async function fixture(start = "2026-01-01T00:00:00.000Z") {
	let now = start;
	const clock = () => now;
	const storage = new MemoryStorage();
	const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() };
	const session = await new AuthenticationService(storage).createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), now);
	const tasks = new TaskService(storage, clock);
	const task = await tasks.create(session.userId, randomUUID(), taskInput);
	return {
		storage, owner: session.userId, tasks, task, clock,
		setTime(value: string) { now = value; },
		async lifecycle() {
			return storage.transaction(async (tx) => {
				const head = await tx.tasks.get(task.taskId); assert.ok(head);
				return taskLifecycleIn(tx, head, new Date(now));
			});
		},
	};
}

test("生命周期：365 天按 UTC 绝对时刻计算，一天不多一天不少", async () => {
	const f = await fixture();
	const fresh = await f.lifecycle();
	assert.equal(fresh.retentionDays, RETENTION_DAYS);
	assert.equal(fresh.state, "active");
	assert.equal(fresh.anchorSource, "last_business_update");
	assert.equal(Date.parse(fresh.expiresAt), Date.parse("2026-01-01T00:00:00.000Z") + RETENTION_DAYS * MS_PER_DAY);

	f.setTime(new Date(Date.parse(fresh.expiresAt) - 1).toISOString());
	assert.equal((await f.lifecycle()).state, "active", "到期前 1ms 仍可访问");
	assert.ok(await f.tasks.get(f.owner, f.task.taskId), "未到期任务可读");

	f.setTime(fresh.expiresAt);
	assert.equal((await f.lifecycle()).state, "expired", "到期时刻即限访");
	assert.equal(await f.tasks.get(f.owner, f.task.taskId), null);
	assert.deepEqual(await f.tasks.list(f.owner), [], "到期任务不出现在列表里");
});

test("生命周期：普通查看、重试与再次判定都不续期", async () => {
	const f = await fixture();
	const first = await f.lifecycle();
	f.setTime("2026-06-01T00:00:00.000Z");
	await f.tasks.get(f.owner, f.task.taskId); // 查看
	await f.tasks.list(f.owner); // 列表
	const again = await f.lifecycle();
	assert.equal(again.expiresAt, first.expiresAt, "读取动作不推进到期时刻");
	assert.equal(again.lastBusinessUpdate, first.lastBusinessUpdate);
});

test("生命周期：观测期结束早于最后业务更新时按结束计时", async () => {
	let now = "2026-01-01T00:00:00.000Z";
	const clock = () => now;
	const storage = new MemoryStorage();
	const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() };
	const session = await new AuthenticationService(storage).createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), now);
	const observation = { startsAt: "2025-12-01T00:00:00.000Z", endsAt: "2025-12-15T00:00:00.000Z" };
	const task = await new TaskService(storage, clock).create(session.userId, randomUUID(), { ...taskInput, observation });
	now = "2026-03-01T00:00:00.000Z";
	const tasks = new TaskService(storage, clock);
	// 任务修订把「最后业务更新」推到 03-01，但观测期已在 2025-12-15 结束。
	await tasks.revise(session.userId, task.taskId, 1, randomUUID(), { ...taskInput, observation });
	const lifecycle = await tasks.lifecycle(session.userId, task.taskId);
	assert.ok(lifecycle);
	assert.equal(lifecycle.anchorSource, "observation_ends_at", "较早的观测期结束优先");
	assert.equal(lifecycle.anchor, "2025-12-15T00:00:00.000Z");
	assert.equal(Date.parse(lifecycle.expiresAt), Date.parse("2025-12-15T00:00:00.000Z") + RETENTION_DAYS * MS_PER_DAY);
});

test("生命周期：到期任务的证据、比较与告警评估被拒绝", async () => {
	let now = "2026-01-01T00:00:00.000Z";
	const clock = () => now;
	const storage = new MemoryStorage();
	const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() };
	const session = await new AuthenticationService(storage).createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), now);
	const tasks = new TaskService(storage, clock);
	const task = await tasks.create(session.userId, randomUUID(), taskInput);
	const evidence = new EvidenceService(storage, clock);
	const imported = await evidence.import(session.userId, randomUUID(), {
		schemaVersion: 1, taskRef: { taskId: task.taskId, taskVersion: 1 }, records: [selectionEvidence()],
	});
	assert.ok(imported[0]);
	now = new Date(Date.parse("2026-01-01T00:00:00.000Z") + RETENTION_DAYS * MS_PER_DAY).toISOString();
	const expiredTasks = new TaskService(storage, clock);
	assert.equal(await expiredTasks.get(session.userId, task.taskId), null);
	await assert.rejects(
		evidence.import(session.userId, randomUUID(), { schemaVersion: 1, taskRef: { taskId: task.taskId, taskVersion: 1 }, records: [selectionEvidence(2100)] }),
		/task not found/,
		"到期任务不再接受新的证据导入",
	);
	const comparisons = new ComparisonService(storage, clock);
	await assert.rejects(
		comparisons.evaluate(session.userId, randomUUID(), { current: { evidenceId: imported[0]!.evidenceId, version: 1 } }),
		/task not found/,
	);
	assert.equal(await expiredTasks.lifecycle(session.userId, task.taskId).then((value) => value?.state), "expired", "判定查询仍可读到状态");
	await assert.rejects(new InvestigationAlertService(storage, clock).evaluateComparison(session.userId, "missing"), /comparison result not found/);
});

test("生命周期：到期任务不再通过发送前复检（提醒不发出）", async () => {
	const f = await selectionFixture(new MemoryStorage());
	await f.evaluate();
	const items = await new NotificationQueue(f.storage).pending(f.owner);
	assert.equal(items.length, 1);
	const { notificationInputsStillCurrentIn } = await import("../packages/core/dist/index.js");
	const now = new Date("2026-11-16T00:01:00.000Z");
	assert.equal(await f.storage.transaction((tx) => notificationInputsStillCurrentIn(tx, items[0]!, now)), true);
	const later = new Date(Date.parse("2026-11-16T00:01:00.000Z") + RETENTION_DAYS * MS_PER_DAY);
	assert.equal(
		await f.storage.transaction((tx) => notificationInputsStillCurrentIn(tx, items[0]!, later)),
		false,
		"任务到期后，其提醒在发送前被判定失效",
	);
});

test("PostgreSQL：生命周期判定与限访在同一存储上一致", { skip: !process.env.TEST_DATABASE_URL }, async () => {
	const url = process.env.TEST_DATABASE_URL!;
	const storage = PostgresStorage.connect(url);
	const reconnected = PostgresStorage.connect(url);
	try {
		await storage.initialize();
		const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() };
		const start = "2026-01-01T00:00:00.000Z";
		const session = await new AuthenticationService(reconnected).createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), start);
		const task = await new TaskService(reconnected, () => start).create(session.userId, randomUUID(), taskInput);
		const active = await new TaskService(reconnected, () => start).lifecycle(session.userId, task.taskId);
		assert.equal(active?.state, "active");
		const atExpiry = new Date(Date.parse(start) + RETENTION_DAYS * MS_PER_DAY).toISOString();
		const expired = await new TaskService(reconnected, () => atExpiry).lifecycle(session.userId, task.taskId);
		assert.equal(expired?.state, "expired");
		assert.equal(await new TaskService(reconnected, () => atExpiry).get(session.userId, task.taskId), null);
	} finally {
		await storage.close();
		await reconnected.close();
	}
});
