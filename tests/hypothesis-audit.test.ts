// 审核验收补充：覆盖假设偏差实现中此前未校验的领域不变量。
import assert from "node:assert/strict";
import test from "node:test";
import {
	AuthenticationService,
	HypothesisError,
	HypothesisPreliminaryWriter,
	HypothesisService,
	MarketEventService,
	NotificationQueue,
	NotificationService,
	SubscriptionService,
	TaskService,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { eventInput, taskInput } from "./market-event-fixtures.ts";
import { createHash, randomUUID } from "node:crypto";

async function setup(clockStart = "2026-11-15T23:00:00.000Z") {
	const storage = new MemoryStorage();
	let clock = clockStart;
	const now = () => clock;
	const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() };
	const auth = new AuthenticationService(storage);
	const session = await auth.createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), clockStart);
	const owner = session.userId;
	const tasks = new TaskService(storage, now, () => "task-1");
	const task = await tasks.create(owner, "task-create", taskInput);
	const subscriptions = new SubscriptionService(storage, now);
	return {
		storage, task, owner, now, identity,
		setTime(value: string) { clock = value; },
	};
}

test("初判写入必须校验任务生命周期：到期或已删除任务的假设不可写", async () => {
	const f = await setup();
	const service = new HypothesisService(f.storage, f.now);
	const created = await service.create(f.owner, "h-1", {
		taskId: f.task.taskId,
		statement: "目标人群对免费试用装的反应优于直接折扣",
		rationale: "任务说明将免费试用列为主卖点",
		origin: "manual",
	});
	const events = new MarketEventService(f.storage, f.now);
	const event = await events.create(f.owner, "e-1", eventInput());
	const writer = new HypothesisPreliminaryWriter(f.storage, f.now);

	// 正常路径：可写。
	const first = await writer.record({
		ownerId: f.owner, hypothesisId: created.hypothesis!.id,
		subject: { kind: "market_event", eventId: event.version.eventId, version: event.version.version },
		judgment: "challenges", explanation: "竞品同类免费试用削弱差异化",
		preliminary: { modelRef: "m", generatedAt: f.now() },
	});
	assert.equal(first.outcome, "recorded");

	// 任务删除后：假设不可写（与 list/detail/verdict 一致）。重新查一条新证据以绕过 dedup。
	await f.storage.transaction((tx) => tx.tasks.delete(f.task.taskId));
	await assert.rejects(
		writer.record({
			ownerId: f.owner, hypothesisId: created.hypothesis!.id,
			subject: { kind: "market_event", eventId: event.version.eventId, version: event.version.version },
			judgment: "supports", explanation: "另一条依据",
			preliminary: { modelRef: "m", generatedAt: f.now() },
		}),
		(e: unknown) => e instanceof HypothesisError && e.status === 404,
	);
});

test("确认初判拒绝已停用假设，不静默确认", async () => {
	const f = await setup();
	const service = new HypothesisService(f.storage, f.now);
	const writer = new HypothesisPreliminaryWriter(f.storage, f.now);
	const created = await service.create(f.owner, "h-1", {
		taskId: f.task.taskId, statement: "判断一", rationale: "依据一", origin: "manual",
	});
	const events = new MarketEventService(f.storage, f.now);
	const event = await events.create(f.owner, "e-1", eventInput());
	const pending = await writer.record({
		ownerId: f.owner, hypothesisId: created.hypothesis!.id,
		subject: { kind: "market_event", eventId: event.version.eventId, version: event.version.version },
		judgment: "challenges", explanation: "竞品同类免费试用削弱差异化",
		preliminary: { modelRef: "m", generatedAt: f.now() },
	});
	await service.retire(f.owner, created.hypothesis!.id, "h-2", 1);
	await assert.rejects(
		service.confirmVerdict(f.owner, pending.verdict.id),
		(e: unknown) => e instanceof HypothesisError && e.status === 409,
	);
});

test("驳回初判不写 confirmedAt（该字段只表示确认时刻）", async () => {
	const f = await setup();
	const service = new HypothesisService(f.storage, f.now);
	const writer = new HypothesisPreliminaryWriter(f.storage, f.now);
	const created = await service.create(f.owner, "h-1", {
		taskId: f.task.taskId, statement: "判断一", rationale: "依据一", origin: "manual",
	});
	const events = new MarketEventService(f.storage, f.now);
	const event = await events.create(f.owner, "e-1", eventInput());
	const pending = await writer.record({
		ownerId: f.owner, hypothesisId: created.hypothesis!.id,
		subject: { kind: "market_event", eventId: event.version.eventId, version: event.version.version },
		judgment: "supports", explanation: "依据说明",
		preliminary: { modelRef: "m", generatedAt: f.now() },
	});
	const rejected = await service.rejectVerdict(f.owner, pending.verdict.id);
	assert.equal(rejected.verdict.stage, "rejected");
	assert.equal(rejected.verdict.confirmedAt, undefined, "驳回不应写确认时刻");
});

test("确认时刻而非初判记录时刻决定是否推送：初判早于开启、确认晚于开启仍应入队", async () => {
	const f = await setup();
	const service = new HypothesisService(f.storage, f.now);
	const writer = new HypothesisPreliminaryWriter(f.storage, f.now);
	const created = await service.create(f.owner, "h-1", {
		taskId: f.task.taskId,
		statement: "目标人群对免费试用装的反应优于直接折扣",
		rationale: "任务说明将免费试用列为主卖点",
		origin: "manual",
	});
	const events = new MarketEventService(f.storage, f.now);
	const event = await events.create(f.owner, "e-1", eventInput());

	// 1) 先产生初判（此时推送未开启）。
	const pending = await writer.record({
		ownerId: f.owner, hypothesisId: created.hypothesis!.id,
		subject: { kind: "market_event", eventId: event.version.eventId, version: event.version.version },
		judgment: "challenges", explanation: "竞品同类免费试用削弱差异化",
		preliminary: { modelRef: "m", generatedAt: f.now() },
	});

	// 2) 之后订阅任务并开启推送（enabledAt 晚于初判记录）。
	const subscriptions = new SubscriptionService(f.storage, f.now);
	// 目的地校验要求身份已绑定：用同一身份再次建立会话（identity binding 复用到同一 user）。
	const auth = new AuthenticationService(f.storage);
	await auth.createWebSession(f.identity, createHash("sha256").update(randomUUID()).digest("hex"), f.now());
	const notifications = new NotificationService(f.storage, f.now);
	f.setTime("2026-11-16T00:05:00.000Z");
	await subscriptions.addTarget(f.owner, {
		expectedVersion: 0, kind: "task", refId: f.task.taskId, categories: ["hypothesis"], scope: "task_only",
	});
	await subscriptions.updateSettings(f.owner, { expectedVersion: 1, proactiveEnabled: true });
	const destination = await notifications.verifyDestination(f.owner, f.identity);
	await notifications.grantConsent(f.owner, destination.id, 0);

	// 3) 晚于开启时刻确认初判：应入队提醒。
	f.setTime("2026-11-16T00:10:00.000Z");
	await service.confirmVerdict(f.owner, pending.verdict.id);
	const items = await new NotificationQueue(f.storage).pending(f.owner);
	assert.equal(items.length, 1, "确认发生在推送开启之后，应产生提醒");
	assert.equal(items[0]?.kind, "hypothesis_verdict");
});
