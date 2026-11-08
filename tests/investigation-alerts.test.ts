import assert from "node:assert/strict";
import test from "node:test";
import {
	ComparisonService,
	EvidenceService,
	InvestigationAlertService,
	Orchestrator,
	TaskService,
	Worker,
	type EvidenceImportRecord,
	type TaskInput,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

const rules = (maxPushRounds?: number): TaskInput["rules"] => ({
	metricKey: "cost_per_consultation",
	metricDefinition: "单次咨询成本",
	currency: "CNY",
	unit: "分",
	statWindowDays: 1,
	alertThresholdMinor: 100,
	minimumSpendMinor: 0,
	minimumConsultations: 0,
	...(maxPushRounds === undefined ? {} : { maxPushRounds }),
});
const taskInput = (maxPushRounds?: number): TaskInput => ({
	product: "产品 A",
	strategy: {
		objective: "获取咨询",
		audience: ["山东企业"],
		channels: { ads: {} },
		sellingPoints: [],
	},
	observation: {},
	rules: rules(maxPushRounds),
});
const record = (
	spendMinor: number,
	reportRef: string,
	rawSpend = String(spendMinor),
): EvidenceImportRecord => ({
	source: {
		platform: "web-report",
		accountRef: "account-1",
		reportRef,
	},
	scope: { planRef: "plan-1", campaignRefs: ["campaign-1"] },
	period: {
		startsAt: "2026-01-01T00:00:00+08:00",
		endsAt: "2026-01-02T00:00:00+08:00",
		timeZone: "Asia/Shanghai",
		completeness: "complete",
	},
	metricsContract: {
		spendMinor: {
			definition: "消耗金额",
			formula: "原始消耗换算为分",
			sourceField: "spend",
		},
		consultations: {
			definition: "咨询数",
			formula: "报表咨询数",
			sourceField: "consultations",
		},
	},
	currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
	attribution: { model: "click", windowDays: 7 },
	callbackStatus: "complete",
	rawValues: { spend: rawSpend, consultations: 10 },
	values: { spendMinor, consultations: 10 },
});

async function setup(options: {
	maxPushRounds?: number;
	spendMinor?: number;
	endsAt?: string;
	handlingDeadlineHours?: number;
} = {}) {
	let now = "2026-01-03T00:00:00.000Z";
	let id = 0;
	const clock = () => now;
	const storage = new MemoryStorage();
	const tasks = new TaskService(storage, clock, () => "task-1");
	const input = taskInput(options.maxPushRounds);
	if (options.endsAt !== undefined) input.observation.endsAt = options.endsAt;
	if (options.handlingDeadlineHours !== undefined)
		input.rules.handlingDeadlineHours = options.handlingDeadlineHours;
	const task = await tasks.create("owner", "task-create", input);
	const evidence = new EvidenceService(storage, clock);
	const imported = await evidence.import("owner", "evidence-import", {
		schemaVersion: 1,
		taskRef: { taskId: task.taskId, taskVersion: 1 },
		records: [record(options.spendMinor ?? 2_000, "report-1")],
	});
	const evidenceRef = imported[0];
	assert.ok(evidenceRef);
	const comparisons = new ComparisonService(storage, clock, () => `comparison-${++id}`);
	const alerts = new InvestigationAlertService(storage, clock);
	const comparison = await comparisons.evaluate("owner", "compare-1", {
		current: { evidenceId: evidenceRef.evidenceId, version: evidenceRef.version },
	});
	const orchestrator = new Orchestrator(
		storage,
		{ async propose() { throw new Error("Web alert must not invoke the policy engine"); } },
		clock,
		() => `action-${++id}`,
	);
	const worker = new Worker(storage, orchestrator, new Map(), clock, 3, alerts);
	return {
		storage,
		task,
		tasks,
		evidence,
		comparisons,
		alerts,
		comparison,
		worker,
		orchestrator,
		clock,
		setTime(value: string) { now = value; },
	};
}

async function listAlerts(storage: MemoryStorage) {
	return storage.transaction((tx) => tx.investigationAlerts.all());
}

async function prepareOneWebCandidate(context: Awaited<ReturnType<typeof setup>>) {
	const alert = await context.alerts.evaluateComparison("owner", context.comparison.id);
	assert.ok(alert);
	assert.equal(alert.status, "open");
	assert.equal(await context.worker.runOnce(), true); // prepare alert session
	const session = await context.storage.transaction((tx) => tx.sessions.get(alert.sessionId));
	assert.ok(session);
	assert.equal(session.deliveryMode, "web");
	assert.equal(session.recipient, undefined);
	assert.equal(session.expiresAt, undefined);
	assert.deepEqual(session.allowedActorIds, []);
	assert.equal(await context.worker.runOnce(), true); // prepare fixed Web candidate
	const refreshed = await context.storage.transaction((tx) => tx.sessions.get(alert.sessionId));
	assert.ok(refreshed);
	assert.equal(refreshed.status, "awaiting_input");
	const rounds = await context.storage.transaction((tx) => tx.rounds.all());
	const round = rounds.find((item) => item.sessionId === alert.sessionId);
	assert.ok(round);
	assert.equal(round.candidates.length, 3);
	assert.ok(round.expiresAt);
	const deliveries = await context.storage.transaction((tx) => tx.deliveries.all());
	assert.equal(deliveries.length, 0);
	const alerts = await listAlerts(context.storage);
	assert.equal(alerts[0]?.logicalRounds, 1);
	return { alert: alerts[0]!, session: refreshed, round };
}

test("strict current threshold creates one Web-only alert without a baseline", async () => {
	const context = await setup();
	assert.equal(context.comparison.status, "missing_baseline");
	assert.equal(context.comparison.canEvaluateCurrentThreshold, true);
	assert.equal(context.comparison.thresholdEvaluation.status, "exceeded");
	const alert = await context.alerts.evaluateComparison("owner", context.comparison.id);
	assert.ok(alert);
	assert.equal(alert.status, "open");
	assert.equal(alert.current.comparisonStatus, "missing_baseline");
	assert.equal(alert.current.canComparePeriods, false);
	assert.equal(alert.maxPushRounds, 1);
	assert.equal(alert.logicalRounds, 0);
	assert.equal(alert.current.spendMinor, 2_000);
	assert.equal(alert.current.consultations, 10);

	const duplicate = await context.alerts.evaluateComparison("owner", context.comparison.id);
	assert.equal(duplicate?.id, alert.id);
	assert.equal((await listAlerts(context.storage)).length, 1);
	const jobs = await context.storage.transaction((tx) => tx.jobs.all());
	assert.equal(jobs.filter((job) => job.task.kind === "prepare_investigation_alert_session").length, 1);
});

test("threshold is strict; equality does not create an alert", async () => {
	const context = await setup({ spendMinor: 1_000 });
	assert.equal(context.comparison.thresholdEvaluation.status, "not_exceeded");
	assert.equal(await context.alerts.evaluateComparison("owner", context.comparison.id), null);
	assert.equal((await listAlerts(context.storage)).length, 0);
});

test("worker prepares a fixed Web-only candidate without policy or channel delivery and recovers idempotently", async () => {
	const context = await setup();
	const first = await context.alerts.evaluateComparison("owner", context.comparison.id);
	assert.ok(first);
	assert.equal(await context.worker.runOnce(), true);
	await context.alerts.prepareSession(first.id);
	await context.alerts.prepareSession(first.id);
	const session = await context.storage.transaction((tx) => tx.sessions.get(first.sessionId));
	assert.ok(session);
	assert.equal(session.investigationAlertId, first.id);
	const roundJobs = await context.storage.transaction(async (tx) =>
		(await tx.jobs.all()).filter((job) => job.task.kind === "prepare_round" && job.task.sessionId === first.sessionId),
	);
	assert.equal(roundJobs.length, 1);
	context.setTime("2026-01-03T04:00:00.000Z");
	assert.equal(await context.worker.runOnce(), true);
	const refreshed = await context.storage.transaction((tx) => tx.sessions.get(first.sessionId));
	assert.ok(refreshed);
	assert.equal(refreshed.status, "awaiting_input");
	assert.equal(refreshed.deliveryMode, "web");
	const rounds = await context.storage.transaction((tx) => tx.rounds.all());
	const round = rounds.find((item) => item.sessionId === first.sessionId);
	assert.ok(round);
	assert.equal(round.candidates.length, 3);
	assert.equal(round.expiresAt, "2026-01-04T04:00:00.000Z");
	context.setTime("2026-01-03T05:00:00.000Z");
	await context.alerts.prepareSession(first.id);
	await context.orchestrator.prepareRound(first.sessionId, 0);
	assert.equal((await context.storage.transaction((tx) => tx.rounds.get(round.id)))?.expiresAt, round.expiresAt);
	assert.equal((await context.storage.transaction((tx) => tx.deliveries.all())).length, 0);
	assert.equal((await listAlerts(context.storage))[0]?.logicalRounds, 1);
});

test("decision actions expire exactly at an earlier task cutoff", async () => {
	const context = await setup({
		endsAt: "2026-01-03T14:00:00+08:00",
		handlingDeadlineHours: 1,
	});
	const { alert, round, session } = await prepareOneWebCandidate(context);
	assert.equal(round.expiresAt, "2026-01-03T06:00:00.000Z");
	assert.equal(alert.current.handlingDeadlineHours, 1);
	const choiceAction = await context.storage.transaction(async (tx) =>
		(await tx.actions.all()).find((action) => action.roundId === round.id),
	);
	assert.ok(choiceAction);
	context.setTime(round.expiresAt);
	const inbox = await context.orchestrator.receiveChoice({
		sourceId: "console",
		eventId: "at-task-cutoff",
		actionRef: choiceAction.id,
		actor: { kind: "console", userId: "owner" },
	});
	assert.equal(await context.worker.runOnce(), true);
	const state = await context.storage.transaction(async (tx) => ({
		inbox: await tx.inbox.get(inbox.id),
		round: await tx.rounds.get(round.id),
		session: await tx.sessions.get(session.id),
	}));
	assert.equal(state.inbox?.status, "rejected");
	assert.equal(state.inbox?.reason, "expired");
	assert.equal(state.round?.status, "open");
	assert.equal(state.session?.version, session.version);
});

test("an existing earlier session cutoff bounds a newly frozen candidate", async () => {
	const context = await setup({ endsAt: "2026-01-03T06:00:00.000Z" });
	const alert = await context.alerts.evaluateComparison("owner", context.comparison.id);
	assert.ok(alert);
	assert.equal(await context.worker.runOnce(), true);
	await context.storage.transaction(async (tx) => {
		const session = await tx.sessions.get(alert.sessionId);
		assert.ok(session);
		await tx.sessions.put({ ...session, expiresAt: "2026-01-03T04:00:00.000Z" });
	});
	assert.equal(await context.worker.runOnce(), true);
	const round = await context.storage.transaction((tx) => tx.rounds.get(alert.sessionId + ":1"));
	assert.equal(round?.expiresAt, "2026-01-03T04:00:00.000Z");
});

test("a task cutoff reached while preparing creates no candidate and consumes no round", async () => {
	const context = await setup({ endsAt: "2026-01-03T06:00:00.000Z" });
	const alert = await context.alerts.evaluateComparison("owner", context.comparison.id);
	assert.ok(alert);
	assert.equal(await context.worker.runOnce(), true);
	context.setTime("2026-01-03T06:00:00.000Z");
	assert.equal(await context.worker.runOnce(), true);
	const state = await context.storage.transaction(async (tx) => ({
		alert: await tx.investigationAlerts.get(alert.id),
		session: await tx.sessions.get(alert.sessionId),
		rounds: await tx.rounds.all(),
		actions: await tx.actions.all(),
	}));
	assert.equal(state.alert?.status, "stale");
	assert.equal(state.alert?.statusReason, "decision_deadline_elapsed");
	assert.equal(state.alert?.logicalRounds, 0);
	assert.equal(state.session?.status, "stale");
	assert.equal(state.rounds.length, 0);
	assert.equal(state.actions.length, 0);
});

test("legacy rounds use their recorded freeze on either side of the 24-hour boundary", async () => {
	for (const [time, status] of [
		["2026-01-04T02:59:59.999Z", "processed"],
		["2026-01-04T03:00:00.000Z", "rejected"],
	] as const) {
		const context = await setup();
		const { round, session } = await prepareOneWebCandidate(context);
		const legacy = { ...round };
		delete legacy.expiresAt;
		const frozenAt = "2026-01-03T03:00:00.000Z";
		await context.storage.transaction(async (tx) => {
			await tx.rounds.put(legacy);
			const alert = (await tx.investigationAlerts.all())[0];
			assert.ok(alert);
			await tx.investigationAlerts.put({
				...alert,
				events: alert.events.map((event) =>
					event.type === "candidate_created" ? { ...event, at: frozenAt } : event),
			});
		});
		assert.notEqual(frozenAt, session.createdAt);
		const choiceAction = await context.storage.transaction(async (tx) =>
			(await tx.actions.all()).find((action) => action.roundId === round.id),
		);
		assert.ok(choiceAction);
		context.setTime(time);
		const inbox = await context.orchestrator.receiveChoice({
			sourceId: "console",
			eventId: "expired-legacy-choice",
			actionRef: choiceAction.id,
			actor: { kind: "console", userId: "owner" },
		});
		assert.equal(await context.worker.runOnce(), true);
		const result = await context.storage.transaction((tx) => tx.inbox.get(inbox.id));
		assert.equal(result?.status, status);
		assert.equal(result?.reason, status === "rejected" ? "expired" : undefined);
	}
});

test("evidence revisions invalidate open candidates and only reevaluation can consume another logical round", async () => {
	const context = await setup({ maxPushRounds: 2 });
	const { alert, session, round } = await prepareOneWebCandidate(context);
	const choiceAction = await context.storage.transaction(async (tx) =>
		(await tx.actions.all()).find((action) => action.roundId === round.id && action.optionId === "await_evidence"),
	);
	assert.ok(choiceAction);
	const channelAttempt = await context.orchestrator.receiveChoice({
		sourceId: "channel",
		eventId: "channel-cannot-control-web-alert",
		actionRef: choiceAction.id,
		actor: { kind: "platform", accountId: "account-1", externalId: "user-1" },
	});
	assert.equal(await context.worker.runOnce(), true);
	assert.equal((await context.storage.transaction((tx) => tx.inbox.get(channelAttempt.id)))?.status, "rejected");
	await context.orchestrator.receiveChoice({
		sourceId: "console",
		eventId: "choice-await-evidence",
		actionRef: choiceAction.id,
		actor: { kind: "console", userId: "owner" },
	});
	assert.equal(await context.worker.runOnce(), true);
	let storedAlert = (await listAlerts(context.storage))[0]!;
	assert.equal(storedAlert.status, "awaiting_evidence");
	assert.equal((await context.storage.transaction((tx) => tx.sessions.get(session.id)))?.status, "completed");

	const head = await context.storage.transaction((tx) => tx.evidenceHeads.get(alert.current.evidence.evidenceId));
	assert.ok(head);
	await context.evidence.revise("owner", head.id, "revise-evidence-2", {
		expectedEvidenceVersion: 1,
		reason: "updated report values",
		record: record(2_100, "report-1", "21.00 updated"),
	});
	storedAlert = (await listAlerts(context.storage))[0]!;
	assert.equal(storedAlert.status, "stale");
	context.setTime("2026-01-04T01:00:00.000Z");
	const revised = await context.comparisons.evaluate("owner", "compare-2", {
		current: { evidenceId: head.id, version: 2 },
	});
	const reevaluated = await context.alerts.evaluateComparison("owner", revised.id);
	assert.ok(reevaluated);
	assert.equal(reevaluated.status, "open");
	assert.equal(reevaluated.logicalRounds, 1);
	assert.equal(await context.worker.runOnce(), true);
	storedAlert = (await listAlerts(context.storage))[0]!;
	assert.equal(storedAlert.logicalRounds, 2);
	assert.equal(storedAlert.current.evidence.version, 2);
	const nextRound = await context.storage.transaction((tx) => tx.rounds.get(session.id + ":2"));
	assert.equal(nextRound?.expiresAt, "2026-01-05T01:00:00.000Z");

	const notNewEvidence = await context.comparisons.evaluate("owner", "compare-2b", {
		current: { evidenceId: head.id, version: 2 },
	});
	const unchanged = await context.alerts.evaluateComparison("owner", notNewEvidence.id);
	assert.equal(unchanged?.logicalRounds, 2);
	assert.equal(unchanged?.status, "open");
});

test("default one-round cap prevents another card even after updated evidence is explicitly evaluated", async () => {
	const context = await setup();
	const { alert } = await prepareOneWebCandidate(context);
	const head = await context.storage.transaction((tx) => tx.evidenceHeads.get(alert.current.evidence.evidenceId));
	assert.ok(head);
	await context.evidence.revise("owner", head.id, "revise-evidence-default-cap", {
		expectedEvidenceVersion: 1,
		reason: "updated report values",
		record: record(2_100, "report-1", "21.00 updated"),
	});
	const updatedResult = await context.comparisons.evaluate("owner", "compare-updated", {
		current: { evidenceId: head.id, version: 2 },
	});
	const capped = await context.alerts.evaluateComparison("owner", updatedResult.id);
	assert.equal(capped?.status, "capped");
	assert.equal(capped?.logicalRounds, 1);
	assert.equal(capped?.current.evidence.version, 2);
	assert.equal((await context.storage.transaction((tx) => tx.rounds.all())).filter((item) => item.sessionId === alert.sessionId).length, 1);
	assert.ok(capped?.events.some((event) => event.type === "capped"));
});

test("worker retries alert-session preparation after failure without duplicating session or round jobs", async () => {
	const context = await setup();
	const alert = await context.alerts.evaluateComparison("owner", context.comparison.id);
	assert.ok(alert);
	let failOnce = true;
	const flakyAlerts = {
		prepareSession: async (alertId: string) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("transient preparation failure");
			}
			await context.alerts.prepareSession(alertId);
		},
	};
	const worker = new Worker(
		context.storage,
		context.orchestrator,
		new Map(),
		context.clock,
		3,
		flakyAlerts as unknown as InvestigationAlertService,
	);
	assert.equal(await worker.runOnce(), true);
	assert.equal((await context.storage.transaction((tx) => tx.sessions.all())).length, 0);
	context.setTime("2026-01-03T00:00:03.000Z");
	assert.equal(await worker.runOnce(), true);
	assert.equal((await context.storage.transaction((tx) => tx.sessions.all())).length, 1);
	assert.equal(await worker.runOnce(), true);
	const sessions = await context.storage.transaction((tx) => tx.sessions.all());
	const rounds = await context.storage.transaction((tx) => tx.rounds.all());
	const jobs = await context.storage.transaction((tx) => tx.jobs.all());
	assert.equal(sessions.length, 1);
	assert.equal(rounds.filter((round) => round.sessionId === alert.sessionId).length, 1);
	assert.equal(jobs.filter((job) => job.task.kind === "prepare_round" && job.task.sessionId === alert.sessionId).length, 1);
});

test("task-rule version changes invalidate active alert candidates and rounds", async () => {
	const context = await setup();
	const { alert, session, round } = await prepareOneWebCandidate(context);
	await context.tasks.revise("owner", context.task.taskId, 1, "task-rules-revision", taskInput());
	const updated = (await listAlerts(context.storage))[0]!;
	assert.equal(updated.id, alert.id);
	assert.equal(updated.status, "stale");
	assert.equal(updated.statusReason, "task_rules_revised_requires_new_evidence");
	assert.equal((await context.storage.transaction((tx) => tx.sessions.get(session.id)))?.status, "stale");
	assert.equal((await context.storage.transaction((tx) => tx.rounds.get(round.id)))?.status, "invalidated");
});

test("updated evidence below threshold clears the same logical alert without another candidate", async () => {
	const context = await setup();
	const { alert } = await prepareOneWebCandidate(context);
	const head = await context.storage.transaction((tx) => tx.evidenceHeads.get(alert.current.evidence.evidenceId));
	assert.ok(head);
	await context.evidence.revise("owner", head.id, "revise-below-threshold", {
		expectedEvidenceVersion: 1,
		reason: "corrected lower spend",
		record: record(500, "report-1", "5.00 corrected"),
	});
	const updatedResult = await context.comparisons.evaluate("owner", "compare-below-threshold", {
		current: { evidenceId: head.id, version: 2 },
	});
	assert.equal(updatedResult.thresholdEvaluation.status, "not_exceeded");
	const cleared = await context.alerts.evaluateComparison("owner", updatedResult.id);
	assert.equal(cleared?.id, alert.id);
	assert.equal(cleared?.status, "cleared");
	assert.equal(cleared?.current.evidence.version, 2);
	assert.ok(cleared?.events.some((event) => event.type === "cleared"));
	assert.equal((await context.storage.transaction((tx) => tx.rounds.all())).filter((round) => round.sessionId === alert.sessionId).length, 1);
});

test("evidence revision invalidates stale candidates, rounds, and sessions transactionally", async () => {
	const context = await setup();
	const { alert, session, round } = await prepareOneWebCandidate(context);
	const head = await context.storage.transaction((tx) => tx.evidenceHeads.get(alert.current.evidence.evidenceId));
	assert.ok(head);
	await context.evidence.revise("owner", head.id, "revise-before-choice", {
		expectedEvidenceVersion: 1,
		reason: "corrected report",
		record: record(2_050, "report-1", "20.50 corrected"),
	});
	const updated = await listAlerts(context.storage);
	assert.equal(updated[0]?.status, "stale");
	assert.equal((await context.storage.transaction((tx) => tx.sessions.get(session.id)))?.status, "stale");
	assert.equal((await context.storage.transaction((tx) => tx.rounds.get(round.id)))?.status, "invalidated");
});
