import assert from "node:assert/strict";
import test from "node:test";
import {
	applyChanges,
	isMonetaryChange,
	MAX_STRATEGY_CHANGES,
	Orchestrator,
	TaskService,
	Worker,
} from "../packages/core/dist/index.js";
import type {
	ChoiceCommand,
	Limits,
	OutboundChannel,
	PolicyEngine,
	Strategy,
	StrategyChange,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";
import { fixture, proposal } from "./helpers.ts";

const strategy: Strategy = {
	objective: "leads",
	audience: [],
	channels: { ads: { budget: 100, bidCpc: 2 } },
	sellingPoints: [],
};
const limits: Limits = { maxBudgetChangeRatio: 0.2, maxBidChangeRatio: 0.2 };

test("model changes cannot bypass limits through repeated fields or unsupported kinds", () => {
	assert.throws(
		() =>
			applyChanges(
				strategy,
				[
					{ kind: "budget", channelId: "ads", from: 100, to: 120 },
					{ kind: "budget", channelId: "ads", from: 120, to: 144 },
				],
				limits,
			),
		/duplicate/,
	);
	for (const change of [
		{ kind: "arbitrary", channelId: "ads", to: 100 },
		{ kind: "budget", channelId: "missing", from: 100, to: 100 },
		{ kind: "budget", channelId: "ads", from: 90, to: 100 },
		{ kind: "bidCpc", channelId: "ads", from: 2, to: NaN },
		{ kind: "enabled", channelId: "ads", to: "true" },
		null,
	] as unknown[])
		assert.throws(() =>
			applyChanges(strategy, [change as StrategyChange], limits),
		);
	assert.equal(strategy.channels.ads.budget, 100);
});

test("audience and sellingPoint changes are list operations with their own limits", () => {
	const base: Strategy = {
		objective: "leads",
		audience: ["装修业主"],
		channels: {},
		sellingPoints: ["免费样品"],
	};
	const applied = applyChanges(
		base,
		[
			{ kind: "audience", op: "add", item: "春节备货家庭" },
			{ kind: "audience", op: "remove", item: "装修业主" },
			{ kind: "sellingPoint", op: "add", item: "产地可参观" },
			{ kind: "contentDirection", op: "add", item: "产地溯源短视频" },
			{ kind: "partner", op: "add", item: "本地生活达人" },
		],
		limits,
	);
	assert.deepEqual(applied.audience, ["春节备货家庭"]);
	assert.deepEqual(applied.sellingPoints, ["免费样品", "产地可参观"]);
	assert.deepEqual(applied.contentDirections, ["产地溯源短视频"]);
	assert.deepEqual(applied.partners, ["本地生活达人"]);
	// 旧方案没有这两个可选字段：移除即视为过期，而不是抛 TypeError。
	assert.throws(
		() => applyChanges(base, [{ kind: "partner", op: "remove", item: "不存在" }], limits),
		/stale/,
	);
	assert.throws(
		() =>
			applyChanges(
				{ ...base, partners: "不是数组" } as unknown as Strategy,
				[],
				limits,
			),
		/invalid strategy/,
	);
	assert.deepEqual(base.audience, ["装修业主"], "input strategy is not mutated");

	const rejected: Array<[StrategyChange, RegExp]> = [
		[{ kind: "audience", op: "add", item: "装修业主" }, /stale/],
		[{ kind: "audience", op: "remove", item: "不存在" }, /stale/],
		[{ kind: "sellingPoint", op: "add", item: " 前后空格 " }, /invalid/],
		[{ kind: "audience", op: "add", item: "a".repeat(81) }, /invalid/],
		[{ kind: "audience", op: "add", item: "带\n换行" }, /invalid/],
		[
			{ kind: "audience", op: "toggle", item: "x" } as unknown as StrategyChange,
			/invalid/,
		],
	];
	for (const [change, pattern] of rejected)
		assert.throws(() => applyChanges(base, [change], limits), pattern);

	assert.throws(
		() =>
			applyChanges(
				base,
				[
					{ kind: "audience", op: "add", item: "新人群" },
					{ kind: "audience", op: "add", item: "新人群" },
				],
				limits,
			),
		/duplicate/,
	);
	const full: Strategy = {
		...base,
		audience: Array.from({ length: 8 }, (_, index) => `人群${index}`),
	};
	assert.throws(
		() => applyChanges(full, [{ kind: "audience", op: "add", item: "第九项" }], limits),
		/list is full/,
	);
	const tooMany = Array.from({ length: MAX_STRATEGY_CHANGES + 1 }, (_, index) => ({
		kind: "audience" as const,
		op: "add" as const,
		item: `新人群${index}`,
	}));
	assert.throws(() => applyChanges(base, tooMany, limits), /too many/);
});

test("only budget and bid changes count as monetary", () => {
	assert.equal(isMonetaryChange({ kind: "budget", channelId: "ads", from: 1, to: 2 }), true);
	assert.equal(isMonetaryChange({ kind: "bidCpc", channelId: "ads", from: 1, to: 2 }), true);
	assert.equal(isMonetaryChange({ kind: "enabled", channelId: "ads", from: true, to: false }), false);
	assert.equal(isMonetaryChange({ kind: "audience", op: "add", item: "人群" }), false);
	assert.equal(isMonetaryChange({ kind: "sellingPoint", op: "remove", item: "卖点" }), false);
	assert.equal(isMonetaryChange({ kind: "contentDirection", op: "add", item: "内容" }), false);
	assert.equal(isMonetaryChange({ kind: "partner", op: "add", item: "达人" }), false);
});

test("unconfirmed task rules allow audience suggestions but reject monetary ones", async () => {
	const storage = new MemoryStorage();
	const now = () => "2026-01-01T00:00:00.000Z";
	const task = await new TaskService(storage, now).create("owner", "task-key", {
		product: "测试产品",
		strategy: structuredClone(strategy),
		observation: {},
		rules: {},
	});
	const baseInput = {
		ownerId: "owner",
		taskRef: { taskId: task.taskId, taskVersion: task.version },
		recipient: { accountId: "account-a", kind: "user" as const, externalId: "user-a" },
		allowedActorIds: ["user-a"],
		strategy: structuredClone(strategy),
		limits,
		signal: {
			id: "sig",
			title: "成本变化",
			summary: "需要复核",
			evidence: [{ label: "CPC", value: "2 → 2.4" }],
		},
		expiresAt: "2026-01-02T00:00:00.000Z",
	};
	const card = {
		title: "复核",
		summary: "仅调整方案草案",
		evidence: [{ label: "CPC", value: "2 → 2.4" }],
	};
	const budgetPolicy: PolicyEngine = {
		async propose() {
			return {
				card,
				candidates: [
					{
						id: "budget",
						label: "上调预算",
						changes: [{ kind: "budget", channelId: "ads", from: 100, to: 110 }],
						complete: true,
					},
				],
			};
		},
	};
	const budget = new Orchestrator(storage, budgetPolicy, now);
	const budgetSession = await budget.startSession({
		...baseInput,
		requestId: crypto.randomUUID(),
	});
	await assert.rejects(
		budget.prepareRound(budgetSession.id, 0),
		/unconfirmed task rules prohibit monetary suggestions/,
	);
	assert.equal((await storage.transaction((tx) => tx.rounds.all())).length, 0);

	const audiencePolicy: PolicyEngine = {
		async propose() {
			return {
				card,
				candidates: [
					{
						id: "audience",
						label: "补充人群",
						changes: [{ kind: "audience", op: "add", item: "春节备货的家庭" }],
						complete: true,
					},
				],
			};
		},
	};
	const audience = new Orchestrator(storage, audiencePolicy, now);
	const audienceSession = await audience.startSession({
		...baseInput,
		requestId: crypto.randomUUID(),
	});
	await audience.prepareRound(audienceSession.id, 0);
	const rounds = await storage.transaction((tx) => tx.rounds.all());
	assert.equal(rounds.length, 1);
	assert.deepEqual(rounds[0]?.candidates[0]?.changes, [
		{ kind: "audience", op: "add", item: "春节备货的家庭" },
	]);
});

test("candidate hypothesis and validation plan are bounded, persisted, and shown on the card", async () => {
	const f = fixture();
	const card = {
		title: "复核",
		summary: "仅调整方案草案",
		evidence: [{ label: "CPC", value: "2 → 2.4" }],
	};
	const policy: PolicyEngine = {
		async propose() {
			return {
				card,
				candidates: [
					{
						id: "adjust",
						label: "补充人群",
						changes: [{ kind: "audience", op: "add", item: "春节备货家庭" }],
						complete: true,
						hypothesis: "节前备货需求上升",
						validationPlan: "观察 7 天咨询成本是否回落",
					},
				],
			};
		},
	};
	const decisions = new Orchestrator(f.storage, policy, f.now);
	const session = await f.start();
	await decisions.prepareRound(session.id, 0);
	const round = await f.storage.transaction((tx) =>
		tx.rounds.get(`${session.id}:1`),
	);
	assert.equal(round?.candidates[0]?.hypothesis, "节前备货需求上升");
	const expectedDetail =
		"假设：节前备货需求上升；验证：观察 7 天咨询成本是否回落";
	assert.deepEqual(round?.card.options[0], {
		id: "adjust",
		label: "补充人群",
		detail: expectedDetail,
	});
	const delivery = (
		await f.storage.transaction((tx) => tx.deliveries.all())
	)[0];
	assert.ok(delivery && "options" in delivery.card);
	assert.equal(delivery.card.options[0]?.detail, expectedDetail);

	const action = (
		await f.storage.transaction((tx) => tx.actions.all())
	)[0];
	assert.ok(action);
	const inbox = await decisions.receiveChoice({
		sourceId: "console:owner",
		eventId: "rationale-accept",
		actionRef: action.id,
		actor: { kind: "console", userId: "owner" },
	});
	await decisions.processInbox(inbox.id);
	const applied = await f.storage.transaction((tx) =>
		tx.snapshots.get(`${session.id}:1`),
	);
	assert.equal(applied?.hypothesis, "节前备货需求上升");
	assert.equal(applied?.validationPlan, "观察 7 天咨询成本是否回落");

	for (const value of [
		{ hypothesis: " 前后空格 " },
		{ validationPlan: "a".repeat(301) },
		{ hypothesis: "带\n换行" },
	]) {
		const invalidPolicy = {
			async propose() {
				return {
					card,
					candidates: [
						{ id: "x", label: "x", changes: [], complete: true, ...value },
					],
				};
			},
		} as PolicyEngine;
		const invalid = new Orchestrator(f.storage, invalidPolicy, f.now);
		const target = await f.start();
		await assert.rejects(
			invalid.prepareRound(target.id, 0),
			/invalid candidate rationale/,
		);
	}
});

test("inbox event identity is scoped to each connection", async () => {
	const f = fixture();
	const command: ChoiceCommand = {
		sourceId: "account-a",
		eventId: "same-event",
		actionRef: "opaque",
		actor: { kind: "platform", accountId: "account-a", externalId: "u" },
	};
	const first = await f.decisions.receiveChoice(command);
	const second = await f.decisions.receiveChoice({
		...command,
		sourceId: "account-b",
		actor: { kind: "platform", accountId: "account-b", externalId: "u" },
	});
	assert.notEqual(first.id, second.id);
});

test("slow proposal is discarded if the session changes while the policy runs", async () => {
	const f = fixture();
	const session = await f.start();
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const decisions = new Orchestrator(
		f.storage,
		{
			async propose() {
				entered();
				await blocked;
				return structuredClone(proposal);
			},
		},
		f.now,
	);
	const planning = decisions.prepareRound(session.id, 0);
	await started;
	await f.storage.transaction(async (tx) => {
		const current = await tx.sessions.get(session.id);
		assert.ok(current);
		await tx.sessions.put({ ...current, status: "cancelled" });
	});
	release();
	await planning;
	assert.equal(
		(await f.storage.transaction((tx) => tx.rounds.all())).length,
		0,
	);
	assert.equal(
		(await f.storage.transaction((tx) => tx.deliveries.all())).length,
		0,
	);
});

test("non-terminal decision produces next round using the updated strategy", async () => {
	const f = fixture();
	const session = await f.start();
	const seen: Strategy[] = [];
	const decisions = new Orchestrator(
		f.storage,
		{
			async propose(context) {
				seen.push(structuredClone(context.strategy));
				if (context.roundNo === 1)
					return {
						...structuredClone(proposal),
						candidates: [
							{ ...structuredClone(proposal.candidates[0]), complete: false },
						],
					};
				return {
					...structuredClone(proposal),
					candidates: [
						{ id: "done", label: "完成", changes: [], complete: true },
					],
				};
			},
		},
		f.now,
	);
	await decisions.prepareRound(session.id, 0);
	const action = (await f.storage.transaction((tx) => tx.actions.all()))[0];
	const inbox = await decisions.receiveChoice({
		sourceId: "console:owner",
		eventId: "decision",
		actionRef: action.id,
		actor: { kind: "console", userId: "owner" },
	});
	await decisions.processInbox(inbox.id);
	await decisions.prepareRound(session.id, 1);
	assert.equal(seen[1].channels.ads.bidCpc, 1.8);
	assert.deepEqual(
		(await f.storage.transaction((tx) => tx.rounds.all())).map(
			(r) => r.roundNo,
		),
		[1, 2],
	);
});

test("an expired worker cannot overwrite the receipt committed by the new lease holder", async () => {
	const f = fixture();
	await f.start();
	await f.worker.runOnce();
	let release!: () => void;
	let entered!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const oldWorker = new Worker(
		f.storage,
		f.decisions,
		new Map<string, OutboundChannel>([
			[
				"account-a",
				{
					async send() {
						entered();
						await blocked;
						return { externalMessageId: "stale-receipt" };
					},
				},
			],
		]),
		f.now,
	);
	const first = oldWorker.runOnce();
	await started;
	f.advance();
	const newWorker = new Worker(
		f.storage,
		f.decisions,
		new Map<string, OutboundChannel>([
			[
				"account-a",
				{
					async send() {
						return { externalMessageId: "current-receipt" };
					},
				},
			],
		]),
		f.now,
	);
	await newWorker.runOnce();
	release();
	await first;
	const delivery = (
		await f.storage.transaction((tx) => tx.deliveries.all())
	)[0];
	assert.equal(delivery.externalMessageId, "current-receipt");
	const sendJob = (await f.storage.transaction((tx) => tx.jobs.all())).find(
		(j) => j.task.kind === "send_delivery",
	);
	assert.ok(sendJob);
	assert.equal(sendJob.status, "done");
	assert.equal(sendJob.attempts, 2);
});

test("卖点、内容方向、人群与合作对象的变更可作为建议提出，并经确认应用到方案", async () => {
	// README 承诺「调整卖点、内容、人群、渠道、合作对象，还是预算」均能作为建议；
	// 本用例走完整链路：PolicyEngine 提出→冻结候选→用户确认→策略快照应用。
	const storage = new MemoryStorage();
	const now = () => "2026-01-01T00:00:00.000Z";
	const baseStrategy: Strategy = {
		objective: "获取咨询",
		audience: ["装修业主"],
		channels: { ads: { budget: 100, bidCpc: 2 } },
		sellingPoints: ["免费样品"],
		contentDirections: ["产地溯源"],
		partners: ["本地生活达人"],
	};
	const listPolicy: PolicyEngine = {
		async propose() {
			return {
				card: {
					title: "调整表达与人群",
					summary: "仅调整方案草案",
					evidence: [{ label: "讨论", value: "防雨内容上升" }],
				},
				candidates: [
					{
						id: "rephrase",
						label: "换卖点、人群、内容与合作对象",
						changes: [
							{ kind: "sellingPoint", op: "add", item: "防雨设计" },
							{ kind: "sellingPoint", op: "remove", item: "免费样品" },
							{ kind: "audience", op: "add", item: "通勤人群" },
							{ kind: "contentDirection", op: "add", item: "雨天通勤短视频" },
							{ kind: "partner", op: "add", item: "通勤装备测评达人" },
						],
						complete: true,
					},
				],
			};
		},
	};
	const task = await new TaskService(storage, now).create("owner", "task-key", {
		product: "防雨背包",
		strategy: structuredClone(baseStrategy),
		observation: {},
		rules: {},
	});
	const decisions = new Orchestrator(storage, listPolicy, now);
	const session = await decisions.startSession({
		requestId: crypto.randomUUID(),
		ownerId: "owner",
		taskRef: { taskId: task.taskId, taskVersion: task.version },
		recipient: { accountId: "account-a", kind: "user", externalId: "user-a" },
		allowedActorIds: ["user-a"],
		strategy: structuredClone(baseStrategy),
		limits,
		signal: {
			id: "sig",
			title: "讨论变化",
			summary: "需要复核",
			evidence: [{ label: "讨论", value: "防雨内容上升" }],
		},
		expiresAt: "2026-01-02T00:00:00.000Z",
	});
	// 任务口径未确认：非货币的五条列表变更必须被接受（不被当作花钱建议拦下）。
	await decisions.prepareRound(session.id, 0);
	const round = await storage.transaction((tx) => tx.rounds.get(`${session.id}:1`));
	assert.equal(round?.candidates[0]?.changes.length, 5);
	assert.equal(round?.candidates[0]?.label, "换卖点、人群、内容与合作对象");

	const action = (await storage.transaction((tx) => tx.actions.all()))[0];
	assert.ok(action);
	const inbox = await decisions.receiveChoice({
		sourceId: "console:owner",
		eventId: "list-changes-accept",
		actionRef: action.id,
		actor: { kind: "console", userId: "owner" },
	});
	await decisions.processInbox(inbox.id);

	const applied = await storage.transaction((tx) => tx.snapshots.get(`${session.id}:1`));
	assert.deepEqual(applied?.strategy.sellingPoints, ["防雨设计"]);
	assert.deepEqual(applied?.strategy.audience, ["装修业主", "通勤人群"]);
	assert.deepEqual(applied?.strategy.contentDirections, ["产地溯源", "雨天通勤短视频"]);
	assert.deepEqual(applied?.strategy.partners, ["本地生活达人", "通勤装备测评达人"]);
	// 未提议的渠道数值与目标保持不变：建议不越权改动其余字段。
	assert.equal(applied?.strategy.channels.ads.budget, 100);
	assert.equal(applied?.strategy.objective, "获取咨询");
	assert.equal(applied?.changes.length, 5);
});
