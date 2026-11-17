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

test("在线清理：保留期到期（365 天）的任务也会被排入清单并物理清理", async () => {
	const f = await fixture();
	const { LifecycleCleanupService } = await import("../packages/core/dist/index.js");
	const expiresAt = (await f.lifecycle()).expiresAt;
	const cleanup = new LifecycleCleanupService(f.storage, f.clock);

	// 到期前：不排清单、不清数据。
	f.setTime(new Date(Date.parse(expiresAt) - 60_000).toISOString());
	const before = await cleanup.runOnce();
	assert.equal(before.scheduled, 0);
	assert.ok(await f.storage.transaction((tx) => tx.tasks.get(f.task.taskId)));

	// 到期时刻：自动排入 retention_expired 清单并当轮清理。
	f.setTime(expiresAt);
	const result = await cleanup.runOnce();
	assert.equal(result.scheduled, 1, "到期任务被排入清理清单");
	assert.equal(result.manifests, 1, "同一轮即可清理（deadlineAt 已到）");
	assert.equal(await f.storage.transaction((tx) => tx.tasks.get(f.task.taskId)), null);
	const manifest = (await f.storage.transaction((tx) => tx.lifecycleDeletions.all()))[0]!;
	assert.equal(manifest.reason, "retention_expired");
	assert.equal(manifest.status, "cleaned");

	// 再跑一次不重复排、不重复清。
	const again = await cleanup.runOnce();
	assert.equal(again.scheduled, 0);
	assert.equal(again.manifests, 0);
});

test("最小审计：写入动作与对象引用，180 天后独立清理且不留业务原文", async () => {
	const f = await fixture();
	const { LifecycleCleanupService } = await import("../packages/core/dist/index.js");
	const manifest = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	const audit = () => f.storage.transaction((tx) => tx.auditEvents.all());

	const afterDelete = await audit();
	assert.equal(afterDelete.length, 1);
	assert.equal(afterDelete[0]?.kind, "task_deleted");
	assert.equal(afterDelete[0]?.objectId, f.task.taskId);
	assert.equal(afterDelete[0]?.detail, "owner_request");
	assert.ok(!JSON.stringify(afterDelete).includes("生命周期任务"), "审计不含业务原文");

	const cleanup = new LifecycleCleanupService(f.storage, f.clock);
	f.setTime(manifest.deadlineAt);
	await cleanup.runOnce();
	const afterPurge = await audit();
	assert.ok(afterPurge.some((row) => row.kind === "task_purged"), "清理完成写审计");

	// 180 天边界：按每条审计自身时刻计算，差 1 毫秒保留、到点清理。
	// `task_deleted` 发生在 deadline-7 天，`task_purged` 发生在 deadline。
	const boundary = (offsetDays: number, ms = 0) =>
		new Date(Date.parse(manifest.deadlineAt) + offsetDays * MS_PER_DAY + ms).toISOString();
	f.setTime(boundary(180, -1));
	const firstPurge = await cleanup.runOnce();
	assert.equal(firstPurge.auditPurged, 1, "只清理已满 180 天的删除审计");
	assert.ok((await audit()).some((row) => row.kind === "task_purged"), "未满 180 天的清理审计保留");
	f.setTime(boundary(180));
	assert.equal((await cleanup.runOnce()).auditPurged, 0, "恰好等于 180 天边界时保留");
	f.setTime(boundary(180, 1));
	assert.equal((await cleanup.runOnce()).auditPurged, 1, "越过边界后清理");
	const remaining = await audit();
	assert.ok(!remaining.some((row) => row.kind === "task_purged"), "业务审计已清理");
	assert.ok(remaining.every((row) => row.kind === "audit_purged"), "只留下审计清理自身的记录");
});

test("PostgreSQL：listByOwner 与 ownerId 索引支撑清理，且审计表可查", { skip: !process.env.TEST_DATABASE_URL }, async () => {
	const url = process.env.TEST_DATABASE_URL!;
	const { createRequire } = await import("node:module");
	const { Pool } = createRequire(new URL("../packages/storage/package.json", import.meta.url))("pg") as {
		Pool: new (options: { connectionString: string; options?: string }) => ConstructorParameters<typeof PostgresStorage>[0];
	};
	const admin = new Pool({ connectionString: url }) as unknown as { query(sql: string): Promise<{ rows: Array<{ indexname?: string }> }>; end(): Promise<void> };
	const schema = `lifecycle_owner_${randomUUID().replaceAll("-", "")}`;
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
		await tasks.create(session.userId, randomUUID(), taskInput);
		const mine = await storage.transaction((tx) => tx.tasks.listByOwner(session.userId));
		assert.equal(mine.length, 2, "按归属检索只返回本人任务");
		assert.deepEqual(await storage.transaction((tx) => tx.tasks.listByOwner("someone-else")), []);
		await tasks.delete(session.userId, task.taskId);
		const audits = await storage.transaction((tx) => tx.auditEvents.listByOwner("system"));
		assert.equal(audits.length, 0, "系统审计的 actorId 不是本人，按 ownerId 检索不会串到用户表");
		const indexes = await admin.query(
			`SELECT indexname FROM pg_indexes WHERE schemaname = '${schema}' AND indexname IN ('adpulse_tasks_owner','adpulse_audit_at','adpulse_notification_items_owner') ORDER BY indexname`,
		) as unknown as { rows: Array<{ indexname: string }> };
		assert.ok(indexes.rows.length >= 2, "ownerId 与审计索引已建立");
	} finally {
		await storage.close();
		await admin.query(`DROP SCHEMA ${schema} CASCADE`);
		await admin.end();
	}
});

test("清理不再遗漏：冻结卡片摘除已删任务条目（保留同批次其他内容）", async () => {
	const shared = new MemoryStorage();
	const f = await fixture("2026-01-01T00:00:00.000Z", shared);
	// 同一张已发送汇总卡里同时有「本任务」和「另一任务」的冻结条目。
	const delivery = {
		id: "digest:batch-1", recipient: { accountId: "acc", kind: "user" as const, externalId: "ou" },
		ownerId: f.owner, purpose: "digest" as const, status: "sent" as const, actions: [], createdAt: "2026-01-01T00:00:00.000Z",
		card: {
			title: "信息汇总", items: [
				{ title: "本任务的标题", summary: "本任务摘要", relevance: "与本任务相关", sources: [{ label: "来源 A" }] },
				{ title: "其他任务的标题", summary: "其他任务摘要", relevance: "与其他任务相关", sources: [{ label: "来源 B" }] },
			],
		},
	};
	await f.storage.transaction(async (tx) => {
		await tx.deliveries.put(delivery as never);
		// 冻结卡片没有 detailUrl 时按标题回退匹配：这里补一条同标题的条目。
		await tx.notificationItems.put({
			id: `${f.owner}:effect:demo`, ownerId: f.owner, batchId: "digest:batch-1", logicalKey: "effect:demo",
			kind: "effect_alert", taskId: f.task.taskId, title: "本任务的标题", summary: "摘要", relevance: "相关",
			sources: [{ label: "来源 A" }], revision: 1, status: "queued",
			createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		} as never);
	});
	const manifest = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	const { LifecycleCleanupService } = await import("../packages/core/dist/index.js");
	f.setTime(manifest.deadlineAt);
	const result = await new LifecycleCleanupService(f.storage, f.clock).runOnce();
	assert.equal(result.removed.deliveryCards, 1, "冻结卡片被处理");
	const after = (await f.storage.transaction((tx) => tx.deliveries.get("digest:batch-1")))!;
	const items = (after.card as { items: Array<{ title: string }> }).items;
	assert.deepEqual(items.map((item) => item.title), ["其他任务的标题"], "只摘除已删任务的条目");
});

test("清理不再遗漏：没有 ownerId 的决策卡投递与其 send_delivery 任务也会被清", async () => {
	const f = await fixture();
	// 复刻 Orchestrator.queueDelivery 的形状：只带 sessionId/roundId，不写 ownerId。
	const session = {
		id: "session-1", ownerId: f.owner, taskRef: { taskId: f.task.taskId, taskVersion: 1 },
		allowedActorIds: [], strategy: {}, limits: {}, signal: {}, version: 0, roundNo: 0,
		status: "awaiting_input" as const, createdAt: "2026-01-01T00:00:00.000Z",
	};
	const round = { id: "round-1", sessionId: "session-1", roundNo: 0, strategyVersion: 1, status: "open" as const, card: { title: "t" }, candidates: [] };
	const delivery = {
		id: "delivery-1", sessionId: "session-1", roundId: "round-1", purpose: "decision" as const,
		status: "pending" as const, recipient: { accountId: "acc", kind: "user" as const, externalId: "ou" },
		card: { title: "待确认事项", summary: "业务正文", actions: [] }, actions: [], createdAt: "2026-01-01T00:00:00.000Z",
	};
	const job = { id: "job-1", task: { kind: "send_delivery" as const, deliveryId: "delivery-1" }, status: "pending" as const, runAt: "2026-01-01T00:00:00.000Z", attempts: 0 };
	await f.storage.transaction(async (tx) => {
		await tx.sessions.put(session as never);
		await tx.rounds.put(round as never);
		await tx.deliveries.put(delivery as never);
		await tx.jobs.put(job as never);
	});
	const manifest = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	const { LifecycleCleanupService } = await import("../packages/core/dist/index.js");
	f.setTime(manifest.deadlineAt);
	const result = await new LifecycleCleanupService(f.storage, f.clock).runOnce();
	assert.ok((result.removed.deliveries ?? 0) >= 1, "决策卡投递被清理");
	assert.ok((result.removed.jobs ?? 0) >= 1, "对应的 send_delivery 任务被清理");
	assert.equal(await f.storage.transaction((tx) => tx.deliveries.get("delivery-1")), null);
	assert.equal(await f.storage.transaction((tx) => tx.jobs.get("job-1")), null);
});

test("清理隔离：单份清单失败不阻塞其他用户，也不跳过审计清理", async () => {
	const shared = new MemoryStorage();
	const f = await fixture("2026-01-01T00:00:00.000Z", shared);
	const other = await fixture("2026-01-01T00:00:00.000Z", shared);
	const first = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	const second = (await other.tasks.delete(other.owner, other.task.taskId)).manifest;

	// 注入：清理「first」那份清单时在 tasks.remove 上失败。
	let failing = true;
	const failingStorage = {
		transaction: (work: (tx: unknown) => Promise<unknown>) =>
			shared.transaction(async (tx) => {
				const wrapped = new Proxy(tx, {
					get(target, table) {
						const value = target[table as keyof typeof target];
						if (failing && table === "tasks")
							return { ...value, remove: async (ids: string[]) => {
								if (ids.includes(f.task.taskId)) throw new Error("injected tasks.remove failure");
								return (value as { remove(ids: string[]): Promise<number> }).remove(ids);
							} };
						return value;
					},
				});
				return work(wrapped);
			}),
		runExclusive: shared.runExclusive.bind(shared),
		claimJob: shared.claimJob.bind(shared),
	} as unknown as typeof shared;
	const { LifecycleCleanupService } = await import("../packages/core/dist/index.js");
	f.setTime(first.deadlineAt);
	await other.storage.transaction((tx) => tx.lifecycleDeletions.put({ ...second, deadlineAt: first.deadlineAt }));
	const result = await new LifecycleCleanupService(failingStorage as never, f.clock).runOnce();
	assert.ok(result.failed.length >= 1, "失败清单被记录而不是抛出");
	assert.equal(
		(await shared.transaction((tx) => tx.lifecycleDeletions.get(second.id)))?.status,
		"cleaned",
		"另一用户的清单仍然被清理",
	);
	assert.equal(
		(await shared.transaction((tx) => tx.lifecycleDeletions.get(first.id)))?.status,
		"pending",
		"失败那份保持 pending",
	);
	failing = false;
	const retried = await new LifecycleCleanupService(shared, f.clock).runOnce();
	assert.equal(retried.manifests, 1, "下一轮重试可完成");
	assert.equal((await shared.transaction((tx) => tx.lifecycleDeletions.get(first.id)))?.status, "cleaned");
});

test("清理调度不依赖队列空闲：持续有任务可领时仍按间隔执行", async () => {
	const { Worker, LifecycleCleanupService } = await import("../packages/core/dist/index.js");
	const f = await fixture();
	const manifest = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	// 队列里始终有可领取的任务：用 claimJob 打桩返回一个 job，验证清理仍执行。
	let claims = 0;
	const busy = {
		transaction: f.storage.transaction.bind(f.storage),
		runExclusive: f.storage.runExclusive.bind(f.storage),
		claimJob: async () => {
			claims += 1;
			return { id: `job-${claims}`, task: { kind: "send_digest" as const, batchId: "none" }, status: "pending" as const, runAt: f.clock(), attempts: 0 };
		},
	} as unknown as typeof f.storage;
	let cleanups = 0;
	const cleanup = {
		runOnce: async () => { cleanups += 1; return { manifests: 0, removed: {}, scheduled: 0, auditPurged: 0, failed: [] }; },
	};
	const worker = new Worker(busy, {} as never, new Map(), f.clock, 0, undefined, undefined, undefined, 0, undefined, cleanup as never, 60_000);
	f.setTime(manifest.deadlineAt);
	await worker.runOnce();
	assert.equal(claims, 1, "先领任务（有活干）");
	assert.equal(cleanups, 1, "有任务可领时清理仍然执行");
	// 同一间隔内不重复触发。
	await worker.runOnce();
	assert.equal(cleanups, 1);
});

test("PostgreSQL：清理会摘除冻结卡片里的已删任务条目", { skip: !process.env.TEST_DATABASE_URL }, async () => {
	const url = process.env.TEST_DATABASE_URL!;
	const { createRequire } = await import("node:module");
	const { Pool } = createRequire(new URL("../packages/storage/package.json", import.meta.url))("pg") as {
		Pool: new (options: { connectionString: string; options?: string }) => ConstructorParameters<typeof PostgresStorage>[0];
	};
	const admin = new Pool({ connectionString: url }) as unknown as { query(sql: string): Promise<unknown>; end(): Promise<void> };
	const schema = `lifecycle_card_${randomUUID().replaceAll("-", "")}`;
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
		await storage.transaction(async (tx) => {
			await tx.notificationItems.put({
				id: `${session.userId}:effect:x`, ownerId: session.userId, batchId: "digest:b", logicalKey: "effect:x",
				kind: "effect_alert", taskId: task.taskId, title: "本任务标题", summary: "s", relevance: "r",
				sources: [{ label: "l" }], revision: 1, status: "queued", createdAt: start, updatedAt: start,
			});
			await tx.deliveries.put({
				id: "digest:b", ownerId: session.userId, purpose: "digest", status: "sent", actions: [],
				expiresAt: "2027-01-01T00:00:00.000Z",
				recipient: { accountId: "a", kind: "user", externalId: "ou" },
				card: { title: "汇总", items: [
					{ title: "本任务标题", summary: "s", relevance: "r", sources: [{ label: "l" }] },
					{ title: "他任务标题", summary: "s2", relevance: "r2", sources: [{ label: "l2" }] },
				] },
			});
		});
		const manifest = (await tasks.delete(session.userId, task.taskId)).manifest;
		const { LifecycleCleanupService: Cleanup } = await import("../packages/core/dist/index.js");
		await new Cleanup(storage, () => manifest.deadlineAt).runOnce();
		const card = (await storage.transaction((tx) => tx.deliveries.get("digest:b")))!.card as { items: Array<{ title: string }> };
		assert.deepEqual(card.items.map((item) => item.title), ["他任务标题"], "只摘除已删任务条目");
	} finally {
		await storage.close();
		await admin.query(`DROP SCHEMA ${schema} CASCADE`);
		await admin.end();
	}
});

test("删除清单外置：序列化/解析逐行往返，坏行直接报错而不静默跳过", async () => {
	const { serializeManifest, parseManifest, replayPlan } = await import("../packages/core/dist/index.js");
	const f = await fixture();
	const manifest = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	const text = serializeManifest([manifest]);
	assert.equal(text.trim().split("\n").length, 1);
	const [parsed] = parseManifest(text);
	assert.ok(parsed);
	assert.equal(parsed.taskId, f.task.taskId);
	assert.equal(parsed.reason, "owner_request");
	assert.equal(parsed.status, "pending");

	assert.throws(() => parseManifest(`${text}\nnot-json\n`), /invalid JSON/, "坏行必须中止，不能当成没删除");
	assert.throws(() => parseManifest('{"id":"x"}\n'), /invalid entry/);

	// 同一任务多条记录时以最早请求为准；已过 deadline 的立即到期。
	const later = { ...parsed!, id: "other-id", requestedAt: "2026-02-01T00:00:00.000Z", deadlineAt: "2026-02-08T00:00:00.000Z" };
	const plan = replayPlan([later, parsed!], new Date("2026-01-03T00:00:00.000Z"));
	assert.equal(plan.applicable.length, 1, "同一任务只保留一条");
	assert.equal(plan.applicable[0]?.requestedAt, manifest.requestedAt, "取最早请求");
	assert.equal(plan.dueNow.length, 0, "未到 7 天不立即清理");
	assert.equal(replayPlan([parsed!], new Date(manifest.deadlineAt)).dueNow.length, 1);
});

test("备份恢复重放：清单写回后已删任务立即限访，重复重放不覆盖既有记录", async () => {
	const { LifecycleDeletionService } = await import("../packages/core/dist/index.js");
	const f = await fixture();
	const manifest = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	// 模拟「恢复到一份更早的备份」：任务还在、但清单没了。
	await f.storage.transaction(async (tx) => {
		const task = await tx.tasks.get(f.task.taskId);
		if (task) await tx.tasks.put({ id: task.id, ownerId: task.ownerId, currentVersion: task.currentVersion, createdAt: task.createdAt });
		await tx.lifecycleDeletions.delete(manifest.id);
	});
	assert.ok(await f.storage.transaction((tx) => tx.tasks.get(f.task.taskId)), "恢复出的旧任务确实存在");

	const service = new LifecycleDeletionService(f.storage, f.clock);
	const { serializeManifest, parseManifest } = await import("../packages/core/dist/index.js");
	const entries = parseManifest(serializeManifest([manifest]));
	const first = await service.replay(entries);
	assert.equal(first.inserted, 1);
	assert.equal(first.kept, 0);
	assert.equal(await f.tasks.get(f.owner, f.task.taskId), null, "重放后立即不可访问");

	const again = await service.replay(entries);
	assert.equal(again.inserted, 0);
	assert.equal(again.kept, 1, "已有清单不覆盖");
});

test("备份淘汰：30 天软目标 + 删除满 37 天后早于请求的备份必须消失", async () => {
	const { LifecycleBackupService } = await import("../packages/core/dist/index.js");
	const f = await fixture();
	const manifest = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	const names = new Set<string>();
	const store = {
		list: async () => [...names].map((name) => ({ name, createdAt: name.replace(/^b-/, "").replace(/\.dump$/, "") })),
		remove: async (name: string) => { names.delete(name); },
	};
	const put = (iso: string) => names.add(`b-${iso}.dump`);
	const days = (base: string, offset: number) => new Date(Date.parse(base) + offset * MS_PER_DAY).toISOString();
	// 备份早于删除请求（可能含已删数据）与删除之后的备份各一份。
	const beforeRequest = days(manifest.requestedAt, -5);
	const afterRequest = days(manifest.requestedAt, 1);
	put(beforeRequest); put(afterRequest);

	// 未满 30 天、也未满 37 天：都不删。
	let result = await new LifecycleBackupService(store, f.storage, () => days(manifest.requestedAt, 2)).evictOnce();
	assert.deepEqual(result.removed, []);
	assert.equal(result.forDeletions, 0);
	assert.equal(names.size, 2);

	// 满 30 天：只删老备份，删除之后的备份保留（软目标，失败不抛）。
	const agedAt = days(beforeRequest, 31);
	result = await new LifecycleBackupService(store, f.storage, () => agedAt).evictOnce();
	assert.deepEqual(result.removed, [`b-${beforeRequest}.dump`]);
	assert.equal(names.size, 1);

	// 删除请求满 37 天：早于请求的备份必须消失；晚于请求的保留。
	put(beforeRequest);
	const deadline37 = days(manifest.requestedAt, 37);
	result = await new LifecycleBackupService(store, f.storage, () => deadline37).evictOnce();
	assert.ok(result.forDeletions >= 1, "命中删除淘汰规则");
	assert.ok(result.removed.includes(`b-${beforeRequest}.dump`));
	// 30 天保留期对所有备份生效：36 天前的「请求之后」备份同样因超龄被删，与删除规则无关。
	assert.ok(result.removed.includes(`b-${afterRequest}.dump`));
	assert.equal(result.forDeletions, 1, "只有覆盖删除请求的备份计入删除规则");
	assert.deepEqual(result.violations, [], "软目标成功时没有残留");
	const audits = await f.storage.transaction((tx) => tx.auditEvents.all());
	assert.ok(audits.some((row) => row.kind === "backup_evicted"));

	// 软目标：删除失败只记录并进 violations，不抛错、不阻断后续。
	put(beforeRequest);
	const failingStore = { list: store.list, remove: async () => { throw new Error("bucket unavailable"); } };
	const soft = await new LifecycleBackupService(failingStore, f.storage, () => deadline37).evictOnce();
	assert.equal(soft.removed.length, 0);
	assert.ok(soft.failed.length >= 1, "失败被记录而非抛出");
	assert.ok(soft.violations.includes(`b-${beforeRequest}.dump`), "残留可被后续核对");
});

test("PostgreSQL：清理会摘除冻结卡片里的已删任务条目", { skip: !process.env.TEST_DATABASE_URL }, async () => {
	const url = process.env.TEST_DATABASE_URL!;
	const { createRequire } = await import("node:module");
	const { Pool } = createRequire(new URL("../packages/storage/package.json", import.meta.url))("pg") as {
		Pool: new (options: { connectionString: string; options?: string }) => ConstructorParameters<typeof PostgresStorage>[0];
	};
	const admin = new Pool({ connectionString: url }) as unknown as { query(sql: string): Promise<unknown>; end(): Promise<void> };
	const schema = `lifecycle_card_${randomUUID().replaceAll("-", "")}`;
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
		await storage.transaction(async (tx) => {
			await tx.notificationItems.put({
				id: `${session.userId}:effect:x`, ownerId: session.userId, batchId: "digest:b", logicalKey: "effect:x",
				kind: "effect_alert", taskId: task.taskId, title: "本任务标题", summary: "s", relevance: "r",
				sources: [{ label: "l" }], revision: 1, status: "queued", createdAt: start, updatedAt: start,
			});
			await tx.deliveries.put({
				id: "digest:b", ownerId: session.userId, purpose: "digest", status: "sent", actions: [],
				expiresAt: "2027-01-01T00:00:00.000Z",
				recipient: { accountId: "a", kind: "user", externalId: "ou" },
				card: { title: "汇总", items: [
					{ title: "本任务标题", summary: "s", relevance: "r", sources: [{ label: "l" }] },
					{ title: "他任务标题", summary: "s2", relevance: "r2", sources: [{ label: "l2" }] },
				] },
			});
		});
		const manifest = (await tasks.delete(session.userId, task.taskId)).manifest;
		const { LifecycleCleanupService: Cleanup } = await import("../packages/core/dist/index.js");
		await new Cleanup(storage, () => manifest.deadlineAt).runOnce();
		const card = (await storage.transaction((tx) => tx.deliveries.get("digest:b")))!.card as { items: Array<{ title: string }> };
		assert.deepEqual(card.items.map((item) => item.title), ["他任务标题"], "只摘除已删任务条目");
	} finally {
		await storage.close();
		await admin.query(`DROP SCHEMA ${schema} CASCADE`);
		await admin.end();
	}
});

test("删除清单外置：序列化/解析逐行往返，坏行直接报错而不静默跳过", async () => {
	const { serializeManifest, parseManifest, replayPlan } = await import("../packages/core/dist/index.js");
	const f = await fixture();
	const manifest = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	const text = serializeManifest([manifest]);
	assert.equal(text.trim().split("\n").length, 1);
	const [parsed] = parseManifest(text);
	assert.ok(parsed);
	assert.equal(parsed.taskId, f.task.taskId);
	assert.equal(parsed.reason, "owner_request");
	assert.equal(parsed.status, "pending");

	assert.throws(() => parseManifest(`${text}\nnot-json\n`), /invalid JSON/, "坏行必须中止，不能当成没删除");
	assert.throws(() => parseManifest('{"id":"x"}\n'), /invalid entry/);

	// 同一任务多条记录时以最早请求为准；已过 deadline 的立即到期。
	const later = { ...parsed!, id: "other-id", requestedAt: "2026-02-01T00:00:00.000Z", deadlineAt: "2026-02-08T00:00:00.000Z" };
	const plan = replayPlan([later, parsed!], new Date("2026-01-03T00:00:00.000Z"));
	assert.equal(plan.applicable.length, 1, "同一任务只保留一条");
	assert.equal(plan.applicable[0]?.requestedAt, manifest.requestedAt, "取最早请求");
	assert.equal(plan.dueNow.length, 0, "未到 7 天不立即清理");
	assert.equal(replayPlan([parsed!], new Date(manifest.deadlineAt)).dueNow.length, 1);
});

test("备份恢复重放：清单写回后已删任务立即限访，重复重放不覆盖既有记录", async () => {
	const { LifecycleDeletionService } = await import("../packages/core/dist/index.js");
	const f = await fixture();
	const manifest = (await f.tasks.delete(f.owner, f.task.taskId)).manifest;
	// 模拟「恢复到一份更早的备份」：任务还在、但清单没了。
	await f.storage.transaction(async (tx) => {
		const task = await tx.tasks.get(f.task.taskId);
		if (task) await tx.tasks.put({ id: task.id, ownerId: task.ownerId, currentVersion: task.currentVersion, createdAt: task.createdAt });
		await tx.lifecycleDeletions.delete(manifest.id);
	});
	assert.ok(await f.storage.transaction((tx) => tx.tasks.get(f.task.taskId)), "恢复出的旧任务确实存在");

	const service = new LifecycleDeletionService(f.storage, f.clock);
	const { serializeManifest, parseManifest } = await import("../packages/core/dist/index.js");
	const entries = parseManifest(serializeManifest([manifest]));
	const first = await service.replay(entries);
	assert.equal(first.inserted, 1);
	assert.equal(first.kept, 0);
	assert.equal(await f.tasks.get(f.owner, f.task.taskId), null, "重放后立即不可访问");

	const again = await service.replay(entries);
	assert.equal(again.inserted, 0);
	assert.equal(again.kept, 1, "已有清单不覆盖");
});

test("恢复后会话失效：revokeAllSessions 撤销全部会话并作废未完成登录", async () => {
	const f = await fixture();
	const auth = new AuthenticationService(f.storage);
	const second = await auth.createWebSession(
		{ platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() },
		createHash("sha256").update(randomUUID()).digest("hex"),
		"2026-01-01T00:00:00.000Z",
	);
	assert.ok(second.userId);
	const revoked = await auth.revokeAllSessions("2026-01-02T00:00:00.000Z");
	assert.ok(revoked >= 1, "至少撤销了这个用户的会话");
	const sessions = await f.storage.transaction((tx) => tx.webSessions.all());
	assert.ok(sessions.every((row) => row.revokedAt), "全部会话都带撤销时刻");
	// 重复执行不重复计数。
	assert.equal(await auth.revokeAllSessions("2026-01-03T00:00:00.000Z"), 0);
	// 非法时刻不做任何事。
	assert.equal(await auth.revokeAllSessions("not-a-date"), 0);
});
