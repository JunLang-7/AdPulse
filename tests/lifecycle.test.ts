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

async function fixture(start = "2026-01-01T00:00:00.000Z", shared?: MemoryStorage) {
	let now = start;
	const clock = () => now;
	const storage = shared ?? new MemoryStorage();
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

test("删除确认：立即不可访问、抑制待发、写删除清单，重复提交幂等", async () => {
	const f = await fixture();
	// 造一条待发提醒与一条待发决策卡，验证删除会抑制它们。
	const { NotificationQueue } = await import("../packages/core/dist/index.js");
	const queued = await new NotificationQueue(f.storage, () => new Date(f.clock())).queue(f.owner, {
		logicalKey: "effect:demo", kind: "effect_alert", taskId: f.task.taskId,
		title: "待发提醒", summary: "删除前已入队", relevance: "与你关注的任务相关",
		sources: [{ label: "效果导入证据", publishedAt: null }], revision: 1,
	}, { settingsVersion: 1, enabled: true });
	assert.equal(queued.outcome, "queued");

	const result = await f.tasks.delete(f.owner, f.task.taskId);
	assert.equal(result.created, true);
	assert.equal(result.manifest.status, "pending");
	assert.equal(result.manifest.taskId, f.task.taskId);
	assert.equal(
		Date.parse(result.manifest.deadlineAt) - Date.parse(result.manifest.requestedAt),
		7 * MS_PER_DAY,
		"在线清理截止为请求起 7 天",
	);

	// 立即限访：任务、证据、比较、判定查询都不可用。
	assert.equal(await f.tasks.get(f.owner, f.task.taskId), null);
	assert.deepEqual(await f.tasks.list(f.owner), []);
	const lifecycle = await f.tasks.lifecycle(f.owner, f.task.taskId);
	assert.equal(lifecycle?.state, "deleted");
	assert.ok(lifecycle?.deletedAt);
	assert.equal(await f.tasks.lifecycle(f.owner, "missing-task"), null);

	// 待发被抑制，且不会因旧 revision 复活。
	const pending = await new NotificationQueue(f.storage).pending(f.owner);
	assert.equal(pending.length, 0, "删除后该任务的待发条目被取消");
	const items = await f.storage.transaction((tx) => tx.notificationItems.all());
	assert.equal(items.find((item) => item.taskId === f.task.taskId)?.status, "cancelled");

	// 幂等：重复提交返回同一清单，不新建。
	const again = await f.tasks.delete(f.owner, f.task.taskId);
	assert.equal(again.created, false);
	assert.equal(again.manifest.id, result.manifest.id);
	assert.equal((await f.storage.transaction((tx) => tx.lifecycleDeletions.all())).length, 1);

	// 别人不能删除，也看不到清单。
	const other = await fixture();
	await assert.rejects(other.tasks.delete(other.owner, f.task.taskId), /task not found/);
	const { LifecycleDeletionService } = await import("../packages/core/dist/index.js");
	assert.deepEqual(await new LifecycleDeletionService(other.storage, other.clock).list(other.owner), [],
		"跨用户不共享删除清单");
});

test("删除后可重建同名任务，但旧任务历史仍不可访问", async () => {
	const f = await fixture();
	const old = await f.tasks.delete(f.owner, f.task.taskId);
	const recreated = await f.tasks.create(f.owner, randomUUID(), taskInput);
	assert.notEqual(recreated.taskId, f.task.taskId, "新任务是新 id，不复用旧任务");
	assert.ok(await f.tasks.get(f.owner, recreated.taskId), "新任务可正常读取");
	assert.equal(await f.tasks.get(f.owner, f.task.taskId), null, "旧任务仍然不可访问");
	const oldLifecycle = await f.tasks.lifecycle(f.owner, f.task.taskId);
	assert.equal(oldLifecycle?.state, "deleted");
	assert.equal((await f.storage.transaction((tx) => tx.lifecycleDeletions.all()))
		.filter((row) => row.taskId === f.task.taskId).length, 1, "旧任务的删除清单保留");
	assert.equal(old.manifest.status, "pending");
});

test("PostgreSQL：删除清单与任务墓碑在同一事务落库", { skip: !process.env.TEST_DATABASE_URL }, async () => {
	const url = process.env.TEST_DATABASE_URL!;
	const { createRequire } = await import("node:module");
	const { Pool } = createRequire(new URL("../packages/storage/package.json", import.meta.url))("pg") as {
		Pool: new (options: { connectionString: string; options?: string }) => ConstructorParameters<typeof PostgresStorage>[0];
	};
	const admin = new Pool({ connectionString: url }) as unknown as { query(sql: string): Promise<unknown>; end(): Promise<void> };
	const schema = `lifecycle_delete_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE SCHEMA ${schema}`);
	const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
	const other = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
	const storage = new PostgresStorage(pool);
	const reconnected = new PostgresStorage(other);
	try {
		await storage.initialize();
		const start = "2026-01-01T00:00:00.000Z";
		const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() };
		const session = await new AuthenticationService(reconnected).createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), start);
		const tasks = new TaskService(reconnected, () => start);
		const task = await tasks.create(session.userId, randomUUID(), taskInput);
		const result = await tasks.delete(session.userId, task.taskId);
		assert.equal(result.created, true);
		assert.equal(await tasks.get(session.userId, task.taskId), null);
		const manifest = (await new (await import("../packages/core/dist/index.js")).LifecycleDeletionService(reconnected, () => start).list(session.userId))[0];
		assert.equal(manifest?.taskId, task.taskId);
		assert.equal(manifest?.status, "pending");
		await assert.rejects(
			reconnected.transaction(async (tx) => {
				const row = (await tx.lifecycleDeletions.all())[0]; assert.ok(row);
				await tx.lifecycleDeletions.put({ ...row, id: "another-id" });
			}),
			/duplicate key/,
			"同一任务不能出现两份删除清单",
		);
	} finally {
		await storage.close();
		await reconnected.close();
		await admin.query(`DROP SCHEMA ${schema} CASCADE`);
		await admin.end();
	}
});

test("限访不能被绕过：证据详情与修订、任务修订都不能让到期任务复活", async () => {
	const f = await fixture();
	const { EvidenceService } = await import("../packages/core/dist/index.js");
	const evidence = new EvidenceService(f.storage, f.clock);
	const imported = await evidence.import(f.owner, randomUUID(), {
		schemaVersion: 1, taskRef: { taskId: f.task.taskId, taskVersion: 1 }, records: [selectionEvidence()],
	});
	const evidenceId = imported[0]!.evidenceId;
	assert.ok(await evidence.get(f.owner, evidenceId), "未到期时详情可读");

	// 到期后：列表、详情、修订全部按不可访问处理。
	const expiresAt = (await f.lifecycle()).expiresAt;
	f.setTime(expiresAt);
	assert.deepEqual(await evidence.listForTask(f.owner, f.task.taskId).catch(() => []), []);
	assert.equal(await evidence.get(f.owner, evidenceId), null, "旧 evidenceId 也不能绕过限访");
	await assert.rejects(
		evidence.revise(f.owner, evidenceId, randomUUID(), {
			expectedEvidenceVersion: 1, reason: "到期后修订", record: selectionEvidence(2200),
		}),
		/evidence not found/,
	);
	await assert.rejects(
		f.tasks.revise(f.owner, f.task.taskId, 1, randomUUID(), taskInput),
		/task not found/,
		"到期任务不能通过修订推进最后业务更新",
	);
	assert.equal(await f.tasks.get(f.owner, f.task.taskId), null, "修订被拒后任务仍不可读");

	// 幂等重放：同一 key 再提交也不能返回业务正文。
	const key = randomUUID();
	f.setTime("2026-01-01T00:01:00.000Z");
	const revised = await f.tasks.revise(f.owner, f.task.taskId, 1, key, taskInput);
	assert.equal(revised.version, 2);
	const replayAt = (await f.lifecycle()).expiresAt;
	f.setTime(replayAt);
	await assert.rejects(
		f.tasks.revise(f.owner, f.task.taskId, 1, key, taskInput),
		/task not found/,
		"幂等重放也不得到期任务正文",
	);
});

test("删除确认后证据详情与修订同样不可用", async () => {
	const f = await fixture();
	const { EvidenceService } = await import("../packages/core/dist/index.js");
	const evidence = new EvidenceService(f.storage, f.clock);
	const imported = await evidence.import(f.owner, randomUUID(), {
		schemaVersion: 1, taskRef: { taskId: f.task.taskId, taskVersion: 1 }, records: [selectionEvidence()],
	});
	const evidenceId = imported[0]!.evidenceId;
	await f.tasks.delete(f.owner, f.task.taskId);
	assert.equal(await evidence.get(f.owner, evidenceId), null);
	await assert.rejects(
		evidence.revise(f.owner, evidenceId, randomUUID(), { expectedEvidenceVersion: 1, reason: "删除后修订", record: selectionEvidence(2300) }),
		/evidence not found/,
	);
	await assert.rejects(f.tasks.revise(f.owner, f.task.taskId, 1, randomUUID(), taskInput), /task not found/);
});

test("在线清理：到期前不动数据，到期后按清单删除任务全部关联并标记已清理", async () => {
	const f = await fixture();
	const { EvidenceService, ComparisonService, InvestigationAlertService, NotificationQueue, LifecycleCleanupService } =
		await import("../packages/core/dist/index.js");
	// 造一套完整关联：证据 → 比较 → 告警 → 通知条目。
	const evidence = new EvidenceService(f.storage, f.clock);
	const imported = await evidence.import(f.owner, randomUUID(), {
		schemaVersion: 1, taskRef: { taskId: f.task.taskId, taskVersion: 1 }, records: [selectionEvidence()],
	});
	const comparison = await new ComparisonService(f.storage, f.clock).evaluate(f.owner, randomUUID(), {
		current: { evidenceId: imported[0]!.evidenceId, version: 1 },
	});
	await new InvestigationAlertService(f.storage, f.clock).evaluateComparison(f.owner, comparison.id);
	const manifest = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	const cleanup = new LifecycleCleanupService(f.storage, f.clock);

	// 到期前（6 天 23 小时）不清理。
	f.setTime(new Date(Date.parse(manifest.requestedAt) + 7 * MS_PER_DAY - 60_000).toISOString());
	assert.equal((await cleanup.runOnce()).manifests, 0);
	assert.ok(await f.storage.transaction((tx) => tx.tasks.get(f.task.taskId)), "未到期时数据仍在库里");

	// 到期后清理。
	f.setTime(manifest.deadlineAt);
	const result = await cleanup.runOnce();
	assert.equal(result.manifests, 1);
	assert.ok((result.removed.tasks ?? 0) >= 1);
	assert.ok((result.removed.evidenceHeads ?? 0) >= 1);
	assert.ok((result.removed.evidenceVersions ?? 0) >= 1);
	assert.ok((result.removed.comparisonResults ?? 0) >= 1);
	assert.ok((result.removed.investigationAlerts ?? 0) >= 1);
	assert.ok((result.removed.notificationSelections ?? 0) >= 1);

	const remaining = await f.storage.transaction(async (tx) => ({
		tasks: (await tx.tasks.all()).filter((row) => row.id === f.task.taskId),
		versions: (await tx.taskVersions.all()).filter((row) => row.taskId === f.task.taskId),
		evidence: (await tx.evidenceHeads.all()).filter((row) => row.taskId === f.task.taskId),
		alerts: (await tx.investigationAlerts.all()).filter((row) => row.taskId === f.task.taskId),
		selections: (await tx.notificationSelections.all()).filter((row) => row.taskId === f.task.taskId),
	}));
	for (const [name, rows] of Object.entries(remaining)) assert.deepEqual(rows, [], `${name} 应被清理`);
	const cleaned = (await f.storage.transaction((tx) => tx.lifecycleDeletions.get(manifest.id)))!;
	assert.equal(cleaned.status, "cleaned");
	assert.ok(cleaned.cleanedAt);

	// 重放幂等：再跑一次不报错也不重复计。
	assert.equal((await cleanup.runOnce()).manifests, 0);
});

test("在线清理：中断后清单保持 pending，重试可继续；不影响其他用户", async () => {
	const { LifecycleCleanupService } = await import("../packages/core/dist/index.js");
	const shared = new MemoryStorage();
	const f = await fixture("2026-01-01T00:00:00.000Z", shared);
	// 同一存储里的第二个用户：验证清理只动本清单的任务、且互不阻塞。
	const other = await fixture("2026-01-01T00:00:00.000Z", shared);
	const manifest = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	const otherManifest = (await other.tasks.delete(other.owner, other.task.taskId)).manifest;

	// 注入失败：第一次清理在标记 cleaned 前抛错。
	let fail = true;
	const failing = {
		transaction: (work: Parameters<typeof f.storage.transaction>[0]) =>
			f.storage.transaction(async (tx) => {
				if (fail && (await tx.lifecycleDeletions.all()).some((row) => row.status === "pending"))
					throw new Error("injected cleanup failure");
				return work(tx);
			}),
		runExclusive: f.storage.runExclusive.bind(f.storage),
		claimJob: f.storage.claimJob.bind(f.storage),
	} as unknown as typeof f.storage;
	f.setTime(manifest.deadlineAt);
	await assert.rejects(new LifecycleCleanupService(failing, f.clock).runOnce(), /injected cleanup failure/);
	assert.equal((await f.storage.transaction((tx) => tx.lifecycleDeletions.get(manifest.id)))?.status, "pending");
	assert.ok(await f.storage.transaction((tx) => tx.tasks.get(f.task.taskId)), "失败时不删除，留待重试");

	fail = false;
	const retried = await new LifecycleCleanupService(f.storage, f.clock).runOnce();
	assert.equal(retried.manifests, 2, "两份到期清单都被清理（本人 + 另一用户）");
	assert.equal(await f.storage.transaction((tx) => tx.tasks.get(f.task.taskId)), null);
	assert.equal(await f.storage.transaction((tx) => tx.tasks.get(other.task.taskId)), null);
	assert.equal(
		(await f.storage.transaction((tx) => tx.lifecycleDeletions.get(otherManifest.id)))?.status,
		"cleaned",
		"其他用户的清单按自己的任务清理，不因别人失败被跳过",
	);
});

test("PostgreSQL：在线清理按清单删除全部关联并标记 cleaned", { skip: !process.env.TEST_DATABASE_URL }, async () => {
	const url = process.env.TEST_DATABASE_URL!;
	const { createRequire } = await import("node:module");
	const { Pool } = createRequire(new URL("../packages/storage/package.json", import.meta.url))("pg") as {
		Pool: new (options: { connectionString: string; options?: string }) => ConstructorParameters<typeof PostgresStorage>[0];
	};
	const admin = new Pool({ connectionString: url }) as unknown as { query(sql: string): Promise<unknown>; end(): Promise<void> };
	const schema = `lifecycle_cleanup_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE SCHEMA ${schema}`);
	const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
	const storage = new PostgresStorage(pool);
	try {
		await storage.initialize();
		const start = "2026-01-01T00:00:00.000Z";
		const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() };
		const session = await new AuthenticationService(storage).createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), start);
		const tasks = new TaskService(storage, () => start);
		const task = await tasks.create(session.userId, randomUUID(), taskInput);
		const { EvidenceService: Evidence, LifecycleCleanupService: Cleanup } = await import("../packages/core/dist/index.js");
		await new Evidence(storage, () => start).import(session.userId, randomUUID(), {
			schemaVersion: 1, taskRef: { taskId: task.taskId, taskVersion: 1 }, records: [selectionEvidence()],
		});
		const manifest = (await tasks.delete(session.userId, task.taskId)).manifest;
		const atDeadline = () => manifest.deadlineAt;
		const cleaned = await new Cleanup(storage, atDeadline).runOnce();
		assert.equal(cleaned.manifests, 1);
		assert.equal(await storage.transaction((tx) => tx.tasks.get(task.taskId)), null);
		assert.deepEqual(
			await storage.transaction(async (tx) => (await tx.evidenceHeads.all()).filter((row) => row.taskId === task.taskId)),
			[],
		);
		const row = await storage.transaction((tx) => tx.lifecycleDeletions.get(manifest.id));
		assert.equal(row?.status, "cleaned");
		assert.ok(row?.cleanedAt);
	} finally {
		await storage.close();
		await admin.query(`DROP SCHEMA ${schema} CASCADE`);
		await admin.end();
	}
});
