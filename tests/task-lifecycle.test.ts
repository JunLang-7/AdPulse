import assert from "node:assert/strict";
import test from "node:test";
import {
	ComparisonService,
	EvidenceService,
	InvestigationAlertService,
	NotificationQueue,
	TaskLifecycleError,
	TaskLifecycleService,
	TaskService,
	notificationInputsStillCurrentIn,
} from "../packages/core/dist/index.js";
import type {
	ChoiceCommand,
	Inbox,
	Job,
	NotificationBatch,
	NotificationItem,
	Round,
	Session,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";
import { fixture } from "./helpers.ts";

const strategy = {
	objective: "获取咨询",
	audience: ["山东企业"],
	channels: { ads: {} },
	sellingPoints: [],
};

const taskInput = {
	product: "产品 A",
	strategy,
	observation: { scope: "山东地区" },
	rules: { minimumSpendMinor: 0 },
};

function setup() {
	const clock = { at: "2026-01-01T00:00:00.000Z" };
	const storage = new MemoryStorage();
	let audit = 0;
	const tasks = new TaskService(storage, () => clock.at);
	const lifecycle = new TaskLifecycleService(
		storage,
		() => clock.at,
		() => `audit-${++audit}`,
	);
	return {
		clock,
		storage,
		tasks,
		lifecycle,
		evidence: new EvidenceService(storage, () => clock.at),
		comparisons: new ComparisonService(storage, () => clock.at),
		alerts: new InvestigationAlertService(storage),
		queue: new NotificationQueue(storage, () => new Date(clock.at)),
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

const round: Round = {
	id: "round-1",
	sessionId: "session-1",
	roundNo: 1,
	strategyVersion: 1,
	status: "open",
	expiresAt: "2026-12-31T00:00:00.000Z",
	card: {
		title: "复核出价",
		summary: "仅调整方案草案",
		evidence: [],
		options: [{ id: "observe", label: "继续观察" }],
	},
	candidates: [],
};

const item = (taskId: string): NotificationItem => ({
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
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
});

const batch: NotificationBatch = {
	id: "batch-1",
	ownerId: "owner",
	kind: "digest",
	localDate: "2026-01-01",
	settingsVersion: 1,
	status: "queued",
	scheduledAt: "2026-01-01T01:30:00.000Z",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const command: ChoiceCommand = {
	sourceId: "account-a",
	eventId: "event-1",
	actionRef: "action-1",
	actor: { kind: "console", userId: "owner" },
};

test("确认删除立即限访并抑制关联待发", async () => {
	const f = setup();
	const created = await f.tasks.create("owner", "create-key", taskInput);
	const taskId = created.taskId;

	await f.storage.transaction(async (tx) => {
		await tx.sessions.put(session("owner", taskId));
		await tx.rounds.put(round);
		await tx.actions.put({ id: "action-1", roundId: round.id, optionId: "observe" });
		const inbox: Inbox = {
			id: "inbox-1",
			command,
			status: "pending",
			receivedAt: f.clock.at,
		};
		await tx.inbox.put(inbox);
		await tx.deliveries.put({
			id: "delivery-1",
			sessionId: "session-1",
			roundId: round.id,
			recipient: { accountId: "account-a", kind: "user", externalId: "ou-owner" },
			card: round.card,
			actions: [{ optionId: "observe", actionRef: "action-1" }],
			purpose: "decision",
			expiresAt: "2026-12-31T00:00:00.000Z",
			status: "pending",
		});
		await tx.notificationBatches.put(batch);
		await tx.notificationItems.put(item(taskId));
		const jobs: Job[] = [
			{ id: "job-1", task: { kind: "send_delivery", deliveryId: "delivery-1" }, status: "pending", runAt: f.clock.at, attempts: 0 },
			{ id: "job-2", task: { kind: "process_inbox", inboxId: "inbox-1" }, status: "pending", runAt: f.clock.at, attempts: 0 },
			{ id: "job-3", task: { kind: "prepare_round", sessionId: "session-1", version: 2 }, status: "pending", runAt: f.clock.at, attempts: 0 },
			{ id: "job-4", task: { kind: "send_digest", batchId: "batch-1" }, status: "pending", runAt: f.clock.at, attempts: 0 },
		];
		for (const job of jobs) await tx.jobs.put(job);
	});

	f.clock.at = "2026-02-01T00:00:00.000Z";
	const view = await f.lifecycle.requestDeletion("owner", taskId);
	assert.equal(view.newlyRequested, true);
	assert.equal(view.state, "restricted");
	assert.equal(view.requestedAt, "2026-02-01T00:00:00.000Z");
	assert.equal(view.cleanupDueAt, "2026-02-08T00:00:00.000Z");
	assert.deepEqual(view.suppressed, {
		items: 1,
		batches: 1,
		deliveries: 1,
		jobs: 4,
		sessions: 1,
		inboxes: 1,
	});

	// 立即不可访问：任务、证据、比较、告警、订阅对象一律按不存在处理。
	assert.equal(await f.tasks.get("owner", taskId), null);
	assert.equal(await f.tasks.getVersion("owner", taskId, 1), null);
	assert.deepEqual(await f.tasks.list("owner"), []);
	await assert.rejects(
		f.evidence.listForTask("owner", taskId),
		/task not found/,
	);
	await assert.rejects(
		f.comparisons.listResultsForTask("owner", taskId),
		/task not found/,
	);
	await assert.rejects(f.alerts.listForTask("owner", taskId), /task not found/);
	await assert.rejects(
		f.tasks.revise("owner", taskId, 1, "revise-key", taskInput),
		/task not found/,
	);

	await f.storage.transaction(async (tx) => {
		assert.equal((await tx.sessions.get("session-1"))?.status, "cancelled");
		const inbox = await tx.inbox.get("inbox-1");
		assert.equal(inbox?.status, "rejected");
		assert.equal(inbox?.reason, "task_deleted");
		assert.equal((await tx.deliveries.get("delivery-1"))?.status, "cancelled");
		assert.equal((await tx.notificationItems.get("item-1"))?.status, "cancelled");
		const cancelled = await tx.notificationBatches.get("batch-1");
		assert.equal(cancelled?.status, "cancelled");
		assert.equal(cancelled?.statusReason, "task_deleted");
		for (const id of ["job-1", "job-2", "job-3", "job-4"])
			assert.equal((await tx.jobs.get(id))?.status, "cancelled");
	});

	// 最小审计：只有标识与计数，不含业务原文/标题。
	const audits = await f.storage.transaction((tx) => tx.auditEvents.all());
	assert.equal(audits.length, 4);
	const requested = audits.find((a) => a.action === "task.deletion.requested");
	assert.ok(requested);
	assert.equal(requested.objectId, taskId);
	assert.equal(requested.actorId, "owner");
	assert.equal(requested.version, 1);
	assert.ok(!JSON.stringify(audits).includes("成本上升"));
	assert.ok(!JSON.stringify(audits).includes("近 3 天"));
});

test("重复确认幂等：保留首次时间且不写额外审计", async () => {
	const f = setup();
	const created = await f.tasks.create("owner", "create-key", taskInput);
	f.clock.at = "2026-02-01T00:00:00.000Z";
	const first = await f.lifecycle.requestDeletion("owner", created.taskId);
	f.clock.at = "2026-03-01T00:00:00.000Z";
	const second = await f.lifecycle.requestDeletion("owner", created.taskId);
	assert.equal(second.newlyRequested, false);
	assert.equal(second.requestedAt, first.requestedAt);
	assert.equal(second.cleanupDueAt, first.cleanupDueAt);
	const audits = await f.storage.transaction((tx) => tx.auditEvents.all());
	assert.equal(audits.length, 1);
});

test("他人任务按不存在处理，不泄露删除结果", async () => {
	const f = setup();
	const created = await f.tasks.create("owner", "create-key", taskInput);
	await assert.rejects(
		f.lifecycle.requestDeletion("stranger", created.taskId),
		(error) =>
			error instanceof TaskLifecycleError && error.code === "task_not_found",
	);
	assert.equal(await f.lifecycle.viewDeletion("stranger", created.taskId), null);
	assert.ok(await f.tasks.get("owner", created.taskId));
	assert.equal(await f.lifecycle.viewDeletion("owner", created.taskId), null);
});

test("已删除任务不再产生新待发，未删除时行为不变", async () => {
	const f = setup();
	const created = await f.tasks.create("owner", "create-key", taskInput);
	const queued = await f.queue.queue(
		"owner",
		{
			logicalKey: "effect:task",
			kind: "effect_alert",
			taskId: created.taskId,
			title: "成本上升",
			summary: "近 3 天咨询成本上升 35%。",
			relevance: "与你关注的任务相关。",
			sources: [{ label: "投放后台" }],
			revision: 1,
		},
		{ settingsVersion: 1, enabled: true },
	);
	assert.equal(queued.outcome, "queued");

	await f.lifecycle.requestDeletion("owner", created.taskId);
	assert.equal(
		(
			await f.queue.queue(
				"owner",
				{
					logicalKey: "effect:other",
					kind: "effect_alert",
					taskId: created.taskId,
					title: "新信号",
					summary: "摘要",
					relevance: "与你关注的任务相关。",
					sources: [{ label: "投放后台" }],
					revision: 1,
				},
				{ settingsVersion: 1, enabled: true },
			)
		).outcome,
		"cancelled",
	);
	await f.storage.transaction(async (tx) => {
		const existing = await tx.notificationItems.get(
			`${"owner"}:${"effect:task"}`,
		);
		assert.ok(existing);
		assert.equal(await notificationInputsStillCurrentIn(tx, existing), false);
	});
});

test("旧卡点击按业务拒绝处理，不当作系统故障", async () => {
	const f = fixture();
	const tasks = new TaskService(f.storage, f.now);
	const lifecycle = new TaskLifecycleService(f.storage, f.now);
	const created = await tasks.create("owner", "create-key", taskInput);
	await f.storage.transaction(async (tx) => {
		await tx.sessions.put(session("owner", created.taskId));
		await tx.rounds.put(round);
		await tx.actions.put({ id: "action-1", roundId: round.id, optionId: "observe" });
		await tx.inbox.put({
			id: "inbox-1",
			command,
			status: "pending",
			receivedAt: f.now(),
		});
	});
	await lifecycle.requestDeletion("owner", created.taskId);
	await f.decisions.processInbox("inbox-1");
	const inbox = await f.storage.transaction((tx) => tx.inbox.get("inbox-1"));
	assert.equal(inbox?.status, "rejected");
	assert.equal(inbox?.reason, "task_deleted");
});

test("worker 不因重试把已删除任务的卡片补发出去", async () => {
	const f = fixture();
	const tasks = new TaskService(f.storage, f.now);
	const lifecycle = new TaskLifecycleService(f.storage, f.now);
	const created = await tasks.create("owner", "create-key", taskInput);
	await f.storage.transaction(async (tx) => {
		await tx.sessions.put(session("owner", created.taskId));
		await tx.rounds.put(round);
		await tx.deliveries.put({
			id: "delivery-1",
			sessionId: "session-1",
			roundId: round.id,
			recipient: { accountId: "account-a", kind: "user", externalId: "ou-owner" },
			card: round.card,
			actions: [{ optionId: "observe", actionRef: "action-1" }],
			purpose: "decision",
			expiresAt: "2026-12-31T00:00:00.000Z",
			status: "pending",
		});
		await tx.jobs.put({
			id: "job-send",
			task: { kind: "send_delivery", deliveryId: "delivery-1" },
			status: "pending",
			runAt: f.now(),
			attempts: 0,
		});
	});
	await lifecycle.requestDeletion("owner", created.taskId);
	// 删除前的在途任务即使被重新领取，也必须以取消收场。
	await f.storage.transaction(async (tx) => {
		await tx.jobs.put({
			id: "job-send",
			task: { kind: "send_delivery", deliveryId: "delivery-1" },
			status: "pending",
			runAt: f.now(),
			attempts: 1,
		});
	});
	await f.worker.runOnce();
	assert.equal(f.sent.size, 0);
	const delivery = await f.storage.transaction((tx) =>
		tx.deliveries.get("delivery-1"),
	);
	assert.equal(delivery?.status, "cancelled");
});
