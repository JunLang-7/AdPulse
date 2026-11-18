import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
	AuthenticationService,
	HypothesisService,
	MarketEventService,
	NotificationQueue,
	NotificationSelectionService,
	NotificationService,
	SubscriptionService,
	TaskService,
	notificationInputsStillCurrentIn,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { eventInput, taskInput } from "./market-event-fixtures.ts";

async function setup() {
	const storage = new MemoryStorage();
	let clock = "2026-11-15T23:00:00.000Z";
	const now = () => clock;
	// 授权夹具：与 selection-helpers 相同的作用域，保证 canSendProactiveIn 通过。
	const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: "hypothesis-fixture" };
	const auth = new AuthenticationService(storage);
	const session = await auth.createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), "2026-11-16T00:00:00.000Z");
	const owner = session.userId;
	const tasks = new TaskService(storage, now, () => "task-1");
	const task = await tasks.create(owner, "task-create", taskInput);
	const subscriptions = new SubscriptionService(storage, now);
	await subscriptions.addTarget(owner, {
		expectedVersion: 0, kind: "task", refId: task.taskId, categories: ["hypothesis"], scope: "task_only",
	});
	await subscriptions.updateSettings(owner, { expectedVersion: 1, proactiveEnabled: true });
	const notifications = new NotificationService(storage, now);
	const destination = await notifications.verifyDestination(owner, identity);
	await notifications.grantConsent(owner, destination.id, 0);
	const service = new HypothesisService(storage, now);
	const created = await service.create(owner, "h-1", {
		taskId: task.taskId,
		statement: "目标人群对免费试用装的反应优于直接折扣",
		rationale: "任务说明将免费试用列为主卖点",
		origin: "manual",
	});
	return { storage, task, service, hypothesisId: created.hypothesis!.id, owner, setTime(value: string) { clock = value; } };
}

test("假设判定入队：确认挑战后进本人订阅筛选，同一判定不重复推送", async () => {
	const { storage, task, service, hypothesisId, owner, setTime } = await setup();
	const events = new MarketEventService(storage, () => "2026-11-16T00:00:00.000Z");
	const created = await events.create(owner, "e-1", eventInput());
	const subject = { kind: "market_event", eventId: created.version.eventId, version: created.version.version } as const;
	setTime("2026-11-16T00:00:00.000Z");
	const verdict = await service.verdict(owner, hypothesisId, "v-1", {
		subject, judgment: "challenges", explanation: "竞品同区间推出同类免费试用，削弱差异化判断",
	});
	assert.equal(verdict.hypothesis?.status, "challenged");

	const items = await new NotificationQueue(storage).pending(owner);
	assert.equal(items.length, 1);
	assert.equal(items[0]?.kind, "hypothesis_verdict");
	assert.equal(items[0]?.taskId, task.taskId);
	assert.equal(items[0]?.hypothesisRef?.verdictId, verdict.verdict?.id);
	assert.match(items[0]!.summary, /不执行广告操作/);

	const records = (await new NotificationSelectionService(storage).list(owner)).records;
	// 事件本身的筛选记录（category_excluded）与假设判定记录并存，互不混同。
	const hypothesisRecord = records.find((record) => record.input === "hypothesis");
	assert.equal(hypothesisRecord?.outcome, "queued");
	assert.equal(records.find((record) => record.input === "event")?.outcome, "not_queued");

	// 重复确认（幂等重放）不重复入队。
	await service.confirmVerdict(owner, verdict.verdict!.id);
	assert.equal((await new NotificationQueue(storage).pending(owner)).length, 1);
	// 同主体再次判定是冲突：不可能产生第二条判定条目。
	await assert.rejects(
		service.verdict(owner, hypothesisId, "v-2", { subject, judgment: "supports", explanation: "另一条依据" }),
	);
});

test("假设判定入队：模拟事件来源只变更状态，不推送", async () => {
	const { storage, service, hypothesisId, owner, setTime } = await setup();
	const events = new MarketEventService(storage, () => "2026-11-16T00:00:00.000Z");
	const simulated = eventInput();
	simulated.provenance = { simulated: true, reference: "fixture", transformation: "合成" };
	const created = await events.create(owner, "e-sim", simulated);
	setTime("2026-11-16T00:00:00.000Z");
	const verdict = await service.verdict(owner, hypothesisId, "v-1", {
		subject: { kind: "market_event", eventId: created.version.eventId, version: created.version.version },
		judgment: "challenges",
		explanation: "合成事件同样指向挑战",
	});
	assert.equal(verdict.hypothesis?.status, "challenged");
	assert.deepEqual(await new NotificationQueue(storage).pending(owner), []);
	const record = (await new NotificationSelectionService(storage).list(owner)).records[0];
	assert.equal(record?.reason, "simulated_input");
	assert.equal(record?.outcome, "not_queued");
});

test("假设判定入队：类别与判定路由正确；unclear 不入队", async () => {
	const { storage, service, hypothesisId, owner, setTime } = await setup();
	const events = new MarketEventService(storage, () => "2026-11-16T00:00:00.000Z");
	const created = await events.create(owner, "e-1", eventInput());
	setTime("2026-11-16T00:00:00.000Z");
	// unclear 不改变状态，也不入队。
	const unclear = await service.verdict(owner, hypothesisId, "v-0", {
		subject: { kind: "market_event", eventId: created.version.eventId, version: created.version.version },
		judgment: "unclear", explanation: "不足以判断",
	});
	assert.equal(unclear.hypothesis?.status, "open");
	assert.deepEqual(await new NotificationQueue(storage).pending(owner), []);
	assert.equal((await new NotificationSelectionService(storage).list(owner)).records.filter((record) => record.input === "hypothesis").length, 0);
});

test("发送前复检：假设修订到新版本后取消旧待发", async () => {
	const { storage, service, hypothesisId, owner, setTime } = await setup();
	const events = new MarketEventService(storage, () => "2026-11-16T00:00:00.000Z");
	const created = await events.create(owner, "e-1", eventInput());
	setTime("2026-11-16T00:00:00.000Z");
	const verdict = await service.verdict(owner, hypothesisId, "v-1", {
		subject: { kind: "market_event", eventId: created.version.eventId, version: created.version.version },
		judgment: "challenges", explanation: "竞品同类免费试用削弱差异化",
	});
	const items = await new NotificationQueue(storage).pending(owner);
	assert.equal(items.length, 1);
	const item = items[0]!;
	const checked = await storage.transaction(async (tx) => notificationInputsStillCurrentIn(tx, item, new Date("2026-11-16T00:00:00.000Z")));
	assert.equal(checked, true);
	// 假设修订 → 旧待发不再当前。
	await service.revise(owner, hypothesisId, "h-2", 1, { statement: "目标人群对免费试用装的反应优于直接折扣（修订）", rationale: "同前" });
	const stale = await storage.transaction(async (tx) => notificationInputsStillCurrentIn(tx, item, new Date("2026-11-16T00:00:00.000Z")));
	assert.equal(stale, false);
	// 判定不存在时同样不当前。
	const missing = await storage.transaction(async (tx) => notificationInputsStillCurrentIn(tx, { ...item, hypothesisRef: { ...item.hypothesisRef!, verdictId: "missing" } }, new Date("2026-11-16T00:00:00.000Z")));
	assert.equal(missing, false);
	assert.equal(verdict.status, "verdict_recorded");
});
