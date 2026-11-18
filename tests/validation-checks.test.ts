import assert from "node:assert/strict";
import test from "node:test";
import {
	Orchestrator,
	TaskService,
	ValidationCheckService,
	Worker,
} from "../packages/core/dist/index.js";
import type {
	Candidate,
	PolicyEngine,
	TaskInput,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

const MS_PER_DAY = 86_400_000;
const START = "2026-01-01T00:00:00.000Z";
const DUE = new Date(Date.parse(START) + 7 * MS_PER_DAY).toISOString();
const strategy = {
	objective: "leads",
	audience: [],
	channels: { ads: { budget: 100, bidCpc: 2 } },
	sellingPoints: [],
};
const limits = { maxBudgetChangeRatio: 0.2, maxBidChangeRatio: 0.2 };
const signal = {
	id: "sig",
	title: "成本变化",
	summary: "需要复核",
	evidence: [{ label: "CPC", value: "2 → 2.4" }],
};
const completeRules: TaskInput["rules"] = {
	metricKey: "cost_per_consultation" as const,
	metricDefinition: "咨询成本",
	currency: "CNY",
	unit: "分",
	statWindowDays: 7,
	alertThresholdMinor: 10000,
	minimumSpendMinor: 50000,
	minimumConsultations: 3,
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
	return {
		id: "adjust",
		label: "补充人群",
		changes: [{ kind: "audience", op: "add", item: "春节备货家庭" }],
		complete: false,
		hypothesis: "节前备货需求上升",
		validationPlan: "观察 7 天咨询成本是否回落",
		...overrides,
	};
}

function setup(options: {
	rules?: TaskInput["rules"];
	candidate?: ReturnType<typeof candidate>;
} = {}) {
	const storage = new MemoryStorage();
	let clock = START;
	const now = () => clock;
	const policy: PolicyEngine = {
		async propose() {
			return {
				card: {
					title: "复核",
					summary: "仅调整方案草案",
					evidence: [{ label: "CPC", value: "2 → 2.4" }],
				},
				candidates: [options.candidate ?? candidate()],
			};
		},
	};
	const decisions = new Orchestrator(storage, policy, now);
	const checks = new ValidationCheckService(storage, now);
	const advanceToDue = () => {
		clock = DUE;
	};
	return {
		storage,
		now,
		decisions,
		checks,
		advanceToDue,
		async start(rules: TaskInput["rules"] = options.rules ?? completeRules) {
			const task = await new TaskService(storage, now).create("owner", `task-${crypto.randomUUID()}`, {
				product: "测试产品",
				strategy: structuredClone(strategy),
				observation: {},
				rules,
			});
			const session = await decisions.startSession({
				requestId: crypto.randomUUID(),
				ownerId: "owner",
				taskRef: { taskId: task.taskId, taskVersion: task.version },
				recipient: { accountId: "account-a", kind: "user", externalId: "user-a" },
				allowedActorIds: ["user-a"],
				strategy: structuredClone(strategy),
				limits,
				signal,
				expiresAt: "2026-02-01T00:00:00.000Z",
			});
			await decisions.prepareRound(session.id, 0);
			const action = (
				await storage.transaction((tx) => tx.actions.all())
			).find((item) => item.roundId === `${session.id}:1`);
			assert.ok(action);
			const inbox = await decisions.receiveChoice({
				sourceId: "console:owner",
				eventId: `event-${session.id}`,
				actionRef: action.id,
				actor: { kind: "console", userId: "owner" },
			});
			await decisions.processInbox(inbox.id);
			return { task, session };
		},
	};
}

test("accepting a candidate with a validation plan creates a pending check and a due job", async () => {
	const fixture = setup();
	const { task, session } = await fixture.start();
	const check = await fixture.storage.transaction((tx) =>
		tx.validationChecks.get(`${session.id}:1`),
	);
	assert.ok(check);
	assert.equal(check.status, "pending");
	assert.equal(check.ownerId, "owner");
	assert.equal(check.taskId, task.taskId);
	assert.equal(check.taskVersion, task.version);
	assert.equal(check.hypothesis, "节前备货需求上升");
	assert.equal(check.validationPlan, "观察 7 天咨询成本是否回落");
	assert.equal(check.dueAt, DUE);

	const jobs = await fixture.storage.transaction((tx) => tx.jobs.all());
	const dueJob = jobs.find((job) => job.task.kind === "evaluate_validation_check");
	assert.ok(dueJob);
	assert.equal(dueJob.runAt, DUE);
	assert.equal(dueJob.status, "pending");
});

test("no check is created without a complete metric contract, a plan, or an actual change", async () => {
	const withoutPlan = candidate();
	delete withoutPlan.validationPlan;
	for (const options of [
		{ rules: {} },
		{ candidate: withoutPlan },
		{ candidate: candidate({ changes: [] }) },
	]) {
		const fixture = setup(options as Parameters<typeof setup>[0]);
		const { session } = await fixture.start(options.rules ?? completeRules);
		const check = await fixture.storage.transaction((tx) =>
			tx.validationChecks.get(`${session.id}:1`),
		);
		assert.equal(check, null);
	}
});

test("due evaluation records only threshold outcomes and never rewrites the strategy", async () => {
	const fixture = setup();
	const { task, session } = await fixture.start();
	const before = await fixture.storage.transaction((tx) =>
		tx.sessions.get(session.id),
	);
	fixture.advanceToDue();
	await fixture.storage.transaction((tx) =>
		tx.comparisonResults.put({
			id: "comparison-1",
			ownerId: "owner",
			taskId: task.taskId,
			current: {
				evidenceId: "evidence-1",
				version: 1,
				taskId: task.taskId,
				taskVersion: task.version,
			},
			rulesRef: { taskId: task.taskId, version: task.version },
			evaluatorVersion: 1,
			status: "comparable",
			canComparePeriods: false,
			canEvaluateCurrentThreshold: true,
			comparisons: {},
			thresholdEvaluation: {
				status: "exceeded",
				metricKey: "cost_per_consultation",
			},
			reasons: [],
			followUpIds: [],
			createdAt: DUE,
		}),
	);
	await fixture.checks.evaluate(`${session.id}:1`);
	const check = await fixture.storage.transaction((tx) =>
		tx.validationChecks.get(`${session.id}:1`),
	);
	assert.ok(check);
	assert.equal(check.status, "observed");
	assert.equal(check.observedOutcome, "above_threshold");
	assert.equal(check.comparisonResultId, "comparison-1");
	assert.deepEqual(check.evidenceRef, { evidenceId: "evidence-1", version: 1 });
	const after = await fixture.storage.transaction((tx) =>
		tx.sessions.get(session.id),
	);
	assert.deepEqual(after?.strategy, before?.strategy, "evaluation never changes the strategy");
});

test("missing or stale comparison evidence is recorded as inconclusive with a reason", async () => {
	const missing = setup();
	const first = await missing.start();
	missing.advanceToDue();
	await missing.checks.evaluate(`${first.session.id}:1`);
	let check = await missing.storage.transaction((tx) =>
		tx.validationChecks.get(`${first.session.id}:1`),
	);
	assert.ok(check);
	assert.equal(check.status, "inconclusive");
	assert.equal(check.reason, "no_comparable_evidence");

	const stale = setup();
	const second = await stale.start();
	await stale.storage.transaction(async (tx) => {
		const task = await tx.tasks.get(second.task.taskId);
		assert.ok(task);
		await tx.tasks.put({ ...task, currentVersion: task.currentVersion + 1 });
	});
	stale.advanceToDue();
	await stale.checks.evaluate(`${second.session.id}:1`);
	check = await stale.storage.transaction((tx) =>
		tx.validationChecks.get(`${second.session.id}:1`),
	);
	assert.ok(check);
	assert.equal(check.status, "inconclusive");
	assert.equal(check.reason, "task_version_changed");
});

test("the worker evaluates due checks and next round receives them as read-only context", async () => {
	const storage = new MemoryStorage();
	let clock = START;
	const now = () => clock;
	const seen: Array<Parameters<PolicyEngine["propose"]>[0]> = [];
	const policy: PolicyEngine = {
		async propose(context) {
			seen.push(structuredClone(context));
			return {
				card: {
					title: "复核",
					summary: "仅调整方案草案",
					evidence: [{ label: "CPC", value: "2 → 2.4" }],
				},
				candidates:
					context.roundNo === 1
						? [candidate()]
						: [{ id: "ack", label: "确认已阅", changes: [], complete: true }],
			};
		},
	};
	const decisions = new Orchestrator(storage, policy, now);
	const checks = new ValidationCheckService(storage, now);
	const worker = new Worker(
		storage,
		decisions,
		new Map(),
		now,
		5,
		undefined,
		undefined,
		undefined,
		30_000,
		undefined,
		undefined,
		3_600_000,
		undefined,
		checks,
	);
	const task = await new TaskService(storage, now).create("owner", "task-worker", {
		product: "测试产品",
		strategy: structuredClone(strategy),
		observation: {},
		rules: completeRules,
	});
	const session = await decisions.startSession({
		requestId: crypto.randomUUID(),
		ownerId: "owner",
		taskRef: { taskId: task.taskId, taskVersion: task.version },
		recipient: { accountId: "account-a", kind: "user", externalId: "user-a" },
		allowedActorIds: ["user-a"],
		strategy: structuredClone(strategy),
		limits,
		signal,
		expiresAt: "2026-02-01T00:00:00.000Z",
	});
	await decisions.prepareRound(session.id, 0);
	const action = (
		await storage.transaction((tx) => tx.actions.all())
	).find((item) => item.roundId === `${session.id}:1`);
	assert.ok(action);
	const inbox = await decisions.receiveChoice({
		sourceId: "console:owner",
		eventId: "event-worker",
		actionRef: action.id,
		actor: { kind: "console", userId: "owner" },
	});
	await decisions.processInbox(inbox.id);
	// 本用例不测渠道投递：清掉待发投递任务，避免它们先于到期评估被领取。
	await storage.transaction(async (tx) => {
		const pendingDeliveryJobs = (await tx.jobs.all())
			.filter(
				(job) =>
					job.task.kind === "send_delivery" ||
					job.task.kind === "send_investigation_decision",
			)
			.map((job) => job.id);
		await tx.jobs.remove(pendingDeliveryJobs);
	});

	// startSession 与接受选择各排队一次 prepare_round；旧版本那次会自行返回。
	for (let index = 0; index < 5 && seen.length < 2; index += 1)
		await worker.runOnce();
	assert.equal(seen.length, 2, "next round policy is called");
	assert.equal(seen[1]?.validationChecks?.length, 1);
	assert.equal(seen[1]?.validationChecks?.[0]?.id, `${session.id}:1`);
	assert.equal(seen[1]?.validationChecks?.[0]?.status, "pending");

	// 本用例只验证到期任务的领取与评估：清掉其它排队任务（含渠道重试）。
	await storage.transaction(async (tx) => {
		const others = (await tx.jobs.all())
			.filter((job) => job.task.kind !== "evaluate_validation_check")
			.map((job) => job.id);
		await tx.jobs.remove(others);
	});
	clock = DUE;
	await worker.runOnce();
	const check = await storage.transaction((tx) =>
		tx.validationChecks.get(`${session.id}:1`),
	);
	assert.ok(check);
	assert.equal(check.status, "inconclusive");
});
