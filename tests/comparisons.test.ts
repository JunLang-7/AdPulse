import assert from "node:assert/strict";
import test from "node:test";
import {
	ComparisonService,
	ComparisonValidationError,
	EvidenceService,
	TaskService,
	evaluateEvidenceComparison,
} from "../packages/core/dist/index.js";
import type {
	EvidenceImportRecord,
	EvidenceVersion,
	TaskInput,
	TaskVersion,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

const rules: TaskInput["rules"] = {
	metricKey: "cost_per_consultation",
	currency: "CNY",
	unit: "分",
	statWindowDays: 1,
	alertThresholdMinor: 100,
	minimumSpendMinor: 0,
	minimumConsultations: 0,
};
const taskInput = (ruleOverrides: TaskInput["rules"] = rules): TaskInput => ({
	product: "产品 A",
	strategy: {
		objective: "获取咨询",
		audience: ["山东企业"],
		channels: { ads: {} },
		sellingPoints: [],
	},
	observation: {},
	rules: ruleOverrides,
});
const record = (
	startsAt: string,
	endsAt: string,
	values: EvidenceImportRecord["values"] = {
		spendMinor: 1_000,
		consultations: 10,
	},
	overrides: Partial<EvidenceImportRecord> = {},
): EvidenceImportRecord => ({
	source: {
		platform: "web-report",
		accountRef: "account-1",
		reportRef: `${startsAt}-report`,
	},
	scope: { planRef: "plan-1", campaignRefs: ["campaign-1"] },
	period: {
		startsAt,
		endsAt,
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
	rawValues: { spend: "10.00", consultations: 10 },
	values,
	...overrides,
});

async function setup(options: { taskRules?: TaskInput["rules"] } = {}) {
	let clock = "2026-01-01T00:00:00.000Z";
	let nextId = 0;
	const now = () => clock;
	const storage = new MemoryStorage();
	const tasks = new TaskService(storage, now, () => "task-1");
	const task = await tasks.create(
		"owner",
		"task-create",
		taskInput(options.taskRules ?? rules),
	);
	const evidence = new EvidenceService(storage, now);
	const comparisons = new ComparisonService(storage, now, () => `id-${++nextId}`);
	return {
		storage,
		task,
		tasks,
		evidence,
		comparisons,
		setTime(value: string) {
			clock = value;
		},
		async importRecord(
			key: string,
			item: EvidenceImportRecord,
			taskVersion = 1,
		) {
			const [result] = await evidence.import("owner", key, {
				schemaVersion: 1,
				taskRef: { taskId: task.taskId, taskVersion },
				records: [item],
			});
			assert.ok(result);
			const detail = await evidence.get("owner", result.evidenceId);
			assert.ok(detail);
			return detail.versions.find((item) => item.version === result.version)!;
		},
	};
}

const baselineRecord = () =>
	record("2026-01-01T00:00:00+08:00", "2026-01-02T00:00:00+08:00");
const currentRecord = (
	values: EvidenceImportRecord["values"] = {
		spendMinor: 1_000,
		consultations: 10,
	},
) =>
	record("2026-01-02T00:00:00+08:00", "2026-01-03T00:00:00+08:00", values);

async function comparablePair() {
	const context = await setup();
	const baseline = await context.importRecord("baseline", baselineRecord());
	const current = await context.importRecord("current", currentRecord());
	return { ...context, baseline, current };
}

test("comparison eligibility checks strict metadata, complete equal adjacent periods, and callback quality", async () => {
	const { current, baseline } = await comparablePair();
	const source = { platform: "web-report", accountRef: "account-1" };
	const cases: Array<{
		name: string;
		baseline?: EvidenceVersion;
		current?: EvidenceVersion;
		currentSource?: typeof source;
		baselineSource?: typeof source;
		expectedStatus: string;
		expectedReason: string;
	}> = [
		{
			name: "missing provenance",
			baseline,
			current,
			currentSource: source,
			expectedStatus: "awaiting_supplementation",
			expectedReason: "SOURCE_MISSING",
		},
		{
			name: "account mismatch",
			baseline,
			current,
			currentSource: source,
			baselineSource: { ...source, accountRef: "other-account" },
			expectedStatus: "incomparable",
			expectedReason: "ACCOUNT_MISMATCH",
		},
		{
			name: "scope mismatch",
			baseline: { ...baseline, scope: { ...baseline.scope, planRef: "other-plan" } },
			current,
			currentSource: source,
			baselineSource: source,
			expectedStatus: "incomparable",
			expectedReason: "SCOPE_MISMATCH",
		},
		{
			name: "metric formula mismatch",
			baseline: {
				...baseline,
				metricsContract: {
					...baseline.metricsContract,
					spendMinor: { ...baseline.metricsContract.spendMinor, formula: "other" },
				},
			},
			current,
			currentSource: source,
			baselineSource: source,
			expectedStatus: "incomparable",
			expectedReason: "METRICS_CONTRACT_MISMATCH",
		},
		{
			name: "currency mismatch",
			baseline: { ...baseline, currency: { ...baseline.currency, code: "USD" } },
			current,
			currentSource: source,
			baselineSource: source,
			expectedStatus: "incomparable",
			expectedReason: "CURRENCY_MISMATCH",
		},
		{
			name: "attribution mismatch",
			baseline: { ...baseline, attribution: { model: "view", windowDays: 7 } },
			current,
			currentSource: source,
			baselineSource: source,
			expectedStatus: "incomparable",
			expectedReason: "ATTRIBUTION_MISMATCH",
		},
		{
			name: "time zone mismatch",
			baseline: { ...baseline, period: { ...baseline.period, timeZone: "UTC" } },
			current,
			currentSource: source,
			baselineSource: source,
			expectedStatus: "incomparable",
			expectedReason: "TIME_ZONE_MISMATCH",
		},
		{
			name: "overlapping period",
			baseline: {
				...baseline,
				period: { ...baseline.period, startsAt: current.period.startsAt, endsAt: current.period.endsAt },
			},
			current,
			currentSource: source,
			baselineSource: source,
			expectedStatus: "incomparable",
			expectedReason: "PERIOD_OVERLAP",
		},
		{
			name: "non-adjacent period",
			baseline: {
				...baseline,
				period: {
					...baseline.period,
					startsAt: "2025-12-30T00:00:00+08:00",
					endsAt: "2025-12-31T00:00:00+08:00",
				},
			},
			current,
			currentSource: source,
			baselineSource: source,
			expectedStatus: "incomparable",
			expectedReason: "PERIOD_NOT_ADJACENT",
		},
		{
			name: "duration mismatch",
			current: {
				...current,
				period: { ...current.period, endsAt: "2026-01-04T00:00:00+08:00" },
			},
			baseline,
			currentSource: source,
			baselineSource: source,
			expectedStatus: "incomparable",
			expectedReason: "DURATION_MISMATCH",
		},
		{
			name: "partial window",
			baseline: { ...baseline, period: { ...baseline.period, completeness: "partial" } },
			current,
			currentSource: source,
			baselineSource: source,
			expectedStatus: "awaiting_supplementation",
			expectedReason: "PERIOD_INCOMPLETE",
		},
		{
			name: "pending callback",
			baseline: { ...baseline, callbackStatus: "pending" },
			current,
			currentSource: source,
			baselineSource: source,
			expectedStatus: "awaiting_supplementation",
			expectedReason: "CALLBACK_PENDING",
		},
		{
			name: "known zero is not missing",
			baseline: { ...baseline, values: { spendMinor: 0, consultations: 0 } },
			current,
			currentSource: source,
			baselineSource: source,
			expectedStatus: "temporarily_uncomputable",
			expectedReason: "ZERO_DENOMINATOR",
		},
	];
	for (const item of cases) {
		const result = evaluateEvidenceComparison({
			current: item.current ?? current,
			...(item.currentSource ? { currentSource: item.currentSource } : {}),
			...(item.baseline ? { baseline: item.baseline } : {}),
			...(item.baselineSource ? { baselineSource: item.baselineSource } : {}),
			rules,
		});
		assert.equal(result.status, item.expectedStatus, item.name);
		assert.ok(
			result.reasons.some((reason) => reason.code === item.expectedReason),
			`${item.name}: ${item.expectedReason}`,
		);
	}
});

test("reason table preserves missing, null, invalid and incomplete rule states", async () => {
	const { current, baseline } = await comparablePair();
	const noMetric = { ...rules };
	delete noMetric.metricKey;
	const noThreshold = { ...rules };
	delete noThreshold.alertThresholdMinor;
	const { minimumConsultations: _minimumConsultations, ...noMinimum } = rules;
	const cases: Array<{
		name: string;
		current?: EvidenceVersion;
		baseline?: EvidenceVersion;
		rules?: TaskVersion["rules"];
		code: string;
	}> = [
		{
			name: "missing current spend",
			current: { ...current, values: { consultations: 10 } },
			baseline,
			rules,
			code: "VALUE_MISSING",
		},
		{
			name: "null current spend",
			current: { ...current, values: { spendMinor: null, consultations: 10 } },
			baseline,
			rules,
			code: "VALUE_NULL",
		},
		{
			name: "invalid current count",
			current: { ...current, values: { spendMinor: 1_000, consultations: -1 } },
			baseline,
			rules,
			code: "VALUE_INVALID",
		},
		{ name: "metric rule absent", current, baseline, rules: noMetric, code: "RULE_METRIC_MISSING" },
		{ name: "threshold absent", current, baseline, rules: noThreshold, code: "RULE_THRESHOLD_MISSING" },
		{ name: "currency mismatch", current, baseline, rules: { ...rules, currency: "USD" }, code: "RULE_CURRENCY_MISMATCH" },
		{ name: "unit mismatch", current, baseline, rules: { ...rules, unit: "dollar" }, code: "RULE_UNIT_MISMATCH" },
		{ name: "window mismatch", current, baseline, rules: { ...rules, statWindowDays: 2 }, code: "WINDOW_MISMATCH" },
		{
			name: "minimum sample missing",
			current,
			baseline,
			rules: noMinimum,
			code: "RULE_MINIMUMS_MISSING",
		},
		{
			name: "sample below confirmed minimum",
			current,
			baseline,
			rules: { ...rules, minimumSpendMinor: 1_001 },
			code: "SAMPLE_BELOW_MINIMUM",
		},
	];
	for (const item of cases) {
		const result = evaluateEvidenceComparison({
			current: item.current ?? current,
			baseline: item.baseline ?? baseline,
			rules: item.rules ?? rules,
			currentSource: { platform: "web-report", accountRef: "account-1" },
			baselineSource: { platform: "web-report", accountRef: "account-1" },
		});
		assert.ok(result.reasons.some((reason) => reason.code === item.code), item.name);
		assert.equal(result.canEvaluateCurrentThreshold, false, item.name);
	}
	const zeroMinimum = evaluateEvidenceComparison({
		current,
		baseline,
		currentSource: { platform: "web-report", accountRef: "account-1" },
		baselineSource: { platform: "web-report", accountRef: "account-1" },
		rules: { ...rules, minimumSpendMinor: 0, minimumConsultations: 0 },
	});
	assert.equal(zeroMinimum.reasons.some((reason) => reason.code === "SAMPLE_BELOW_MINIMUM"), false);
});

test("threshold is strict greater-than and uses integer-safe ratios; missing baseline is independent", async () => {
	const equal = await comparablePair();
	const equalResult = await equal.comparisons.evaluate("owner", "equal", {
		current: { evidenceId: equal.current.evidenceId, version: equal.current.version },
	});
	assert.equal(equalResult.status, "missing_baseline");
	assert.equal(equalResult.canComparePeriods, false);
	assert.equal(equalResult.canEvaluateCurrentThreshold, true);
	assert.equal(equalResult.thresholdEvaluation.status, "not_exceeded");
	assert.ok(equalResult.reasons.some((reason) => reason.code === "NO_BASELINE"));

	const above = await setup();
	const exactLarge: TaskVersion["rules"] = {
		...rules,
		alertThresholdMinor: 900_719_925_474_000,
	};
	await above.tasks.revise("owner", "task-1", 1, "rules", taskInput(exactLarge));
	const current = await above.importRecord(
		"large",
		currentRecord({
			spendMinor: 9_007_199_254_740_000,
			consultations: 10,
		}),
		2,
	);
	const exact = await above.comparisons.evaluate("owner", "large-equal", {
		current: { evidenceId: current.evidenceId, version: current.version },
	});
	assert.equal(exact.thresholdEvaluation.status, "not_exceeded");
	assert.equal(exact.thresholdEvaluation.value?.denominatorConsultations, 10);

	const thresholdTask = await setup();
	const increased = await thresholdTask.importRecord(
		"increased",
		currentRecord({ spendMinor: 1_001, consultations: 10 }),
	);
	const exceeded = await thresholdTask.comparisons.evaluate("owner", "above", {
		current: { evidenceId: increased.evidenceId, version: increased.version },
	});
	assert.equal(exceeded.thresholdEvaluation.status, "exceeded");
});

test("zero denominator is known zero and never produces Infinity", async () => {
	const context = await setup();
	const current = await context.importRecord(
		"zero",
		currentRecord({ spendMinor: 0, consultations: 0 }),
	);
	const result = await context.comparisons.evaluate("owner", "zero-eval", {
		current: { evidenceId: current.evidenceId, version: current.version },
	});
	assert.equal(result.status, "missing_baseline");
	assert.equal(result.canEvaluateCurrentThreshold, false);
	assert.equal(result.thresholdEvaluation.status, "not_evaluated");
	assert.ok(result.reasons.some((reason) => reason.code === "ZERO_DENOMINATOR"));
	assert.equal(result.reasons.some((reason) => reason.code === "VALUE_MISSING"), false);
	assert.equal(JSON.stringify(result).includes("Infinity"), false);
});

test("follow-ups deduplicate by gap, validate explicitly linked evidence, reopen, and preserve immutable results", async () => {
	const context = await setup();
	const current = await context.importRecord("current", currentRecord());
	const staleBaseline = await context.importRecord(
		"stale-baseline",
		record("2026-01-01T00:00:00+08:00", "2026-01-02T00:00:00+08:00", undefined, {
			source: { platform: "web-report", accountRef: "account-1", reportRef: "stale-report" },
		}),
	);
	context.setTime("2026-01-03T00:00:00.000Z");
	const currentRef = { evidenceId: current.evidenceId, version: current.version };
	const first = await context.comparisons.evaluate("owner", "missing-1", { current: currentRef });
	const second = await context.comparisons.evaluate("owner", "missing-2", { current: currentRef });
	assert.notEqual(first.id, second.id);
	assert.deepEqual(first.current, second.current);
	const followUps = await context.comparisons.listFollowUpsForTask("owner", "task-1");
	const missingBaseline = followUps.find((item) => item.reasonCode === "NO_BASELINE");
	assert.ok(missingBaseline);
	assert.equal(missingBaseline.comparisonResultIds.length, 2);
	await assert.rejects(
		context.comparisons.resolveFollowUp("owner", missingBaseline.id, "stale", {
			material: { kind: "evidence", evidenceId: staleBaseline.evidenceId, version: staleBaseline.version },
		}),
		(error: unknown) => error instanceof ComparisonValidationError,
	);
	assert.equal(missingBaseline.events.filter((event) => event.type === "opened").length, 1);
	assert.equal(missingBaseline.events.filter((event) => event.type === "observed").length, 1);

	context.setTime("2026-01-04T00:00:00.000Z");
	const baseline = await context.evidence.revise(
		"owner",
		staleBaseline.evidenceId,
		"fresh-baseline",
		{
			expectedEvidenceVersion: staleBaseline.version,
			reason: "补充完整基线版本",
			record: baselineRecord(),
		},
	);
	await assert.rejects(
		context.comparisons.resolveFollowUp("owner", missingBaseline.id, "bad", {
			material: { kind: "evidence", evidenceId: baseline.evidenceId, version: 99 },
		}),
		(error: unknown) => error instanceof ComparisonValidationError,
	);
	const completed = await context.comparisons.resolveFollowUp(
		"owner",
		missingBaseline.id,
		"resolve-good",
		{ material: { kind: "evidence", evidenceId: baseline.evidenceId, version: baseline.version } },
	);
	assert.equal(completed.status, "completed");
	assert.equal(completed.events.at(-1)?.type, "completed");
	assert.deepEqual(completed.events.at(-1)?.material, {
		kind: "evidence",
		evidenceId: baseline.evidenceId,
		version: baseline.version,
	});

	const reopened = await context.comparisons.evaluate("owner", "missing-3", {
		current: currentRef,
	});
	assert.equal(reopened.followUpIds.includes(missingBaseline.id), true);
	const afterReopen = (await context.comparisons.listFollowUpsForTask("owner", "task-1")).find(
		(item) => item.id === missingBaseline.id,
	);
	assert.equal(afterReopen?.status, "open");
	assert.equal(afterReopen?.events.at(-1)?.type, "reopened");
	const history = await context.comparisons.listResultsForTask("owner", "task-1");
	assert.deepEqual(history.map((item) => item.id), [first.id, second.id, reopened.id]);
	assert.equal(history[0]?.followUpIds.includes(missingBaseline.id), true);
	assert.equal(history[0]?.baseline, undefined);
});

test("period-window mismatches require a new matching task-rule version", async () => {
	const context = await setup({ taskRules: { ...rules, statWindowDays: 2 } });
	const current = await context.importRecord("current", currentRecord());
	context.setTime("2026-01-03T00:00:00.000Z");
	await context.comparisons.evaluate("owner", "window-eval", {
		current: { evidenceId: current.evidenceId, version: current.version },
	});
	const followUp = (await context.comparisons.listFollowUpsForTask("owner", "task-1"))
		.find((item) => item.reasonCode === "WINDOW_MISMATCH");
	assert.ok(followUp);
	assert.equal(followUp.resolutionKind, "task_version");
	context.setTime("2026-01-04T00:00:00.000Z");
	const revised = await context.tasks.revise(
		"owner",
		"task-1",
		1,
		"window-revision",
		taskInput({ ...rules, statWindowDays: 1 }),
	);
	const completed = await context.comparisons.resolveFollowUp(
		"owner",
		followUp.id,
		"window-resolve",
		{ material: { kind: "task_version", taskId: "task-1", version: revised.version } },
	);
	assert.equal(completed.status, "completed");
});

test("a qualifying newer task version is required to resolve rule follow-ups", async () => {
	const incompleteRules: TaskInput["rules"] = { minimumSpendMinor: 0 };
	const context = await setup({ taskRules: incompleteRules });
	const current = await context.importRecord("current", currentRecord());
	context.setTime("2026-01-03T00:00:00.000Z");
	await context.comparisons.evaluate("owner", "rules-eval", {
		current: { evidenceId: current.evidenceId, version: current.version },
	});
	const followUps = await context.comparisons.listFollowUpsForTask("owner", "task-1");
	const threshold = followUps.find((item) => item.reasonCode === "RULE_THRESHOLD_MISSING");
	assert.ok(threshold);
	assert.equal(threshold.resolutionKind, "task_version");
	await assert.rejects(
		context.comparisons.resolveFollowUp("owner", threshold.id, "old", {
			material: { kind: "task_version", taskId: "task-1", version: 1 },
		}),
		(error: unknown) => error instanceof ComparisonValidationError,
	);
	context.setTime("2026-01-04T00:00:00.000Z");
	const revised = await context.tasks.revise(
		"owner",
		"task-1",
		1,
		"rules-revision",
		taskInput(rules),
	);
	const completed = await context.comparisons.resolveFollowUp(
		"owner",
		threshold.id,
		"resolve-rule",
		{ material: { kind: "task_version", taskId: "task-1", version: revised.version } },
	);
	assert.equal(completed.status, "completed");
});
