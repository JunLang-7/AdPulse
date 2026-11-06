import type {
	ComparisonAxis,
	ComparisonMetric,
	ComparisonReason,
	ComparisonReasonCode,
	ComparisonStatus,
	EvidenceRef,
	EvidenceSource,
	EvidenceVersion,
	TaskVersion,
} from "./state/model.js";

export interface ComparisonEvaluationInput {
	current: EvidenceVersion;
	currentSource?: Pick<EvidenceSource["source"], "platform" | "accountRef">;
	baseline?: EvidenceVersion;
	baselineSource?: Pick<EvidenceSource["source"], "platform" | "accountRef">;
	rules: TaskVersion["rules"];
}

export interface ComparisonEvaluation {
	status: ComparisonStatus;
	canComparePeriods: boolean;
	canEvaluateCurrentThreshold: boolean;
	comparisons: {
		spendMinor?: { baseline: number; current: number; delta: number };
		consultations?: { baseline: number; current: number; delta: number };
		costPerConsultation?: {
			baseline: { numeratorMinor: number; denominatorConsultations: number };
			current: { numeratorMinor: number; denominatorConsultations: number };
			direction: "increased" | "decreased" | "unchanged";
		};
	};
	thresholdEvaluation: {
		status: "exceeded" | "not_exceeded" | "not_evaluated";
		metricKey?: "cost_per_consultation";
		value?: { numeratorMinor: number; denominatorConsultations: number };
		thresholdMinor?: number;
		currency?: string;
	};
	reasons: ComparisonReason[];
}

const own = (value: object, key: PropertyKey): boolean =>
	Object.prototype.hasOwnProperty.call(value, key);

const hardComparisonReasons = new Set<ComparisonReasonCode>([
	"TASK_MISMATCH",
	"ACCOUNT_MISMATCH",
	"SCOPE_MISMATCH",
	"METRICS_CONTRACT_MISMATCH",
	"CURRENCY_MISMATCH",
	"ATTRIBUTION_MISMATCH",
	"TIME_ZONE_MISMATCH",
	"PERIOD_OVERLAP",
	"PERIOD_NOT_ADJACENT",
	"DURATION_MISMATCH",
]);
const awaitingCodes = new Set<ComparisonReasonCode>([
	"SOURCE_MISSING",
	"PERIOD_INVALID",
	"PERIOD_INCOMPLETE",
	"CALLBACK_PENDING",
	"CALLBACK_UNKNOWN",
	"VALUE_MISSING",
	"VALUE_NULL",
	"VALUE_INVALID",
]);
function remediationFor(code: ComparisonReasonCode): ComparisonReason["remediation"] {
	if (code.startsWith("RULE_") || code === "WINDOW_MISMATCH")
		return {
			action: "revise_task_rules",
			completionCriteria: "complete_task_rule_version",
		};
	if (code === "ZERO_DENOMINATOR")
		return { action: "verify_source", completionCriteria: "source_confirms_zero" };
	if (code === "PERIOD_INVALID" || code === "PERIOD_OVERLAP" || code === "PERIOD_NOT_ADJACENT" || code === "DURATION_MISMATCH")
		return {
			action: "provide_evidence",
			completionCriteria: "matching_complete_evidence_version",
		};
	if (code === "SAMPLE_BELOW_MINIMUM")
		return {
			action: "provide_evidence",
			completionCriteria: "matching_complete_evidence_version",
		};
	if (code === "TASK_MISMATCH" || code === "ACCOUNT_MISMATCH" || code === "SCOPE_MISMATCH")
		return { action: "none", completionCriteria: "manual_review" };
	return {
		action: "provide_evidence",
		completionCriteria: "matching_complete_evidence_version",
	};
}

function reason(
	code: ComparisonReasonCode,
	axis: ComparisonAxis,
	options: {
		metric?: ComparisonMetric;
		evidence?: EvidenceVersion;
		details?: ComparisonReason["details"];
	} = {},
): ComparisonReason {
	const result: ComparisonReason = {
		code,
		axis,
		remediation: remediationFor(code),
	};
	if (options.metric) result.metric = options.metric;
	if (options.evidence)
		result.evidenceRef = {
			evidenceId: options.evidence.evidenceId,
			version: options.evidence.version,
		};
	if (options.details) result.details = options.details;
	return result;
}

function metricValue(
	evidence: EvidenceVersion,
	key: "spendMinor" | "consultations",
	axis: ComparisonAxis,
): { valid: boolean; value?: number; reasons: ComparisonReason[] } {
	const value = evidence.values[key];
	if (!own(evidence.values, key) || value === undefined)
		return {
			valid: false,
			reasons: [reason("VALUE_MISSING", axis, { metric: key, evidence })],
		};
	if (value === null)
		return {
			valid: false,
			reasons: [reason("VALUE_NULL", axis, { metric: key, evidence })],
		};
	if (!Number.isSafeInteger(value) || value < 0)
		return {
			valid: false,
			reasons: [
				reason("VALUE_INVALID", axis, {
					metric: key,
					evidence,
					details: { received: value },
				}),
			],
		};
	return { valid: true, value, reasons: [] };
}

function dateParts(
	value: string,
	timeZone: string,
): { day: number; clock: string } | null {
	const instant = Date.parse(value);
	if (!Number.isFinite(instant)) return null;
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		}).formatToParts(new Date(instant));
		const get = (type: string): number =>
			Number(parts.find((part) => part.type === type)?.value);
		const year = get("year");
		const month = get("month");
		const day = get("day");
		const hour = get("hour");
		const minute = get("minute");
		const second = get("second");
		if (![year, month, day, hour, minute, second].every(Number.isFinite))
			return null;
		return {
			day: Math.floor(Date.UTC(year, month - 1, day) / 86_400_000),
			clock: `${hour}:${minute}:${second}.${String(new Date(instant).getUTCMilliseconds()).padStart(3, "0")}`,
		};
	} catch {
		return null;
	}
}

/** Returns local calendar days only for full same-wall-clock boundaries. */
export function calendarSpanDays(evidence: EvidenceVersion): number | null {
	const startInstant = Date.parse(evidence.period.startsAt);
	const endInstant = Date.parse(evidence.period.endsAt);
	if (!Number.isFinite(startInstant) || !Number.isFinite(endInstant) || endInstant <= startInstant)
		return null;
	const start = dateParts(evidence.period.startsAt, evidence.period.timeZone);
	const end = dateParts(evidence.period.endsAt, evidence.period.timeZone);
	if (!start || !end || start.clock !== end.clock || end.day <= start.day)
		return null;
	return end.day - start.day;
}

function comparePeriodMetadata(
	current: EvidenceVersion,
	baseline: EvidenceVersion,
	currentSource: ComparisonEvaluationInput["currentSource"],
	baselineSource: ComparisonEvaluationInput["baselineSource"],
	reasons: ComparisonReason[],
): { valid: boolean; currentDays: number | null; baselineDays: number | null } {
	const add = (code: ComparisonReasonCode, details?: ComparisonReason["details"]) =>
		reasons.push(
			reason(code, "period_comparison", { details, evidence: baseline }),
		);
	if (current.taskId !== baseline.taskId) add("TASK_MISMATCH");
	if (!currentSource || !baselineSource) add("SOURCE_MISSING");
	else if (
		currentSource.platform !== baselineSource.platform ||
		currentSource.accountRef !== baselineSource.accountRef
	)
		add("ACCOUNT_MISMATCH");
	if (
		current.scope.planRef !== baseline.scope.planRef ||
		[...current.scope.campaignRefs].sort().join("\u0000") !==
			[...baseline.scope.campaignRefs].sort().join("\u0000")
	)
		add("SCOPE_MISMATCH");
	for (const metric of ["spendMinor", "consultations"] as const) {
		const left = current.metricsContract[metric];
		const right = baseline.metricsContract[metric];
		if (
			left.definition !== right.definition ||
			left.formula !== right.formula ||
			left.sourceField !== right.sourceField
		)
			add("METRICS_CONTRACT_MISMATCH", { metric });
	}
	if (
		current.currency.code !== baseline.currency.code ||
		current.currency.minorUnit !== baseline.currency.minorUnit ||
		current.currency.minorUnitsPerMajor !== baseline.currency.minorUnitsPerMajor
	)
		add("CURRENCY_MISMATCH");
	if (
		current.attribution.model !== baseline.attribution.model ||
		current.attribution.windowDays !== baseline.attribution.windowDays ||
		own(current.attribution, "windowDays") !== own(baseline.attribution, "windowDays")
	)
		add("ATTRIBUTION_MISMATCH");
	if (current.period.timeZone !== baseline.period.timeZone)
		add("TIME_ZONE_MISMATCH");

	const currentStart = Date.parse(current.period.startsAt);
	const currentEnd = Date.parse(current.period.endsAt);
	const baselineStart = Date.parse(baseline.period.startsAt);
	const baselineEnd = Date.parse(baseline.period.endsAt);
	const currentDays = calendarSpanDays(current);
	const baselineDays = calendarSpanDays(baseline);
	if (
		!Number.isFinite(currentStart) ||
		!Number.isFinite(currentEnd) ||
		!Number.isFinite(baselineStart) ||
			!Number.isFinite(baselineEnd) ||
		currentDays === null ||
		baselineDays === null
	)
		add("PERIOD_INVALID");
	if (
		Number.isFinite(currentStart) &&
		Number.isFinite(currentEnd) &&
		Number.isFinite(baselineStart) &&
		Number.isFinite(baselineEnd) &&
		Math.max(currentStart, baselineStart) < Math.min(currentEnd, baselineEnd)
	)
		add("PERIOD_OVERLAP");
	if (
		Number.isFinite(currentStart) &&
		Number.isFinite(baselineEnd) &&
		baselineEnd !== currentStart
	)
		add("PERIOD_NOT_ADJACENT", {
			baselineEndsAt: baseline.period.endsAt,
			currentStartsAt: current.period.startsAt,
		});
	if (
		currentDays !== null &&
		baselineDays !== null &&
		currentDays !== baselineDays
	)
		add("DURATION_MISMATCH", { baselineDays, currentDays });
	return { valid: reasons.length === 0, currentDays, baselineDays };
}

function addEvidenceQualityReasons(
	evidence: EvidenceVersion,
	axis: ComparisonAxis,
	reasons: ComparisonReason[],
): void {
	if (evidence.period.completeness !== "complete")
		reasons.push(reason("PERIOD_INCOMPLETE", axis, { evidence }));
	if (evidence.callbackStatus === "pending")
		reasons.push(reason("CALLBACK_PENDING", axis, { evidence }));
	else if (evidence.callbackStatus === "unknown")
		reasons.push(reason("CALLBACK_UNKNOWN", axis, { evidence }));
}

function addRequiredValues(
	evidence: EvidenceVersion,
	axis: ComparisonAxis,
	reasons: ComparisonReason[],
): { spend?: number; consultations?: number; valid: boolean } {
	const spend = metricValue(evidence, "spendMinor", axis);
	const consultations = metricValue(evidence, "consultations", axis);
	reasons.push(...spend.reasons, ...consultations.reasons);
	return {
		...(spend.value === undefined ? {} : { spend: spend.value }),
		...(consultations.value === undefined ? {} : { consultations: consultations.value }),
		valid: spend.valid && consultations.valid,
	};
}

function reasonSortKey(item: ComparisonReason): string {
	return [item.axis, item.evidenceRef?.evidenceId ?? "", item.metric ?? "", item.code].join("\u0000");
}

/** Pure, deterministic rules for comparing one explicitly selected pair. */
export function evaluateEvidenceComparison(
	input: ComparisonEvaluationInput,
): ComparisonEvaluation {
	const { current, baseline, rules } = input;
	const reasons: ComparisonReason[] = [];
	const currentAxis: ComparisonAxis = baseline ? "both" : "current_threshold";
	addEvidenceQualityReasons(current, currentAxis, reasons);
	const currentValues = addRequiredValues(current, currentAxis, reasons);

	let baselineValues: ReturnType<typeof addRequiredValues> | undefined;
	if (!baseline) {
		reasons.push(reason("NO_BASELINE", "period_comparison", { evidence: current }));
	} else {
		addEvidenceQualityReasons(baseline, "period_comparison", reasons);
		baselineValues = addRequiredValues(baseline, "period_comparison", reasons);
		comparePeriodMetadata(
			current,
			baseline,
			input.currentSource,
			input.baselineSource,
			reasons,
		);
	}

	const currentSpan = calendarSpanDays(current);
	if (currentSpan === null)
		reasons.push(reason("PERIOD_INVALID", currentAxis, { evidence: current }));

	const addRuleReason = (
		code: ComparisonReasonCode,
		details?: ComparisonReason["details"],
	) => reasons.push(reason(code, "current_threshold", { details }));
	const metricKey: unknown = rules.metricKey;
	if (metricKey === undefined) addRuleReason("RULE_METRIC_MISSING");
	else if (metricKey !== "cost_per_consultation")
		addRuleReason("RULE_METRIC_UNSUPPORTED", { metricKey: String(metricKey) });
	if (rules.alertThresholdMinor === undefined)
		addRuleReason("RULE_THRESHOLD_MISSING");
	if (!rules.currency) addRuleReason("RULE_CURRENCY_MISSING");
	if (!rules.unit) addRuleReason("RULE_UNIT_MISSING");
	if (rules.statWindowDays === undefined || rules.statWindowDays < 1)
		addRuleReason("RULE_WINDOW_MISSING");
	if (
		rules.minimumSpendMinor === undefined ||
		rules.minimumConsultations === undefined
	)
		addRuleReason("RULE_MINIMUMS_MISSING");
	if (rules.currency && rules.currency !== current.currency.code)
		addRuleReason("RULE_CURRENCY_MISMATCH", {
			ruleCurrency: rules.currency,
			evidenceCurrency: current.currency.code,
		});
	if (rules.unit && rules.unit !== current.currency.minorUnit)
		addRuleReason("RULE_UNIT_MISMATCH", {
			ruleUnit: rules.unit,
			evidenceUnit: current.currency.minorUnit,
		});
	if (
		rules.statWindowDays !== undefined &&
		rules.statWindowDays > 0 &&
		currentSpan !== null &&
		rules.statWindowDays !== currentSpan
	)
		addRuleReason("WINDOW_MISMATCH", {
			ruleWindowDays: rules.statWindowDays,
			evidenceWindowDays: currentSpan,
		});
	if (
		currentValues.spend !== undefined &&
		currentValues.consultations !== undefined &&
		((rules.minimumSpendMinor !== undefined &&
			currentValues.spend < rules.minimumSpendMinor) ||
			(rules.minimumConsultations !== undefined &&
				currentValues.consultations < rules.minimumConsultations))
	)
		reasons.push(
			reason("SAMPLE_BELOW_MINIMUM", "current_threshold", {
				evidence: current,
				details: {
					spendMinor: currentValues.spend,
					...(rules.minimumSpendMinor === undefined
						? {}
						: { minimumSpendMinor: rules.minimumSpendMinor }),
					consultations: currentValues.consultations,
					...(rules.minimumConsultations === undefined
						? {}
						: { minimumConsultations: rules.minimumConsultations }),
				},
			}),
		);
	if (currentValues.consultations === 0)
		reasons.push(
			reason("ZERO_DENOMINATOR", currentAxis, {
				metric: "cost_per_consultation",
				evidence: current,
				details: { denominator: 0 },
			}),
		);
	if (baseline && baselineValues?.consultations === 0)
		reasons.push(
			reason("ZERO_DENOMINATOR", "period_comparison", {
				metric: "cost_per_consultation",
				evidence: baseline,
				details: { denominator: 0 },
			}),
		);

	const thresholdBlocked = reasons.some(
		(item) => item.axis === "current_threshold" || item.axis === "both",
	);
	const canEvaluateCurrentThreshold = !thresholdBlocked;
	const thresholdEvaluation: ComparisonEvaluation["thresholdEvaluation"] = {
		status: "not_evaluated",
	};
	if (
		canEvaluateCurrentThreshold &&
		currentValues.spend !== undefined &&
		currentValues.consultations !== undefined &&
		rules.alertThresholdMinor !== undefined &&
		rules.currency
	) {
		const exceeded =
			BigInt(currentValues.spend) >
			BigInt(rules.alertThresholdMinor) * BigInt(currentValues.consultations);
		thresholdEvaluation.status = exceeded ? "exceeded" : "not_exceeded";
		thresholdEvaluation.metricKey = "cost_per_consultation";
		thresholdEvaluation.value = {
			numeratorMinor: currentValues.spend,
			denominatorConsultations: currentValues.consultations,
		};
		thresholdEvaluation.thresholdMinor = rules.alertThresholdMinor;
		thresholdEvaluation.currency = rules.currency;
	}

	const periodReasonCodes = reasons
		.filter((item) => item.axis === "period_comparison" || item.axis === "both")
		.map((item) => item.code);
	let status: ComparisonStatus;
	if (!baseline) status = "missing_baseline";
	else if (periodReasonCodes.some((code) => hardComparisonReasons.has(code)))
		status = "incomparable";
	else if (periodReasonCodes.some((code) => awaitingCodes.has(code)))
		status = "awaiting_supplementation";
	else if (periodReasonCodes.includes("ZERO_DENOMINATOR"))
		status = "temporarily_uncomputable";
	else status = "comparable";

	const canComparePeriods = status === "comparable";
	const comparisons: ComparisonEvaluation["comparisons"] = {};
	if (
		canComparePeriods &&
		baseline &&
		baselineValues?.spend !== undefined &&
		currentValues.spend !== undefined &&
		baselineValues.consultations !== undefined &&
		currentValues.consultations !== undefined
	) {
		comparisons.spendMinor = {
			baseline: baselineValues.spend,
			current: currentValues.spend,
			delta: currentValues.spend - baselineValues.spend,
		};
		comparisons.consultations = {
			baseline: baselineValues.consultations,
			current: currentValues.consultations,
			delta: currentValues.consultations - baselineValues.consultations,
		};
		const oldCross =
			BigInt(baselineValues.spend) * BigInt(currentValues.consultations);
		const newCross =
			BigInt(currentValues.spend) * BigInt(baselineValues.consultations);
		comparisons.costPerConsultation = {
			baseline: {
				numeratorMinor: baselineValues.spend,
				denominatorConsultations: baselineValues.consultations,
			},
			current: {
				numeratorMinor: currentValues.spend,
				denominatorConsultations: currentValues.consultations,
			},
			direction:
				newCross > oldCross
					? "increased"
					: newCross < oldCross
						? "decreased"
						: "unchanged",
		};
	}

	const unique = new Map<string, ComparisonReason>();
	for (const item of reasons) {
		const key = JSON.stringify([
			item.code,
			item.axis,
			item.metric,
			item.evidenceRef?.evidenceId,
			item.evidenceRef?.version,
			item.details,
		]);
		unique.set(key, item);
	}
	const sortedReasons = [...unique.values()].sort((a, b) =>
		reasonSortKey(a).localeCompare(reasonSortKey(b)),
	);
	return {
		status,
		canComparePeriods,
		canEvaluateCurrentThreshold,
		comparisons,
		thresholdEvaluation,
		reasons: sortedReasons,
	};
}

export function evidenceRefMatches(
	left: EvidenceRef | undefined,
	right: EvidenceRef | undefined,
): boolean {
	return Boolean(
		left &&
		right &&
		left.evidenceId === right.evidenceId &&
		left.version === right.version,
	);
}

export function isFollowUpReason(reason: ComparisonReason): boolean {
	return (
		reason.remediation.action === "provide_evidence" ||
		reason.remediation.action === "revise_task_rules"
	);
}

export function canResolveWithEvidence(
	followUp: {
		taskId: string;
		taskVersion: number;
		createdAt: string;
		evidenceRef?: EvidenceRef;
		scope?: { planRef: string; campaignRefs: string[] };
		period?: { startsAt: string; endsAt: string; timeZone: string };
		metric?: ComparisonMetric;
	},
	evidence: EvidenceVersion,
): boolean {
	if (
		evidence.taskId !== followUp.taskId ||
		evidence.createdAt <= followUp.createdAt ||
		evidence.period.completeness !== "complete" ||
		(evidence.callbackStatus !== "complete" &&
			evidence.callbackStatus !== "not_applicable")
	)
		return false;
	if (
		followUp.scope &&
		(followUp.scope.planRef !== evidence.scope.planRef ||
			[...followUp.scope.campaignRefs].sort().join("\u0000") !==
				[...evidence.scope.campaignRefs].sort().join("\u0000"))
	)
		return false;
	if (
		followUp.period &&
		(followUp.period.startsAt !== evidence.period.startsAt ||
			followUp.period.endsAt !== evidence.period.endsAt ||
			followUp.period.timeZone !== evidence.period.timeZone)
	)
		return false;
	const keys: Array<"spendMinor" | "consultations"> =
		followUp.metric === "spendMinor"
			? ["spendMinor"]
			: followUp.metric === "consultations"
				? ["consultations"]
				: ["spendMinor", "consultations"];
	return keys.every((key) => {
		const value = evidence.values[key];
		return (
			own(evidence.values, key) &&
			value !== undefined &&
			value !== null &&
			Number.isSafeInteger(value) &&
			value >= 0
		);
	});
}

export function canResolveWithTaskVersion(
	followUp: { taskId: string; taskVersion: number; createdAt: string },
	task: TaskVersion,
): boolean {
	return (
		task.taskId === followUp.taskId &&
		task.version > followUp.taskVersion &&
		task.createdAt > followUp.createdAt &&
		task.rules.metricKey === "cost_per_consultation" &&
		task.rules.alertThresholdMinor !== undefined &&
		Boolean(task.rules.currency) &&
		Boolean(task.rules.unit) &&
		task.rules.statWindowDays !== undefined &&
		task.rules.statWindowDays > 0 &&
		task.rules.minimumSpendMinor !== undefined &&
		task.rules.minimumConsultations !== undefined
	);
}
