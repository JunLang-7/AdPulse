import { createHash } from "node:crypto";
import {
	calendarSpanDays,
	evaluateEvidenceComparison,
	isFollowUpReason,
} from "./comparisons.js";
import type { Storage } from "./ports/storage.js";
import type {
	ComparisonEvidenceRef,
	ComparisonFollowUp,
	ComparisonOperation,
	ComparisonReason,
	ComparisonResult,
	EvidenceRef,
	EvidenceSource,
	EvidenceVersion,
	TaskVersion,
} from "./state/model.js";

export interface EvidenceComparisonRequest {
	current: EvidenceRef;
	baseline?: EvidenceRef;
}
export type FollowUpMaterial =
	| { kind: "evidence"; evidenceId: string; version: number }
	| { kind: "task_version"; taskId: string; version: number };
export interface FollowUpResolutionRequest {
	material: FollowUpMaterial;
}

export class ComparisonValidationError extends Error {}
export class ComparisonConflictError extends Error {}

const canonicalJson = (value: unknown): string =>
	JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.keys(item)
					.sort()
					.reduce<Record<string, unknown>>((result, child) => {
						result[child] = item[child];
						return result;
					}, {})
			: item,
	);
const digest = (value: unknown): string =>
	createHash("sha256").update(canonicalJson(value)).digest("hex");
const operationId = (
	ownerId: string,
	operation: ComparisonOperation["operation"],
	key: string,
): string => JSON.stringify([ownerId, operation, key]);
const validRef = (ref: EvidenceRef | undefined): ref is EvidenceRef =>
	Boolean(
		ref &&
		typeof ref.evidenceId === "string" &&
		ref.evidenceId.trim() &&
		Number.isSafeInteger(ref.version) &&
		ref.version > 0,
	);

function exactSource(
	sources: EvidenceSource[],
	evidence: EvidenceVersion,
): Pick<EvidenceSource["source"], "platform" | "accountRef"> | undefined {
	const matching = sources.filter(
		(source) =>
			source.evidenceId === evidence.evidenceId &&
			source.evidenceVersion === evidence.version &&
			source.ownerId === evidence.ownerId,
	);
	const identities = new Set(
		matching.map((source) =>
			JSON.stringify([source.source.platform, source.source.accountRef]),
		),
	);
	if (identities.size !== 1) return undefined;
	const source = matching[0]?.source;
	return source
		? { platform: source.platform, accountRef: source.accountRef }
		: undefined;
}

function asComparisonRef(evidence: EvidenceVersion): ComparisonEvidenceRef {
	return {
		evidenceId: evidence.evidenceId,
		version: evidence.version,
		taskId: evidence.taskId,
		taskVersion: evidence.taskVersion,
	};
}

function validEvidenceForReason(
	reason: ComparisonReason,
	evidence: EvidenceVersion,
): boolean {
	if (
		evidence.period.completeness !== "complete" ||
		(evidence.callbackStatus !== "complete" &&
			evidence.callbackStatus !== "not_applicable")
	)
		return false;
	const metrics =
		reason.metric === "spendMinor"
			? ["spendMinor"]
			: reason.metric === "consultations"
				? ["consultations"]
				: ["spendMinor", "consultations"];
	return metrics.every((key) => {
		const value = evidence.values[key as "spendMinor" | "consultations"];
		return (
			Object.hasOwn(evidence.values, key) &&
				value !== undefined &&
				value !== null &&
				Number.isSafeInteger(value) &&
				value >= 0
		);
	});
}

function followUpSpec(
	ownerId: string,
	result: ComparisonResult,
	reason: ComparisonReason,
	current: EvidenceVersion,
	baseline: EvidenceVersion | undefined,
	currentSource: ReturnType<typeof exactSource>,
	baselineSource: ReturnType<typeof exactSource>,
): Omit<ComparisonFollowUp, "id" | "dedupKey" | "status" | "comparisonResultIds" | "events" | "createdAt" | "updatedAt"> & { dedupKey: string } {
	const isRule = reason.remediation.action === "revise_task_rules";
	const isMissingBaseline = reason.code === "NO_BASELINE";
	let target: EvidenceVersion | undefined;
	if (reason.evidenceRef) {
		target = [current, baseline].find(
			(item) =>
				item !== undefined &&
				item.evidenceId === reason.evidenceRef?.evidenceId &&
				item.version === reason.evidenceRef?.version,
		);
	}
	if (!target && !isMissingBaseline && !isRule && baseline)
		target = baseline;
	const anchor = isMissingBaseline
		? current
		: target === current
			? baseline
			: current;
	const pairRepair = [
		"SOURCE_MISSING",
		"METRICS_CONTRACT_MISMATCH",
		"CURRENCY_MISMATCH",
		"ATTRIBUTION_MISMATCH",
		"TIME_ZONE_MISMATCH",
		"PERIOD_INVALID",
		"PERIOD_OVERLAP",
		"PERIOD_NOT_ADJACENT",
		"DURATION_MISMATCH",
	].includes(reason.code);
	const expectedRelation: ComparisonFollowUp["expectedRelation"] =
		isMissingBaseline || (pairRepair && target !== current && Boolean(baseline))
			? "previous_adjacent"
			: pairRepair && target === current && Boolean(baseline)
				? "adjacent_pair"
				: "same_period";
	const context = target ?? current;
	const scope = {
		planRef: context.scope.planRef,
		campaignRefs: [...context.scope.campaignRefs].sort(),
	};
	const source =
		(target === baseline ? baselineSource : currentSource) ??
		(isMissingBaseline ? currentSource : undefined);
	const period =
		expectedRelation === "same_period" && !pairRepair
			? {
					startsAt: context.period.startsAt,
					endsAt: context.period.endsAt,
					timeZone: context.period.timeZone,
				}
			: undefined;
	const evidenceRef =
		isMissingBaseline || isRule || !target
			? undefined
			: { evidenceId: target.evidenceId, version: target.version };
	const anchorEvidenceRef = anchor
		? { evidenceId: anchor.evidenceId, version: anchor.version }
		: undefined;
	const sourceRef = source
		? { platform: source.platform, accountRef: source.accountRef }
		: undefined;
	const dedupKey = canonicalJson({
		ownerId,
		taskId: result.taskId,
		taskVersion: result.rulesRef.version,
		reasonCode: reason.code,
		axis: reason.axis,
		metric: reason.metric ?? null,
		source: sourceRef ?? null,
		scope,
		period: period ?? {
			anchorStartsAt: context.period.startsAt,
			anchorEndsAt: context.period.endsAt,
			anchorTimeZone: context.period.timeZone,
		},
		expectedRelation,
	});
	return {
		ownerId,
		taskId: result.taskId,
		taskVersion: result.rulesRef.version,
		reasonCode: reason.code,
		axis: reason.axis,
		remediation: reason.remediation,
		...(reason.metric ? { metric: reason.metric } : {}),
		...(evidenceRef ? { evidenceRef } : {}),
		...(anchorEvidenceRef ? { anchorEvidenceRef } : {}),
		resolutionKind: isRule ? "task_version" : "evidence",
		...(sourceRef ? { source: sourceRef } : {}),
		expectedRelation,
		...(reason.code === "SAMPLE_BELOW_MINIMUM"
			? {
					...(typeof reason.details?.minimumSpendMinor === "number"
						? { minimumSpendMinor: reason.details.minimumSpendMinor }
						: {}),
					...(typeof reason.details?.minimumConsultations === "number"
						? { minimumConsultations: reason.details.minimumConsultations }
						: {}),
				}
			: {}),
		...(scope ? { scope } : {}),
		...(period ? { period } : {}),
		dedupKey,
	};
}

function sameRef(left: EvidenceRef | undefined, right: EvidenceRef): boolean {
	return Boolean(
		left && left.evidenceId === right.evidenceId && left.version === right.version,
	);
}

/** Owner-scoped, immutable comparison runs and deduplicated verification work. */
export class ComparisonService {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly id: () => string = () => crypto.randomUUID(),
	) {}

	async evaluate(
		ownerId: string,
		key: string,
		input: EvidenceComparisonRequest,
	): Promise<ComparisonResult> {
		if (!ownerId || !key.trim() || !validRef(input?.current) || (input.baseline && !validRef(input.baseline)))
			throw new ComparisonValidationError("invalid comparison request");
		const requestDigest = digest(input);
		return this.storage.transaction(async (tx) => {
			const opId = operationId(ownerId, "evaluate", key);
			const existing = await tx.comparisonOperations.get(opId);
			if (existing) {
				if (existing.digest !== requestDigest)
					throw new ComparisonConflictError("idempotency conflict");
				if (!existing.resultId) throw new Error("comparison operation result missing");
				const saved = await tx.comparisonResults.get(existing.resultId);
				if (!saved) throw new Error("comparison result unavailable");
				return saved;
			}
			const current = await tx.evidenceVersions.get(
				`${input.current.evidenceId}:${input.current.version}`,
			);
			if (!current || current.ownerId !== ownerId)
				throw new ComparisonValidationError("evidence not found");
			const baseline = input.baseline
				? await tx.evidenceVersions.get(
						`${input.baseline.evidenceId}:${input.baseline.version}`,
					)
				: null;
			if (input.baseline && (!baseline || baseline.ownerId !== ownerId))
				throw new ComparisonValidationError("evidence not found");
			const task = await tx.tasks.get(current.taskId);
			if (!task || task.ownerId !== ownerId)
				throw new ComparisonValidationError("task not found");
			const rules = await tx.taskVersions.get(`${current.taskId}:${current.taskVersion}`);
			if (!rules)
				throw new ComparisonValidationError("task version not found");
			const sources = await tx.evidenceSources.all();
			const currentSource = exactSource(sources, current);
			const baselineSource = baseline ? exactSource(sources, baseline) : undefined;
			const evaluation = evaluateEvidenceComparison({
				current,
				...(currentSource ? { currentSource } : {}),
				...(baseline ? { baseline } : {}),
				...(baselineSource ? { baselineSource } : {}),
				rules: rules.rules,
			});
			const createdAt = this.now();
			const result: ComparisonResult = {
				id: `cmp_${this.id()}`,
				ownerId,
				taskId: current.taskId,
				current: asComparisonRef(current),
				...(baseline ? { baseline: asComparisonRef(baseline) } : {}),
				rulesRef: { taskId: rules.taskId, version: rules.version },
				evaluatorVersion: 1,
				...evaluation,
				followUpIds: [],
				createdAt,
			};
			const followUpIds: string[] = [];
			for (const item of result.reasons.filter(isFollowUpReason)) {
				const spec = followUpSpec(
					ownerId,
					result,
					item,
					current,
					baseline ?? undefined,
					currentSource,
					baselineSource,
				);
				const id = `fu_${digest(spec.dedupKey).slice(0, 40)}`;
				let followUp = await tx.comparisonFollowUps.get(id);
				if (followUp) {
					const repeated = followUp.comparisonResultIds.includes(result.id);
					const reactivated = followUp.status === "completed";
					followUp = {
						...followUp,
						status: "open",
						updatedAt: createdAt,
						comparisonResultIds: repeated
							? followUp.comparisonResultIds
							: [...followUp.comparisonResultIds, result.id],
						events: [
							...followUp.events,
							{
								type: reactivated ? "reopened" : "observed",
								at: createdAt,
								resultId: result.id,
							},
						],
					};
				} else {
					followUp = {
						id,
						dedupKey: spec.dedupKey,
						ownerId: spec.ownerId,
						taskId: spec.taskId,
						taskVersion: spec.taskVersion,
						reasonCode: spec.reasonCode,
						axis: spec.axis,
						remediation: spec.remediation,
						...(spec.metric ? { metric: spec.metric } : {}),
						...(spec.evidenceRef ? { evidenceRef: spec.evidenceRef } : {}),
						...(spec.anchorEvidenceRef ? { anchorEvidenceRef: spec.anchorEvidenceRef } : {}),
						resolutionKind: spec.resolutionKind,
						...(spec.source ? { source: spec.source } : {}),
						...(spec.expectedRelation ? { expectedRelation: spec.expectedRelation } : {}),
						...(spec.minimumSpendMinor === undefined ? {} : { minimumSpendMinor: spec.minimumSpendMinor }),
						...(spec.minimumConsultations === undefined ? {} : { minimumConsultations: spec.minimumConsultations }),
						...(spec.scope ? { scope: spec.scope } : {}),
						...(spec.period ? { period: spec.period } : {}),
						status: "open",
						comparisonResultIds: [result.id],
						events: [{ type: "opened", at: createdAt, resultId: result.id }],
						createdAt,
						updatedAt: createdAt,
					};
				}
				await tx.comparisonFollowUps.put(followUp);
				followUpIds.push(id);
			}
			result.followUpIds = [...new Set(followUpIds)].sort();
			await tx.comparisonResults.put(result);
			await tx.comparisonOperations.put({
				id: opId,
				ownerId,
				operation: "evaluate",
				key,
				digest: requestDigest,
				resultId: result.id,
			});
			return result;
		});
	}

	async listResultsForTask(
		ownerId: string,
		taskId: string,
	): Promise<ComparisonResult[]> {
		return this.storage.transaction(async (tx) => {
			const task = await tx.tasks.get(taskId);
			if (!task || task.ownerId !== ownerId)
				throw new ComparisonValidationError("task not found");
			return (await tx.comparisonResults.all())
				.filter((item) => item.ownerId === ownerId && item.taskId === taskId)
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		});
	}

	async listFollowUpsForTask(
		ownerId: string,
		taskId: string,
	): Promise<ComparisonFollowUp[]> {
		return this.storage.transaction(async (tx) => {
			const task = await tx.tasks.get(taskId);
			if (!task || task.ownerId !== ownerId)
				throw new ComparisonValidationError("task not found");
			return (await tx.comparisonFollowUps.all())
				.filter((item) => item.ownerId === ownerId && item.taskId === taskId)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		});
	}

	async resolveFollowUp(
		ownerId: string,
		followUpId: string,
		key: string,
		input: FollowUpResolutionRequest,
	): Promise<ComparisonFollowUp> {
		if (
			!ownerId ||
			!followUpId ||
			!key.trim() ||
			!input?.material ||
			(input.material.kind === "evidence" &&
				(!input.material.evidenceId ||
					!Number.isSafeInteger(input.material.version) ||
					input.material.version < 1)) ||
			(input.material.kind === "task_version" &&
				(!input.material.taskId ||
					!Number.isSafeInteger(input.material.version) ||
					input.material.version < 1))
		)
			throw new ComparisonValidationError("invalid follow-up resolution");
		const requestDigest = digest({ followUpId, ...input });
		return this.storage.transaction(async (tx) => {
			const opId = operationId(ownerId, "resolve_follow_up", key);
			const existing = await tx.comparisonOperations.get(opId);
			if (existing) {
				if (existing.digest !== requestDigest)
					throw new ComparisonConflictError("idempotency conflict");
				const saved = existing.followUpId
					? await tx.comparisonFollowUps.get(existing.followUpId)
					: null;
				if (!saved) throw new Error("follow-up resolution unavailable");
				return saved;
			}
			const followUp = await tx.comparisonFollowUps.get(followUpId);
			if (!followUp || followUp.ownerId !== ownerId)
				throw new ComparisonValidationError("follow-up not found");
			if (followUp.resolutionKind !== input.material.kind)
				throw new ComparisonValidationError("material type does not match follow-up");
			if (followUp.status === "completed")
				throw new ComparisonConflictError("follow-up already completed");
			let material: NonNullable<ComparisonFollowUp["events"][number]["material"]>;
			if (input.material.kind === "evidence") {
				const evidence = await tx.evidenceVersions.get(
					`${input.material.evidenceId}:${input.material.version}`,
				);
				if (
					!evidence ||
					evidence.createdAt <= followUp.createdAt ||
					evidence.ownerId !== ownerId ||
					evidence.taskId !== followUp.taskId ||
					!validEvidenceForReason(
						{
							code: followUp.reasonCode,
							axis: followUp.axis,
							...(followUp.metric ? { metric: followUp.metric } : {}),
							remediation: {
								action: "provide_evidence",
								completionCriteria: "matching_complete_evidence_version",
							},
						},
						evidence,
					)
				)
					throw new ComparisonValidationError("evidence does not satisfy follow-up");
				if (
					followUp.scope &&
					(followUp.scope.planRef !== evidence.scope.planRef ||
						canonicalJson([...followUp.scope.campaignRefs].sort()) !==
							canonicalJson([...evidence.scope.campaignRefs].sort()))
				)
					throw new ComparisonValidationError("evidence scope does not satisfy follow-up");
				if (
					followUp.period &&
					(followUp.period.startsAt !== evidence.period.startsAt ||
						followUp.period.endsAt !== evidence.period.endsAt ||
						followUp.period.timeZone !== evidence.period.timeZone)
				)
					throw new ComparisonValidationError("evidence period does not satisfy follow-up");
				if (
					(followUp.minimumSpendMinor !== undefined &&
						evidence.values.spendMinor! < followUp.minimumSpendMinor) ||
					(followUp.minimumConsultations !== undefined &&
						evidence.values.consultations! < followUp.minimumConsultations) ||
					(followUp.remediation.completionCriteria === "source_confirms_zero" &&
						evidence.values.consultations !== 0)
				)
					throw new ComparisonValidationError("evidence sample does not satisfy follow-up");
				if (followUp.expectedRelation === "same_period" && followUp.evidenceRef) {
					const original = await tx.evidenceVersions.get(
						`${followUp.evidenceRef.evidenceId}:${followUp.evidenceRef.version}`,
					);
					if (
						!original ||
						original.ownerId !== ownerId ||
						original.taskId !== followUp.taskId ||
						canonicalJson(original.currency) !== canonicalJson(evidence.currency) ||
						canonicalJson(original.metricsContract) !== canonicalJson(evidence.metricsContract) ||
						canonicalJson(original.attribution) !== canonicalJson(evidence.attribution)
					)
						throw new ComparisonValidationError("evidence contract does not satisfy follow-up");
				}
				const sources = await tx.evidenceSources.all();
				const evidenceSource = exactSource(sources, evidence);
				if (!evidenceSource)
					throw new ComparisonValidationError("evidence provenance is missing");
				if (
					followUp.source &&
					(followUp.source.platform !== evidenceSource.platform ||
						followUp.source.accountRef !== evidenceSource.accountRef)
				)
					throw new ComparisonValidationError("evidence account does not satisfy follow-up");
				const anchor = followUp.anchorEvidenceRef
					? await tx.evidenceVersions.get(
							`${followUp.anchorEvidenceRef.evidenceId}:${followUp.anchorEvidenceRef.version}`,
						)
					: null;
				if (
					followUp.expectedRelation !== "same_period" &&
					(!anchor ||
						(followUp.expectedRelation === "previous_adjacent"
							? evidence.period.endsAt !== anchor.period.startsAt
							: evidence.period.startsAt !== anchor.period.endsAt) ||
						evidence.period.timeZone !== anchor.period.timeZone ||
						calendarSpanDays(evidence) === null ||
						calendarSpanDays(evidence) !== calendarSpanDays(anchor))
				)
					throw new ComparisonValidationError("evidence period relation does not satisfy follow-up");
				if (anchor) {
					if (anchor.ownerId !== ownerId || anchor.taskId !== followUp.taskId)
						throw new ComparisonValidationError("follow-up anchor is unavailable");
					const currentEvidence =
						Date.parse(evidence.period.startsAt) >
						Date.parse(anchor.period.startsAt)
							? evidence
							: anchor;
					const baselineEvidence = currentEvidence === evidence ? anchor : evidence;
					const currentSource = exactSource(sources, currentEvidence);
					const baselineSource = exactSource(sources, baselineEvidence);
					const validation = evaluateEvidenceComparison({
						current: currentEvidence,
						...(currentSource ? { currentSource } : {}),
						baseline: baselineEvidence,
						...(baselineSource ? { baselineSource } : {}),
						rules: {},
					});
					const pairMismatch = validation.reasons.some((item) =>
						[
							"TASK_MISMATCH",
							"SOURCE_MISSING",
							"ACCOUNT_MISMATCH",
							"SCOPE_MISMATCH",
							"METRICS_CONTRACT_MISMATCH",
							"CURRENCY_MISMATCH",
							"ATTRIBUTION_MISMATCH",
							"TIME_ZONE_MISMATCH",
							"PERIOD_INVALID",
							"PERIOD_OVERLAP",
							"PERIOD_NOT_ADJACENT",
							"DURATION_MISMATCH",
						].includes(item.code),
					);
					if (pairMismatch)
						throw new ComparisonValidationError("evidence pair does not satisfy follow-up");
				}
				material = {
					kind: "evidence",
					evidenceId: evidence.evidenceId,
					version: evidence.version,
				};
			} else {
				if (input.material.taskId !== followUp.taskId)
					throw new ComparisonValidationError("task version does not satisfy follow-up");
				const version = await tx.taskVersions.get(
					`${input.material.taskId}:${input.material.version}`,
				);
				if (
					!version ||
					!(await tx.tasks.get(version.taskId)) ||
					(await tx.tasks.get(version.taskId))?.ownerId !== ownerId ||
					!canResolveRules(followUp, version, await tx.evidenceVersions.get(
						`${followUp.anchorEvidenceRef?.evidenceId}:${followUp.anchorEvidenceRef?.version}`,
					))
				)
					throw new ComparisonValidationError("task rules do not satisfy follow-up");
				material = { kind: "task_version", taskId: version.taskId, version: version.version };
			}
			const at = this.now();
			const completed: ComparisonFollowUp = {
				...followUp,
				status: "completed",
				updatedAt: at,
				events: [...followUp.events, { type: "completed", at, material }],
			};
			await tx.comparisonFollowUps.put(completed);
			await tx.comparisonOperations.put({
				id: opId,
				ownerId,
				operation: "resolve_follow_up",
				key,
				digest: requestDigest,
				followUpId,
			});
			return completed;
		});
	}
}

function canResolveRules(
	followUp: ComparisonFollowUp,
	task: TaskVersion,
	evidence: EvidenceVersion | null,
): boolean {
	return Boolean(
		evidence &&
		evidence.ownerId === followUp.ownerId &&
		evidence.taskId === followUp.taskId &&
		evidence.createdAt <= followUp.createdAt &&
		task.version > followUp.taskVersion &&
		task.createdAt > followUp.createdAt &&
		task.rules.metricKey === "cost_per_consultation" &&
		task.rules.alertThresholdMinor !== undefined &&
		task.rules.currency === evidence.currency.code &&
		task.rules.unit === evidence.currency.minorUnit &&
		task.rules.statWindowDays !== undefined &&
		task.rules.statWindowDays > 0 &&
		task.rules.statWindowDays === calendarSpanDays(evidence) &&
		task.rules.minimumSpendMinor !== undefined &&
		task.rules.minimumConsultations !== undefined
	);
}
