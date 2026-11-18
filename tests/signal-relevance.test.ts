import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
	AuthenticationService,
	DiscoveryLeadService,
	NotificationQueue,
	NotificationSelectionService,
	NotificationService,
	SignalAssessmentError,
	SignalAssessmentService,
	SubscriptionService,
	TaskService,
	Worker,
	notificationInputsStillCurrentIn,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { createSignalAssessmentJobHandler, parseSignalSuggestion } from "../packages/runtime/dist/index.js";
import { taskInput } from "./market-event-fixtures.ts";

async function setup() {
	const storage = new MemoryStorage();
	let clock = "2026-11-15T00:00:00.000Z";
	const now = () => clock;
	const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() };
	const auth = new AuthenticationService(storage);
	const session = await auth.createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), now());
	const owner = session.userId;
	const tasks = new TaskService(storage, now, () => "task-1");
	const task = await tasks.create(owner, "task-create", taskInput);
	const leads = new DiscoveryLeadService(storage);
	const service = new SignalAssessmentService(storage, now);
	const subscriptions = new SubscriptionService(storage, now);
	await subscriptions.addTarget(owner, { expectedVersion: 0, kind: "task", refId: task.taskId, categories: ["effect"], scope: "task_only" });
	await subscriptions.updateSettings(owner, { expectedVersion: 1, proactiveEnabled: true });
	const notifications = new NotificationService(storage, now);
	const destination = await notifications.verifyDestination(owner, identity);
	await notifications.grantConsent(owner, destination.id, 0);
	return {
		storage, owner, task, leads, service, now,
		setTime(value: string) { clock = value; },
		async lead(title = "竞品发布同类免费试用，面向装修人群") {
			const result = await leads.persist(owner, {
				sourceKey: "xiaohongshu", topic: "免费试用", provider: "agent-reach/xiaohongshu",
				query: "装修 免费试用", subject: { kind: "competitor", name: "测试品牌" },
				candidates: [{ title, url: `https://www.xiaohongshu.com/explore/${randomUUID()}`, indexedPublishedAt: null }],
			}, now());
			assert.equal(result.created, 1);
			const known = (await storage.transaction(async (tx) => (await tx.discoveryLeads.listByOwner(owner))))
				.find((item) => item.title === title);
			return known!;
		},
	};
}

const preliminaryInput = (ownerId: string, leadId: string, taskId: string, overrides = {}) => ({
	ownerId, leadId, taskId,
	importance: "high" as const,
	relation: "direct" as const,
	explanation: "标题中的免费试用与我方主卖点直接重叠",
	quote: "免费试用",
	preliminary: { modelRef: "deepseek/deepseek-chat", generatedAt: "2026-11-15T00:00:00.000Z" },
	...overrides,
});

test("信号初判：persist 为活跃任务排 job；初判去重、确认后进通知", async () => {
	const f = await setup();
	const lead = await f.lead();
	const jobs = await f.storage.transaction(async (tx) => (await tx.jobs.all()).filter((job) => job.task.kind === "prepare_signal_assessments"));
	assert.equal(jobs.length, 1);
	assert.deepEqual(jobs[0]?.task, { kind: "prepare_signal_assessments", leadId: lead.id });

	f.setTime("2026-11-16T00:00:00.000Z");
	const recorded = await f.service.recordPreliminary(preliminaryInput(f.owner, lead.id, f.task.taskId));
	assert.equal(recorded.outcome, "recorded");
	assert.equal(recorded.assessment.stage, "preliminary");
	const duplicate = await f.service.recordPreliminary(preliminaryInput(f.owner, lead.id, f.task.taskId));
	assert.equal(duplicate.outcome, "duplicate");
	assert.equal(duplicate.assessment.id, recorded.assessment.id);
	assert.deepEqual(await f.service.pending(f.owner), [recorded.assessment]);

	const confirmed = await f.service.confirm(f.owner, recorded.assessment.id);
	assert.equal(confirmed.stage, "confirmed");
	assert.deepEqual(await f.service.pending(f.owner), []);
	const items = await new NotificationQueue(f.storage).pending(f.owner);
	assert.equal(items.length, 1);
	assert.equal(items[0]?.kind, "signal_relevance");
	assert.equal(items[0]?.signalRef?.assessmentId, recorded.assessment.id);
	assert.match(items[0]!.summary, /不执行广告操作/);
	const records = await new NotificationSelectionService(f.storage).list(f.owner);
	assert.equal(records.records.find((item) => item.input === "signal")?.outcome, "queued");
	// 重复确认幂等，不重复推送。
	await f.service.confirm(f.owner, recorded.assessment.id);
	assert.equal((await new NotificationQueue(f.storage).pending(f.owner)).length, 1);
});

test("信号初判：驳回终态、low/unclear 不推送、越权 404", async () => {
	const f = await setup();
	const lead = await f.lead();
	f.setTime("2026-11-16T00:00:00.000Z");
	const low = await f.service.recordPreliminary(preliminaryInput(f.owner, lead.id, f.task.taskId, {
		importance: "low", relation: "unclear", explanation: "标题与方案没有明确关系", quote: undefined,
	}));
	const confirmed = await f.service.confirm(f.owner, low.assessment.id);
	assert.equal(confirmed.stage, "confirmed");
	assert.deepEqual(await new NotificationQueue(f.storage).pending(f.owner), []);
	await assert.rejects(f.service.confirm("other", low.assessment.id), (error: unknown) => error instanceof SignalAssessmentError && error.status === 404);
	await assert.rejects(f.service.listForLead("other", lead.id), (error: unknown) => error instanceof SignalAssessmentError && error.status === 404);

	const second = await f.lead("另一个完全不同的标题");
	const recorded = await f.service.recordPreliminary(preliminaryInput(f.owner, second.id, f.task.taskId));
	const rejected = await f.service.reject(f.owner, recorded.assessment.id);
	assert.equal(rejected.stage, "rejected");
	await assert.rejects(f.service.confirm(f.owner, rejected.id), (error: unknown) => error instanceof SignalAssessmentError && error.status === 409);
	// 驳回后同一线索可新建初判（同线索再次被处理/新证据版本）。
	const retry = await f.service.recordPreliminary(preliminaryInput(f.owner, second.id, f.task.taskId, { explanation: "补充后的新说明" }));
	assert.equal(retry.outcome, "recorded");
});

test("信号初判：发送前复检，任务修订后旧待发失效", async () => {
	const f = await setup();
	const lead = await f.lead();
	f.setTime("2026-11-16T00:00:00.000Z");
	const recorded = await f.service.recordPreliminary(preliminaryInput(f.owner, lead.id, f.task.taskId));
	await f.service.confirm(f.owner, recorded.assessment.id);
	const item = (await new NotificationQueue(f.storage).pending(f.owner))[0]!;
	assert.equal(await f.storage.transaction(async (tx) => notificationInputsStillCurrentIn(tx, item, new Date(f.now()))), true);
	await f.storage.transaction(async (tx) => {
		const task = await tx.tasks.get(f.task.taskId);
		if (task) await tx.tasks.put({ ...task, currentVersion: 2 });
	});
	assert.equal(await f.storage.transaction(async (tx) => notificationInputsStillCurrentIn(tx, item, new Date(f.now()))), false);
});

test("信号初判：模型解析严格、job 处理器只写初判、worker 分发", async () => {
	const valid = parseSignalSuggestion(JSON.stringify({
		importance: "high", relation: "direct", explanation: "标题中的免费试用与主卖点一致", quote: "免费试用",
	}), "竞品发布免费试用");
	assert.deepEqual(valid, { importance: "high", relation: "direct", explanation: "标题中的免费试用与主卖点一致", quote: "免费试用" });
	// quote 不在标题中：丢弃，不冒充摘录。
	const forged = parseSignalSuggestion(JSON.stringify({
		importance: "high", relation: "direct", explanation: "x", quote: "不存在的引用",
	}), "普通标题");
	assert.equal(forged?.quote, undefined);
	assert.equal(parseSignalSuggestion("不是 JSON", "标题"), null);
	assert.equal(parseSignalSuggestion(JSON.stringify({ importance: "maybe", relation: "direct", explanation: "x" }), "标题"), null);

	const f = await setup();
	const lead = await f.lead();
	const handler = createSignalAssessmentJobHandler(
		f.storage,
		async (_ownerId, systemPrompt, brief) => {
			assert.match(systemPrompt, /unclear/);
			assert.match(brief, /线索标题/);
			return JSON.stringify({ importance: "medium", relation: "indirect", explanation: "同区间推出相似活动", quote: "免费试用" });
		},
		() => "deepseek/deepseek-chat",
		f.now,
	);
	await handler.prepare(lead.id);
	assert.equal((await f.service.listForLead(f.owner, lead.id)).length, 1);
	// 无模型时跳过，不编造。
	const noModel = createSignalAssessmentJobHandler(f.storage, async () => null, () => null, f.now);
	const other = await f.lead("全新线索");
	await noModel.prepare(other.id);
	assert.equal((await f.service.listForLead(f.owner, other.id)).length, 0);

	// worker 分发到注入的处理器。
	const prepared: string[] = [];
	const worker = new Worker(f.storage, {} as never, new Map(), f.now, 0, undefined, undefined, undefined, 30_000, undefined, undefined, 3_600_000, undefined, undefined, {
		prepare: async (leadId) => { prepared.push(leadId); },
	});
	await worker.runOnce();
	assert.equal(prepared.length, 1);
});
