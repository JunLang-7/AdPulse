import assert from "node:assert/strict";
import test from "node:test";
import {
	HypothesisError,
	HypothesisPreliminaryWriter,
	HypothesisService,
	MarketEventService,
	TaskService,
	type HypothesisCreateInput,
	type HypothesisVerdictInput,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { eventInput, taskInput } from "./market-event-fixtures.ts";

const createInput = (overrides: Partial<HypothesisCreateInput> = {}): HypothesisCreateInput => ({
	taskId: "task-1", // setup 中由 idFactory 固定。
	statement: "目标人群对免费试用装的反应优于直接折扣",
	rationale: "方案把免费试用作为主卖点，判断依据是任务说明中的人群价格敏感描述",
	origin: "manual",
	...overrides,
});

const verdictInput = (overrides: Partial<HypothesisVerdictInput> = {}): HypothesisVerdictInput => ({
	subject: { kind: "market_event", eventId: "event-1", version: 1 },
	judgment: "challenges",
	explanation: "竞品同区间推出同类免费试用，直接削弱差异化判断",
	...overrides,
});

async function setup() {
	const storage = new MemoryStorage();
	const tasks = new TaskService(storage, () => "2026-01-01T00:00:00.000Z", () => "task-1");
	const task = await tasks.create("alice", "task-create", taskInput);
	const service = new HypothesisService(storage);
	const preliminary = new HypothesisPreliminaryWriter(storage);
	return { storage, tasks, task, service, preliminary };
}

test("hypotheses: create, idempotent replay and same-statement dedup", async () => {
	const { service } = await setup();
	const created = await service.create("alice", "h-key-1", createInput());
	assert.equal(created.status, "created");
	assert.equal(created.hypothesis?.status, "open");
	assert.equal(created.hypothesis?.taskVersion, 1);
	assert.equal(created.version?.version, 1);
	assert.deepEqual(await service.create("alice", "h-key-1", createInput()), created);

	// 同任务同陈述、不同内容：要求走 revise，不允许悄悄覆盖或静默丢弃差异。
	await assert.rejects(
		service.create("alice", "h-key-2", createInput({ rationale: "不同的依据说明" })),
		(e: unknown) => e instanceof HypothesisError && e.status === 409,
	);

	// 幂等键相同、内容不同：冲突。
	await assert.rejects(
		service.create("alice", "h-key-1", createInput({ statement: "另一条判断" })),
		(e: unknown) => e instanceof HypothesisError && e.status === 409,
	);
});

test("hypotheses: model draft acceptance requires a draft reference; manual cannot carry one", async () => {
	const { service } = await setup();
	await assert.rejects(
		service.create("alice", "h-d1", createInput({ origin: "model_draft_accepted" })),
		(e: unknown) => e instanceof HypothesisError && e.status === 400,
	);
	const accepted = await service.create("alice", "h-d2", createInput({
		origin: "model_draft_accepted",
		draftRef: { modelRef: "deepseek/deepseek-chat", generatedAt: "2026-01-01T00:00:00.000Z", iterations: 2 },
	}));
	assert.equal(accepted.status, "created");
	assert.equal(accepted.version?.origin, "model_draft_accepted");
	assert.equal(accepted.version?.draftRef?.iterations, 2);
	await assert.rejects(
		service.create("alice", "h-d3", createInput({ draftRef: { modelRef: "x", generatedAt: "2026-01-01T00:00:00.000Z", iterations: 0 } })),
		(e: unknown) => e instanceof HypothesisError && e.status === 400,
	);
});

test("hypotheses: content validation and owner isolation", async () => {
	const { service } = await setup();
	await assert.rejects(service.create("alice", "v1", createInput({ statement: "" })), /statement/);
	await assert.rejects(service.create("alice", "v2", createInput({ statement: "x".repeat(201) })), /statement/);
	await assert.rejects(service.create("alice", "v3", createInput({ rationale: "x".repeat(501) })), /rationale/);
	await assert.rejects(service.create("alice", "v4", createInput({ testable: "x".repeat(401) })), /testable/);
	await service.create("alice", "ok", createInput());
	assert.deepEqual(await service.list("bob", "task-1"), []);
	assert.equal(await service.detail("bob", (await service.list("alice", "task-1"))[0]!.head.id), null);
	await assert.rejects(
		service.create("bob", "h-bob", createInput()),
		(e: unknown) => e instanceof HypothesisError && e.status === 404,
	);
});

test("hypotheses: revise creates a new version, unchanged replays and conflicts reject", async () => {
	const { service } = await setup();
	const created = await service.create("alice", "h-1", createInput());
	const id = created.hypothesis!.id;
	const revised = await service.revise("alice", id, "h-2", 1, {
		statement: created.version!.statement,
		rationale: "补充：人群访谈中价格敏感被多次提及",
		testable: "支持：试用装领取量上升；挑战：竞品同类活动或人群反馈冷淡",
	});
	assert.equal(revised.status, "revised");
	assert.equal(revised.version?.version, 2);
	assert.equal(revised.version?.testable?.startsWith("支持"), true);
	// 旧版本保留。
	const detail = await service.detail("alice", id);
	assert.equal(detail?.versions.length, 2);
	// 内容未变 → unchanged。
	const unchanged = await service.revise("alice", id, "h-3", 2, {
		statement: created.version!.statement,
		rationale: "补充：人群访谈中价格敏感被多次提及",
		testable: "支持：试用装领取量上升；挑战：竞品同类活动或人群反馈冷淡",
	});
	assert.equal(unchanged.status, "unchanged");
	assert.equal(unchanged.version?.version, 2);
	// 过期版本号 → 冲突。
	await assert.rejects(
		service.revise("alice", id, "h-4", 1, { statement: "x", rationale: "y" }),
		(e: unknown) => e instanceof HypothesisError && e.status === 409,
	);
	// 幂等重放。
	const replay = await service.revise("alice", id, "h-2", 1, {
		statement: created.version!.statement,
		rationale: "补充：人群访谈中价格敏感被多次提及",
		testable: "支持：试用装领取量上升；挑战：竞品同类活动或人群反馈冷淡",
	});
	assert.equal(replay.status, "revised");
	assert.equal(replay.version?.version, 2);
	// 修订不能与其他假设的陈述重复。
	const other = await service.create("alice", "h-5", createInput({ statement: "另一条独立判断" }));
	await assert.rejects(
		service.revise("alice", id, "h-6", 2, { statement: "另一条独立判断", rationale: "x" }),
		(e: unknown) => e instanceof HypothesisError && e.status === 409,
	);
	assert.equal(other.hypothesis?.currentVersion, 1);
});

test("hypotheses: manual verdicts change status; unclear does not; dedup prevents double verdict", async () => {
	const { storage, service } = await setup();
	const events = new MarketEventService(storage);
	const event = await events.create("alice", "e-1", eventInput());
	const subject: HypothesisVerdictInput["subject"] = {
		kind: "market_event", eventId: event.version.eventId, version: event.version.version,
	};
	const created = await service.create("alice", "h-1", createInput());
	const id = created.hypothesis!.id;

	const verdict = await service.verdict("alice", id, "v-1", verdictInput({ subject }));
	assert.equal(verdict.status, "verdict_recorded");
	assert.equal(verdict.verdict?.stage, "confirmed");
	assert.equal(verdict.hypothesis?.status, "challenged");

	// 同一判定重复提交（换 key）：dedup 返回原判定，不新增。
	const again = await service.verdict("alice", id, "v-2", verdictInput({ subject }));
	assert.equal(again.status, "verdict_duplicate");
	assert.equal(again.verdict?.id, verdict.verdict?.id);
	const detail = await service.detail("alice", id);
	assert.equal(detail?.verdicts.length, 1);

	// 已确认同主体后换判定：冲突，要求先驳回初判或修订假设到新版本。
	await assert.rejects(
		service.verdict("alice", id, "v-3", verdictInput({ subject, judgment: "supports" })),
		(e: unknown) => e instanceof HypothesisError && e.status === 409,
	);
	await assert.rejects(
		service.verdict("alice", id, "v-4", verdictInput({ subject, judgment: "unclear", explanation: "不足以判断" })),
		(e: unknown) => e instanceof HypothesisError && e.status === 409,
	);

	// 修订到新版本后：unclear 不改变状态，同一事件可重新判定。
	const revised = await service.revise("alice", id, "h-7", 1, {
		statement: "目标人群对免费试用装的反应优于直接折扣（修订）",
		rationale: "同前",
	});
	const unclear = await service.verdict("alice", id, "v-6", verdictInput({
		subject,
		judgment: "unclear", explanation: "不足以判断",
	}));
	assert.equal(unclear.status, "verdict_recorded");
	assert.equal(unclear.verdict?.hypothesisVersion, 2);
	assert.equal(unclear.hypothesis?.status, "challenged");
	const event2Input = { ...eventInput(), occurrenceKey: "release-2027-01", title: "竞品跟进免费试用" };
	event2Input.sources = [{ ...event2Input.sources[0]!, url: "https://example.com/releases/2", content: "竞品跟进免费试用，2027-01 上线。" }];
	event2Input.citations = { subject: null, eventTime: null, conditions: null };
	const event2 = await events.create("alice", "e-2", event2Input);
	const supports = await service.verdict("alice", id, "v-5", verdictInput({
		subject: { kind: "market_event", eventId: event2.version.eventId, version: event2.version.version },
		judgment: "supports",
	}));
	assert.equal(revised.status, "revised");
	assert.equal(supports.hypothesis?.status, "supported");
	assert.equal(supports.hypothesis?.currentVersion, revised.version?.version);
	assert.equal(supports.verdict?.hypothesisVersion, 2);
});

test("hypotheses: subject must exist and belong to the owner", async () => {
	const { storage, service } = await setup();
	const events = new MarketEventService(storage);
	const event = await events.create("alice", "e-1", eventInput());
	const created = await service.create("alice", "h-1", createInput());
	const id = created.hypothesis!.id;
	await assert.rejects(
		service.verdict("alice", id, "v-1", verdictInput({ subject: { kind: "market_event", eventId: "nope", version: 1 } })),
		(e: unknown) => e instanceof HypothesisError && e.status === 404,
	);
	await assert.rejects(
		service.verdict("alice", id, "v-2", verdictInput({ subject: { kind: "market_event", eventId: event.version.eventId, version: 99 } })),
		(e: unknown) => e instanceof HypothesisError && e.status === 404,
	);
	await assert.rejects(
		service.verdict("bob", id, "v-3", verdictInput({ subject: { kind: "market_event", eventId: event.version.eventId, version: 1 } })),
		(e: unknown) => e instanceof HypothesisError && e.status === 404,
	);
	await assert.rejects(
		service.verdict("alice", id, "v-4", verdictInput({ subject: { kind: "comparison", comparisonResultId: "nope" } })),
		(e: unknown) => e instanceof HypothesisError && e.status === 404,
	);
	await assert.rejects(
		service.verdict("alice", id, "v-5", verdictInput({ explanation: "x".repeat(1001) })),
		(e: unknown) => e instanceof HypothesisError && e.status === 400,
	);
	await assert.rejects(
		service.verdict("alice", id, "v-6", verdictInput({ preliminary: { modelRef: "m", generatedAt: "2026-01-01T00:00:00.000Z" } })),
		(e: unknown) => e instanceof HypothesisError && e.status === 400,
	);
});

test("hypotheses: preliminary verdicts need confirmation; confirm changes status, reject does not", async () => {
	const { storage, service, preliminary } = await setup();
	const events = new MarketEventService(storage);
	const event = await events.create("alice", "e-1", eventInput());
	const subject: HypothesisVerdictInput["subject"] = {
		kind: "market_event", eventId: event.version.eventId, version: event.version.version,
	};
	const created = await service.create("alice", "h-1", createInput());
	const id = created.hypothesis!.id;

	const recorded = await preliminary.record({
		ownerId: "alice", hypothesisId: id, subject,
		judgment: "challenges", explanation: "竞品同类免费试用削弱差异化",
		quote: "测试品牌于2026-11-16发布新品，仅限试点地区。",
		preliminary: { modelRef: "deepseek/deepseek-chat", generatedAt: "2026-01-01T00:00:00.000Z" },
	});
	assert.equal(recorded.outcome, "recorded");
	assert.equal(recorded.verdict.stage, "preliminary");
	assert.equal((await service.detail("alice", id))?.head.status, "open");

	// 初判重试幂等。
	const retry = await preliminary.record({
		ownerId: "alice", hypothesisId: id, subject,
		judgment: "challenges", explanation: "竞品同类免费试用削弱差异化",
		preliminary: { modelRef: "deepseek/deepseek-chat", generatedAt: "2026-01-01T00:00:00.000Z" },
	});
	assert.equal(retry.outcome, "duplicate");
	assert.equal(retry.verdict.id, recorded.verdict.id);

	assert.equal((await service.pendingVerdicts("alice")).length, 1);
	assert.deepEqual(await service.pendingVerdicts("bob"), []);

	const confirmed = await service.confirmVerdict("alice", recorded.verdict.id);
	assert.equal(confirmed.verdict.stage, "confirmed");
	assert.equal(confirmed.hypothesis.status, "challenged");
	// 确认后不再是待确认。
	assert.deepEqual(await service.pendingVerdicts("alice"), []);
	// 重复确认幂等返回。
	const again = await service.confirmVerdict("alice", recorded.verdict.id);
	assert.equal(again.verdict.stage, "confirmed");

	// 驳回路径：不改状态。
	const created2 = await service.create("alice", "h-2", createInput({ statement: "第二条判断" }));
	const pending2 = await preliminary.record({
		ownerId: "alice", hypothesisId: created2.hypothesis!.id, subject,
		judgment: "supports", explanation: "同事件支持第二条判断",
		preliminary: { modelRef: "m", generatedAt: "2026-01-01T00:00:00.000Z" },
	});
	const rejected = await service.rejectVerdict("alice", pending2.verdict.id);
	assert.equal(rejected.verdict.stage, "rejected");
	assert.equal((await service.detail("alice", created2.hypothesis!.id))?.head.status, "open");
	// 驳回是终态：再确认拒绝。
	await assert.rejects(
		service.confirmVerdict("alice", pending2.verdict.id),
		(e: unknown) => e instanceof HypothesisError && e.status === 409,
	);
	// 已确认的判定不能驳回。
	await assert.rejects(
		service.rejectVerdict("alice", recorded.verdict.id),
		(e: unknown) => e instanceof HypothesisError && e.status === 409,
	);
});

test("hypotheses: retire stops verdicts and replay is idempotent", async () => {
	const { service } = await setup();
	const created = await service.create("alice", "h-1", createInput());
	const id = created.hypothesis!.id;
	const retired = await service.retire("alice", id, "h-2", 1);
	assert.equal(retired.status, "retired");
	assert.equal(retired.hypothesis?.status, "retired");
	const replay = await service.retire("alice", id, "h-2", 1);
	assert.equal(replay.status, "retired");
	// 换 key 重复停用：幂等返回 unchanged，不报冲突。
	const repeat = await service.retire("alice", id, "h-3", 1);
	assert.equal(repeat.status, "unchanged");
	assert.equal(repeat.hypothesis?.status, "retired");
	await assert.rejects(
		service.verdict("alice", id, "v-1", verdictInput()),
		(e: unknown) => e instanceof HypothesisError && e.status === 409,
	);
	await assert.rejects(
		service.revise("alice", id, "h-4", 1, { statement: "x", rationale: "y" }),
		(e: unknown) => e instanceof HypothesisError && e.status === 409,
	);
});
