import assert from "node:assert/strict";
import test from "node:test";
import {
	LifecycleCleanupService,
	TaskLifecycleService,
	TaskService,
	Worker,
} from "../packages/core/dist/index.js";
import type {
	ComparisonResult,
	InvestigationAlert,
	Job,
	Session,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";
import { fixture } from "./helpers.ts";

const DAY = 86_400_000;
const strategy = {
	objective: "获取咨询",
	audience: ["山东企业"],
	channels: { ads: {} },
	sellingPoints: [],
};
const taskInput = (endsAt?: string) => ({
	product: "产品 A",
	strategy,
	observation: { scope: "山东地区", ...(endsAt ? { endsAt } : {}) },
	rules: { minimumSpendMinor: 0 },
});

function setup() {
	let clock = "2026-01-01T00:00:00.000Z";
	const storage = new MemoryStorage();
	let next = 0;
	const tasks = new TaskService(storage, () => clock);
	const lifecycle = new TaskLifecycleService(storage, () => clock, () => `audit-${++next}`);
	const cleanup = new LifecycleCleanupService(storage, () => clock, () => `audit-${++next}`);
	return {
		storage,
		tasks,
		lifecycle,
		cleanup,
		now: () => clock,
		setNow: (value: string) => {
			clock = value;
		},
	};
}

const session = (ownerId: string, taskId: string): Session => ({
	id: "session-1",
	ownerId,
	taskRef: { taskId, taskVersion: 1 },
	deliveryMode: "channel",
	recipient: { accountId: "account-a", kind: "user", externalId: "ou-owner" },
	allowedActorIds: [ownerId],
	strategy,
	limits: { maxBudgetChangeRatio: 1, maxBidChangeRatio: 1 },
	signal: { id: "signal-1", title: "信号", summary: "摘要", evidence: [] },
	version: 1,
	roundNo: 1,
	status: "awaiting_input",
	createdAt: "2026-01-01T00:00:00.000Z",
});

async function seedGraph(
	f: ReturnType<typeof setup>,
	taskId: string,
): Promise<void> {
	await f.storage.transaction(async (tx) => {
		await tx.evidenceHeads.put({
			id: "evidence-1",
			ownerId: "owner",
			taskId,
			taskVersion: 1,
			currentVersion: 1,
			createdAt: "2026-01-02T00:00:00.000Z",
		});
		await tx.evidenceVersions.put({
			id: "evidence-1:1",
			evidenceId: "evidence-1",
			ownerId: "owner",
			taskId,
			taskVersion: 1,
			version: 1,
			businessKey: "key",
			contentDigest: "digest",
			scope: { planRef: "plan", campaignRefs: [] },
			period: {
				startsAt: "2026-01-01T00:00:00.000Z",
				endsAt: "2026-01-02T00:00:00.000Z",
				timeZone: "Asia/Shanghai",
				completeness: "complete",
			},
			metricsContract: {
				spendMinor: { definition: "d", formula: "f", sourceField: "s" },
				consultations: { definition: "d", formula: "f", sourceField: "s" },
			},
			currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
			attribution: { model: "platform" },
			callbackStatus: "complete",
			values: { spendMinor: 1000, consultations: 5 },
			createdAt: "2026-01-02T00:00:00.000Z",
		});
		await tx.evidenceSources.put({
			id: "source-1",
			ownerId: "owner",
			evidenceId: "evidence-1",
			evidenceVersion: 1,
			source: { platform: "p", accountRef: "a", reportRef: "r" },
			rawValues: { spend: "10", consultations: "5" },
			digest: "digest",
			createdAt: "2026-01-02T00:00:00.000Z",
		});
		const comparison: ComparisonResult = {
			id: "comparison-1",
			ownerId: "owner",
			taskId,
			current: { evidenceId: "evidence-1", version: 1, taskId, taskVersion: 1 },
			rulesRef: { taskId, version: 1 },
			evaluatorVersion: 1,
			status: "temporarily_uncomputable",
			canComparePeriods: false,
			canEvaluateCurrentThreshold: false,
			comparisons: {},
			thresholdEvaluation: { status: "not_evaluated" },
			reasons: [],
			followUpIds: [],
			createdAt: "2026-01-02T00:00:00.000Z",
		};
		await tx.comparisonResults.put(comparison);
		const alert: InvestigationAlert = {
			id: "alert-1",
			ownerId: "owner",
			taskId,
			logicalKey: "initial_candidate_missing",
			sessionId: "session-1",
			status: "open",
			current: {
				comparisonResultId: comparison.id,
				evidence: { evidenceId: "evidence-1", version: 1, taskId, taskVersion: 1 },
				source: { platform: "p", accountRef: "a" },
				scope: { planRef: "plan", campaignRefs: [] },
				period: {
					startsAt: "2026-01-01T00:00:00.000Z",
					endsAt: "2026-01-02T00:00:00.000Z",
					timeZone: "Asia/Shanghai",
					completeness: "complete",
				},
				metric: "cost_per_consultation",
				metricDefinition: "d",
				metricFormula: "f",
				currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
				comparisonStatus: "temporarily_uncomputable",
				canComparePeriods: false,
				limitations: [],
			},
			comparisonResultIds: [comparison.id],
			maxPushRounds: 1,
			logicalRounds: 0,
			events: [],
			createdAt: "2026-01-02T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		};
		await tx.investigationAlerts.put(alert);
		await tx.sessions.put(session("owner", taskId));
		await tx.rounds.put({
			id: "round-1",
			sessionId: "session-1",
			roundNo: 1,
			strategyVersion: 1,
			status: "open",
			card: { title: "t", summary: "s", evidence: [], options: [] },
			candidates: [],
		});
		await tx.actions.put({ id: "action-1", roundId: "round-1", optionId: "observe" });
		await tx.snapshots.put({
			id: "snapshot-1",
			sessionId: "session-1",
			version: 0,
			strategy,
			changes: [],
			createdAt: "2026-01-02T00:00:00.000Z",
		});
		await tx.inbox.put({
			id: "inbox-1",
			command: {
				sourceId: "account-a",
				eventId: "event-1",
				actionRef: "action-1",
				actor: { kind: "console", userId: "owner" },
			},
			status: "pending",
			receivedAt: "2026-01-02T00:00:00.000Z",
		});
		await tx.deliveries.put({
			id: "delivery-1",
			sessionId: "session-1",
			roundId: "round-1",
			recipient: { accountId: "account-a", kind: "user", externalId: "ou-owner" },
			card: { title: "t", summary: "s", evidence: [], options: [] },
			actions: [],
			purpose: "decision",
			expiresAt: "2026-12-31T00:00:00.000Z",
			status: "pending",
		});
		const jobs: Job[] = [
			{ id: "job-send", task: { kind: "send_delivery", deliveryId: "delivery-1" }, status: "pending", runAt: "2026-01-02T00:00:00.000Z", attempts: 0 },
			{ id: "job-inbox", task: { kind: "process_inbox", inboxId: "inbox-1" }, status: "pending", runAt: "2026-01-02T00:00:00.000Z", attempts: 0 },
			{ id: "job-round", task: { kind: "prepare_round", sessionId: "session-1", version: 1 }, status: "pending", runAt: "2026-01-02T00:00:00.000Z", attempts: 0 },
			{ id: "job-alert", task: { kind: "prepare_investigation_alert_session", alertId: "alert-1" }, status: "pending", runAt: "2026-01-02T00:00:00.000Z", attempts: 0 },
		];
		for (const job of jobs) await tx.jobs.put(job);
		await tx.notificationBatches.put({
			id: "batch-1",
			ownerId: "owner",
			kind: "digest",
			localDate: "2026-01-02",
			settingsVersion: 1,
			status: "queued",
			scheduledAt: "2026-01-02T01:30:00.000Z",
			createdAt: "2026-01-02T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		});
		await tx.notificationItems.put({
			id: "item-1",
			ownerId: "owner",
			batchId: "batch-1",
			logicalKey: "effect:task",
			kind: "effect_alert",
			taskId,
			title: "成本上升",
			summary: "近 3 天咨询成本上升 35%。",
			relevance: "与你关注的任务相关。",
			sources: [{ label: "投放后台" }],
			revision: 1,
			status: "queued",
			createdAt: "2026-01-02T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		});
		await tx.notificationSelections.put({
			id: "selection-1",
			ownerId: "owner",
			input: "effect",
			alertId: "alert-1",
			taskId,
			revision: 1,
			settingsVersion: 1,
			matchedTargetIds: [],
			outcome: "queued",
			reason: "matched",
			evaluatedAt: "2026-01-02T00:00:00.000Z",
		});
		await tx.subscriptionTargets.put({
			id: "target-1",
			userId: "owner",
			kind: "task",
			refId: taskId,
			label: "产品 A",
			categories: ["effect"],
			scope: "task_only",
			status: "active",
			createdAt: "2026-01-02T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		});
	});
}

test("清理按归属图删除业务资料，保留不可访问 head 与清理时间", async () => {
	const f = setup();
	const created = await f.tasks.create("owner", "create-key", taskInput());
	await seedGraph(f, created.taskId);

	f.setNow("2026-02-01T00:00:00.000Z");
	await f.lifecycle.requestDeletion("owner", created.taskId);
	// 7 天窗口内不清理。
	assert.equal(await f.cleanup.purgeTask(created.taskId), null);

	f.setNow(new Date(Date.parse("2026-02-01T00:00:00.000Z") + 7 * DAY).toISOString());
	const result = await f.cleanup.purgeTask(created.taskId);
	assert.ok(result);
	assert.equal(result.reason, "user_request");
	assert.deepEqual(result.counts, {
		taskVersions: 1,
		evidenceHeads: 1,
		evidenceVersions: 1,
		evidenceSources: 1,
		evidenceOperations: 0,
		comparisonResults: 1,
		comparisonFollowUps: 0,
		comparisonOperations: 0,
		investigationAlerts: 1,
		sessions: 1,
		rounds: 1,
		actions: 1,
		snapshots: 1,
		inbox: 1,
		deliveries: 1,
		jobs: 4,
		notificationItems: 1,
		notificationSelections: 1,
		subscriptionTargets: 1,
	});
	assert.equal(result.total, 19);

	const state = await f.storage.transaction(async (tx) => ({
		task: await tx.tasks.get(created.taskId),
		versions: (await tx.taskVersions.all()).length,
		evidence: (await tx.evidenceHeads.all()).length,
		alerts: (await tx.investigationAlerts.all()).length,
		sessions: (await tx.sessions.all()).length,
		items: (await tx.notificationItems.all()).length,
		targets: (await tx.subscriptionTargets.all()).length,
		jobs: (await tx.jobs.all()).map((job) => job.id),
		audits: await tx.auditEvents.all(),
	}));
	assert.equal(state.task?.lifecycle?.deletion?.state, "cleaned");
	assert.equal(state.task?.lifecycle?.deletion?.cleanedAt, "2026-02-08T00:00:00.000Z");
	assert.equal(state.versions, 0);
	assert.equal(state.evidence, 0);
	assert.equal(state.alerts, 0);
	assert.equal(state.sessions, 0);
	assert.equal(state.items, 0);
	assert.equal(state.targets, 0);
	assert.deepEqual(state.jobs, []);
	// 任务仍不可访问，且 head 不再持有业务内容（product 只在版本里）。
	assert.equal(await f.tasks.get("owner", created.taskId), null);
	const cleaned = state.audits.find((row) => row.action === "task.deletion.cleaned");
	assert.ok(cleaned);
	assert.equal(cleaned.count, result.total);
	assert.ok(!JSON.stringify(state.audits).includes("成本上升"));

	// 重跑幂等：已 cleaned 不再删除、不再写审计。
	const auditsBefore = state.audits.length;
	assert.equal(await f.cleanup.purgeTask(created.taskId), null);
	const auditsAfter = await f.storage.transaction((tx) => tx.auditEvents.all());
	assert.equal(auditsAfter.length, auditsBefore);
});

test("保留期到期由系统清理，标注 retention_expired", async () => {
	const f = setup();
	const created = await f.tasks.create(
		"owner",
		"create-key",
		taskInput("2026-01-15T00:00:00.000Z"),
	);
	// 恰好到达 365 天末尾即视为到期；差 1 毫秒不清理。
	f.setNow(new Date(Date.parse("2026-01-15T00:00:00.000Z") + 365 * DAY - 1).toISOString());
	assert.equal(await f.cleanup.purgeTask(created.taskId), null);
	f.setNow(new Date(Date.parse("2026-01-15T00:00:00.000Z") + 365 * DAY).toISOString());
	const result = await f.cleanup.purgeTask(created.taskId);
	assert.ok(result, "到期日应可清理");
	assert.equal(result.reason, "retention_expired");
	const task = await f.storage.transaction((tx) => tx.tasks.get(created.taskId));
	assert.equal(task?.lifecycle?.deletion?.state, "cleaned");
	assert.equal(task?.lifecycle?.deletion?.reason, "retention_expired");
	const audits = await f.storage.transaction((tx) => tx.auditEvents.all());
	assert.ok(audits.some((row) => row.action === "task.retention.purged"));
});

test("调度只排到期任务，任务与审计各一次", async () => {
	const f = setup();
	const deleted = await f.tasks.create("owner", "create-key", taskInput());
	const active = await f.tasks.create("owner", "other-key", taskInput("2099-01-01T00:00:00.000Z"));
	f.setNow("2026-02-01T00:00:00.000Z");
	await f.lifecycle.requestDeletion("owner", deleted.taskId);

	const before = await f.cleanup.tick();
	assert.deepEqual(before, { tasks: 0, audit: true });

	f.setNow("2026-03-01T00:00:00.000Z");
	const due = await f.cleanup.tick();
	assert.equal(due.tasks, 1);
	const jobs = await f.storage.transaction((tx) => tx.jobs.all());
	assert.deepEqual(
		jobs.filter((job) => job.task.kind === "purge_task").map((job) => job.id),
		[`purge_task:${deleted.taskId}`],
	);
	assert.ok(jobs.some((job) => job.task.kind === "purge_audit"));
	assert.equal(
		jobs.filter((job) => job.task.kind === "purge_task").some(
			(job) => job.task.kind === "purge_task" && job.task.taskId === active.taskId,
		),
		false,
	);
	// 同日重复调度不重复排队；审计任务按 UTC 日唯一。
	await f.cleanup.tick();
	const again = await f.storage.transaction((tx) => tx.jobs.all());
	assert.equal(
		again.filter(
			(job) =>
				job.task.kind === "purge_audit" &&
				job.id === "purge_audit:2026-03-01",
		).length,
		1,
	);
	assert.equal(
		again.filter((job) => job.task.kind === "purge_task").length,
		1,
	);
});

test("审计清理保留 180 天边界，并记录清理条数", async () => {
	const f = setup();
	const cutoff = "2026-07-01T00:00:00.000Z";
	f.setNow("2026-12-28T00:00:00.000Z");
	await f.storage.transaction(async (tx) => {
		for (const [id, at] of [
			["audit-old", "2026-06-30T23:59:59.999Z"],
			["audit-edge", "2026-07-01T00:00:00.000Z"],
			["audit-new", "2026-12-01T00:00:00.000Z"],
		] as const)
			await tx.auditEvents.put({
				id,
				actorId: "owner",
				action: "task.deletion.requested",
				objectKind: "task",
				objectId: "task-1",
				at,
				outcome: "accepted",
			});
	});
	assert.equal(await f.cleanup.purgeAudit(cutoff), 1);
	const remaining = await f.storage.transaction((tx) => tx.auditEvents.all());
	assert.deepEqual(
		remaining
			.filter((row) => row.action !== "audit.purged")
			.map((row) => row.id)
			.sort(),
		["audit-edge", "audit-new"],
	);
	assert.ok(remaining.some((row) => row.action === "audit.purged" && row.count === 1));
});

test("worker 执行到期清理任务，未到期时不清理", async () => {
	const f = fixture();
	let clock = "2026-01-01T00:00:00.000Z";
	const tasks = new TaskService(f.storage, () => clock);
	const lifecycle = new TaskLifecycleService(f.storage, () => clock);
	const cleanup = new LifecycleCleanupService(f.storage, () => clock);
	const created = await tasks.create("owner", "create-key", taskInput());
	await lifecycle.requestDeletion("owner", created.taskId);
	const worker = new Worker(
		f.storage,
		f.decisions,
		new Map(),
		() => clock,
		5,
		undefined,
		undefined,
		undefined,
		30_000,
		undefined,
		cleanup,
	);
	const enqueue = (id: string) =>
		f.storage.transaction(async (tx) => {
			await tx.jobs.put({
				id,
				task: { kind: "purge_task", taskId: created.taskId },
				status: "pending",
				runAt: clock,
				attempts: 0,
			});
		});

	await enqueue("purge-1");
	assert.equal(await worker.runOnce(), true);
	let task = await f.storage.transaction((tx) => tx.tasks.get(created.taskId));
	assert.equal(task?.lifecycle?.deletion?.state, "restricted", "7 天窗口内不清理");

	clock = "2026-01-08T00:00:00.000Z";
	await enqueue("purge-2");
	assert.equal(await worker.runOnce(), true);
	task = await f.storage.transaction((tx) => tx.tasks.get(created.taskId));
	assert.equal(task?.lifecycle?.deletion?.state, "cleaned");
	assert.equal(task?.lifecycle?.deletion?.cleanedAt, clock);
	const jobs = await f.storage.transaction((tx) => tx.jobs.all());
	assert.equal(jobs.find((job) => job.id === "purge-2")?.status, "done");
});
