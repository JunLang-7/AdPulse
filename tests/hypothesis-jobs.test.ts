import assert from "node:assert/strict";
import test from "node:test";
import {
	HypothesisService,
	MarketEventService,
	TaskService,
	Worker,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { createHypothesisReasoning } from "../packages/runtime/dist/index.js";
import { createHypothesisVerdictJobHandler } from "../packages/runtime/dist/hypothesis-jobs.js";
import { eventInput, taskInput } from "./market-event-fixtures.ts";

const judgmentJson = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		judgment: "challenges",
		explanation: "事件中的免费试用条件与假设的价格敏感判断直接相关",
		quote: "测试品牌于2026-11-16发布新品，仅限试点地区。",
		...overrides,
	});

async function setup() {
	const storage = new MemoryStorage();
	const tasks = new TaskService(storage, () => "2026-01-01T00:00:00.000Z", () => "task-1");
	const task = await tasks.create("alice", "task-create", taskInput);
	const events = new MarketEventService(storage, () => "2026-01-01T00:00:00.000Z");
	const hypotheses = new HypothesisService(storage, () => "2026-01-01T00:00:00.000Z");
	const created = await hypotheses.create("alice", "h-1", {
		taskId: task.taskId,
		statement: "目标人群对免费试用装的反应优于直接折扣",
		rationale: "任务说明将免费试用列为主卖点",
		origin: "manual",
	});
	return { storage, task, events, hypotheses, hypothesisId: created.hypothesis!.id };
}

const eventWithTaskRef = (suffix = "") => {
	const input = eventInput();
	input.occurrenceKey = `release-2026-11${suffix}`;
	input.sources = [{ ...input.sources[0]!, url: `https://example.com/releases/1${suffix}` }];
	input.taskRefs = [{ taskId: "task-1", taskVersion: 1, reason: "人工关联" }];
	return input;
};

test("hypothesis reasoning: drafts and judgment parsing", async () => {
	const calls: string[] = [];
	const reasoning = createHypothesisReasoning(async (systemPrompt, brief) => {
		calls.push(systemPrompt.slice(0, 30));
		if (systemPrompt.includes("假设）草案")) {
			return JSON.stringify({ drafts: [
				{ statement: "装修人群更看重免费样品", rationale: "任务说明提到装修业主", testable: "支持：领取量上升", evidenceHint: "准备装修的新房业主" },
				{ statement: "x".repeat(201), rationale: "超长应被过滤" },
				{ statement: "缺少 rationale 的条目应被过滤" },
			] });
		}
		return judgmentJson();
	});
	const drafts = await reasoning.drafts({
		brief: "新品免费试用推广，面向准备装修的新房业主",
		strategy: { objective: "获取咨询", audience: ["装修业主"], sellingPoints: ["免费样品"], channels: ["小红书"] },
		eventTitles: [],
	});
	assert.equal(drafts?.length, 1);
	assert.equal(drafts[0]?.evidenceHint, "准备装修的新房业主");
	const judgment = await reasoning.judge({
		statement: "目标人群对免费试用装的反应优于直接折扣",
		evidenceTitle: "测试品牌新品发布",
		evidenceContent: "测试品牌于2026-11-16发布新品，仅限试点地区。",
		evidenceKind: "market_event",
	});
	assert.equal(judgment?.judgment, "challenges");
	assert.equal(judgment?.quote, "测试品牌于2026-11-16发布新品，仅限试点地区。");
	// 输出不可解析 → null。
	const broken = createHypothesisReasoning(async () => "不是 JSON");
	assert.equal(await broken.judge({ statement: "s", evidenceTitle: "t", evidenceContent: "c", evidenceKind: "comparison" }), null);
	// 非法 judgment → null。
	const invalid = createHypothesisReasoning(async () => JSON.stringify({ judgment: "maybe", explanation: "x" }));
	assert.equal(await invalid.judge({ statement: "s", evidenceTitle: "t", evidenceContent: "c", evidenceKind: "comparison" }), null);
});

test("hypothesis verdict jobs: event create enqueues for tasks with hypotheses; handler records preliminary", async () => {
	const { storage, events, hypotheses, hypothesisId } = await setup();
	const created = await events.create("alice", "e-1", eventWithTaskRef());
	assert.equal(created.status, "created");
	const jobIds = await storage.transaction(async (tx) => (await tx.jobs.all()).map((job) => job.id));
	assert.equal(jobIds.length, 1);
	// 同一事件再次创建（重复）不重复入队。
	await events.create("alice", "e-1", eventWithTaskRef());
	const jobIdsAgain = await storage.transaction(async (tx) => (await tx.jobs.all()).map((job) => job.id));
	assert.deepEqual(jobIdsAgain, jobIds);

	const calls: Array<{ ownerId: string; brief: string }> = [];
	const handler = createHypothesisVerdictJobHandler(
		storage,
		async (ownerId, _systemPrompt, brief) => {
			calls.push({ ownerId, brief });
			return judgmentJson();
		},
		() => "deepseek/deepseek-chat",
		() => "2026-01-01T00:00:00.000Z",
	);
	await handler.prepare({ kind: "market_event", eventId: created.version.eventId, version: created.version.version });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.ownerId, "alice");
	const pending = await hypotheses.pendingVerdicts("alice");
	assert.equal(pending.length, 1);
	assert.equal(pending[0]?.judgment, "challenges");
	assert.equal(pending[0]?.preliminary?.modelRef, "deepseek/deepseek-chat");
	// 重试幂等：同一初判不重复。
	await handler.prepare({ kind: "market_event", eventId: created.version.eventId, version: created.version.version });
	assert.equal((await hypotheses.pendingVerdicts("alice")).length, 1);
	// 确认后状态变更。
	const confirmed = await hypotheses.confirmVerdict("alice", pending[0]!.id);
	assert.equal(confirmed.hypothesis.status, "challenged");
});

test("hypothesis verdict jobs: no hypotheses or no model skip cleanly; unclear allowed", async () => {
	const { storage, events, hypotheses, hypothesisId } = await setup();
	// 无关联任务的事件不入队。
	await events.create("alice", "e-0", eventInput());
	let jobs = await storage.transaction(async (tx) => (await tx.jobs.all()).map((job) => job.task.kind));
	assert.deepEqual(jobs, []);

	const withRef = await events.create("alice", "e-1", eventWithTaskRef("-a"));
	// 未配置模型：handler 直接跳过，不产生待确认条目。
	const noModel = createHypothesisVerdictJobHandler(storage, async () => null, () => null);
	await noModel.prepare({ kind: "market_event", eventId: withRef.version.eventId, version: withRef.version.version });
	assert.deepEqual(await hypotheses.pendingVerdicts("alice"), []);

	// unclear 初判允许记录。
	const unclearHandler = createHypothesisVerdictJobHandler(
		storage,
		async () => judgmentJson({ judgment: "unclear", quote: undefined }),
		() => "m",
	);
	await unclearHandler.prepare({ kind: "market_event", eventId: withRef.version.eventId, version: withRef.version.version });
	const pending = await hypotheses.pendingVerdicts("alice");
	assert.equal(pending.length, 1);
	assert.equal(pending[0]?.judgment, "unclear");
	// 确认 unclear 不改变状态。
	const confirmed = await hypotheses.confirmVerdict("alice", pending[0]!.id);
	assert.equal(confirmed.hypothesis.status, "open");

	// 停用后不再初判：修订事件产生新版本 job，但 handler 跳过 retired 假设。
	await hypotheses.retire("alice", hypothesisId, "h-2", 1);
	const revised = await events.revise("alice", withRef.version.eventId, "e-1-rev", 1,
		{ ...eventWithTaskRef("-a"), conditions: "仅限试点地区（扩展）" }, "修订");
	assert.equal(revised.status, "revised");
	jobs = await storage.transaction(async (tx) => (await tx.jobs.all()).map((job) => job.task.kind));
	assert.ok(jobs.includes("prepare_hypothesis_verdicts"), "修订仍入队");
	const handler = createHypothesisVerdictJobHandler(storage, async () => judgmentJson(), () => "m");
	await handler.prepare({ kind: "market_event", eventId: revised.version.eventId, version: revised.version.version });
	// retired 假设没有新初判（原有 pending 已确认）。
	assert.equal((await hypotheses.pendingVerdicts("alice")).length, 0);
});

test("hypothesis verdict jobs: worker dispatches to the injected handler", async () => {
	const { storage, events } = await setup();
	const created = await events.create("alice", "e-1", eventWithTaskRef("-b"));
	const prepared: string[] = [];
	const worker = new Worker(
		storage,
		{} as never,
		new Map(),
		() => "2026-01-01T00:00:00.000Z",
		0,
		undefined,
		undefined,
		undefined,
		0,
		undefined,
		undefined,
		0,
		{
			prepare: async (source) => {
				if (source.kind === "market_event")
					prepared.push(`${source.kind}:${source.eventId}:${source.version}`);
			},
		},
	);
	await worker.runOnce();
	assert.deepEqual(prepared, [`market_event:${created.version.eventId}:${created.version.version}`]);
	const statuses = await storage.transaction(async (tx) => (await tx.jobs.all()).map((job) => job.status));
	assert.deepEqual(statuses, ["done"]);
	// 未注入处理器时 job 失败并保留原因。
	const failing = new Worker(
		storage,
		{} as never,
		new Map(),
		() => "2026-01-01T00:00:01.000Z",
		0,
		undefined,
		undefined,
		undefined,
		0,
		undefined,
		undefined,
		0,
	);
	const retry = await events.revise("alice", created.version.eventId, "e-1-rev2", 1,
		{ ...eventWithTaskRef("-b"), conditions: "仅限试点地区（更新）" }, "再次修订");
	await failing.runOnce();
	const failed = await storage.transaction(async (tx) =>
		(await tx.jobs.all()).find((job) => job.task.kind === "prepare_hypothesis_verdicts"
			&& job.task.source.kind === "market_event" && job.task.source.version === retry.version.version));
	assert.equal(failed?.status, "failed");
});
