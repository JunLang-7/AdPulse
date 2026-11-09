import { createHash } from "node:crypto";
import type { Storage, Transaction } from "./ports/storage.js";
import type {
	ComparisonEvidenceRef,
	ComparisonReasonCode,
	ComparisonResult,
	EvidenceSource,
	EvidenceVersion,
	InvestigationAlert,
	InvestigationAlertEvidence,
	Session,
	TaskVersion,
} from "./state/model.js";

export class InvestigationAlertValidationError extends Error {}

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
const sameEvidence = (
	left: ComparisonEvidenceRef,
	right: ComparisonEvidenceRef,
): boolean =>
	left.evidenceId === right.evidenceId &&
	left.version === right.version &&
	left.taskVersion === right.taskVersion;

function sourceFor(
	sources: EvidenceSource[],
	evidence: EvidenceVersion,
): EvidenceSource["source"] | undefined {
	const matching = sources.filter(
		(item) =>
			item.ownerId === evidence.ownerId &&
			item.evidenceId === evidence.evidenceId &&
			item.evidenceVersion === evidence.version,
	);
	const identities = new Set(
		matching.map((item) =>
			JSON.stringify([item.source.platform, item.source.accountRef]),
		),
	);
	return identities.size === 1 ? matching[0]?.source : undefined;
}

function evidenceRef(evidence: EvidenceVersion): ComparisonEvidenceRef {
	return {
		evidenceId: evidence.evidenceId,
		version: evidence.version,
		taskId: evidence.taskId,
		taskVersion: evidence.taskVersion,
	};
}

function makeAlertEvidence(
	result: ComparisonResult,
	evidence: EvidenceVersion,
	source: EvidenceSource["source"],
	rules: TaskVersion,
): InvestigationAlertEvidence {
	return {
		comparisonResultId: result.id,
		evidence: evidenceRef(evidence),
		source: { platform: source.platform, accountRef: source.accountRef },
		scope: evidence.scope,
		period: evidence.period,
		metric: "cost_per_consultation",
		metricDefinition: rules.rules.metricDefinition ?? "单次咨询成本",
		metricFormula: `${evidence.metricsContract.spendMinor.formula} / ${evidence.metricsContract.consultations.formula}`,
		...(evidence.values.spendMinor === undefined
			? {}
			: { spendMinor: evidence.values.spendMinor }),
		...(evidence.values.consultations === undefined
			? {}
			: { consultations: evidence.values.consultations }),
		currency: evidence.currency,
		...(result.thresholdEvaluation.thresholdMinor === undefined
			? {}
			: { thresholdMinor: result.thresholdEvaluation.thresholdMinor }),
		comparisonStatus: result.status,
		canComparePeriods: result.canComparePeriods,
		limitations: result.reasons.map((item) => item.code),
		...(rules.rules.handlingDeadlineHours === undefined
			? {}
			: { handlingDeadlineHours: rules.rules.handlingDeadlineHours }),
	};
}

function alertIdentity(
	taskId: string,
	evidence: EvidenceVersion,
	source: EvidenceSource["source"],
): string {
	return canonicalJson({
		taskId,
		account: [source.platform, source.accountRef],
		scope: {
			planRef: evidence.scope.planRef,
			campaignRefs: [...evidence.scope.campaignRefs].sort(),
		},
		period: {
			startsAt: new Date(evidence.period.startsAt).toISOString(),
			endsAt: new Date(evidence.period.endsAt).toISOString(),
			timeZone: evidence.period.timeZone,
		},
		metric: "cost_per_consultation",
	});
}

function signalFor(alert: InvestigationAlert): Session["signal"] {
	const current = alert.current;
	const amount = (value: number | null | undefined): string =>
		value === undefined ? "未知" : value === null ? "来源为空" : String(value);
	const value = current.comparisonResultId;
	const history = current.comparisonStatus === "missing_baseline"
		? "没有已选择的历史基线；不作跨期上涨结论。"
		: current.canComparePeriods
			? "历史期间可比较；比较不代表因果关系。"
			: "历史期间不可比较；不作跨期结论。";
	const summary = [
		`当期单次咨询成本超过已确认警戒线（${current.currency.code}/${current.currency.minorUnit}）。`,
		`计算式：消耗 ${amount(current.spendMinor)} ÷ 咨询 ${amount(current.consultations)}；警戒线 ${current.thresholdMinor ?? "未知"}。`,
		history,
		"该提醒不推断原因，不代表扩大预算或执行广告操作。",
	].join(" ");
	return {
		id: `web-alert:${alert.id}:${alert.logicalRounds + 1}`,
		title: "当期咨询成本越线排查",
		summary,
		evidence: [
			{ label: "期间", value: `${current.period.startsAt} – ${current.period.endsAt} (${current.period.timeZone})` },
			{ label: "消耗（最小货币单位）", value: amount(current.spendMinor) },
			{ label: "咨询数", value: amount(current.consultations) },
			{ label: "单次咨询成本公式", value: current.metricFormula },
			{ label: "警戒线", value: `${current.thresholdMinor ?? "未知"} ${current.currency.code}/${current.currency.minorUnit}` },
			{ label: "依据", value: `${current.evidence.evidenceId} v${current.evidence.version} · 规则 v${current.evidence.taskVersion} · 比较 ${value}` },
			{ label: "比较范围", value: history },
		].slice(0, 6),
	};
}

function jobId(alertId: string): string {
	return `alert-session:${alertId}`;
}

async function invalidateAlertCandidate(
	tx: Transaction,
	alert: InvestigationAlert,
	reason: string,
	at: string,
): Promise<void> {
	const session = await tx.sessions.get(alert.sessionId);
	if (session && !["completed", "cancelled", "stale"].includes(session.status)) {
		for (const round of await tx.rounds.all()) {
			if (round.sessionId === session.id && round.status === "open")
				await tx.rounds.put({ ...round, status: "invalidated", invalidationReason: reason });
		}
		await tx.sessions.put({ ...session, status: "stale" });
	}
	await tx.investigationAlerts.put({
		...alert,
		status: "stale",
		statusReason: reason,
		updatedAt: at,
		events: [...alert.events, {
			type: "invalidated",
			at,
			comparisonResultId: alert.current.comparisonResultId,
			evidence: alert.current.evidence,
			reason,
		}],
	});
}

export async function invalidateAlertsForEvidenceUpdate(
	tx: Transaction,
	ownerId: string,
	updated: Array<{ evidenceId: string; version: number }>,
	now: () => string,
): Promise<void> {
	const sources = await tx.evidenceSources.all();
	const allAlerts = await tx.investigationAlerts.all();
	for (const ref of updated) {
		const evidence = await tx.evidenceVersions.get(`${ref.evidenceId}:${ref.version}`);
		if (!evidence || evidence.ownerId !== ownerId) continue;
		const source = sourceFor(sources, evidence);
		const candidates = source
			? allAlerts.filter((alert) => alert.id === `alert_${digest(alertIdentity(evidence.taskId, evidence, source)).slice(0, 40)}`)
			: allAlerts.filter((alert) => alert.current.evidence.evidenceId === evidence.evidenceId);
		for (const original of candidates) {
			const alert = await tx.investigationAlerts.get(original.id);
			if (
				!alert ||
				alert.ownerId !== ownerId ||
				["handled", "cleared", "capped", "stale"].includes(alert.status) ||
				sameEvidence(alert.current.evidence, evidenceRef(evidence))
			)
				continue;
			const prior = await tx.evidenceVersions.get(`${alert.current.evidence.evidenceId}:${alert.current.evidence.version}`);
			if (!prior) continue;
			const isNewer = evidence.evidenceId === prior.evidenceId
				? evidence.version > prior.version
				: Date.parse(evidence.createdAt) >= Date.parse(prior.createdAt);
			if (!isNewer) continue;
			await invalidateAlertCandidate(tx, alert, "evidence_revision_requires_re_evaluation", now());
		}
	}
}

export async function invalidateAlertsForTaskVersion(
	tx: Transaction,
	ownerId: string,
	taskId: string,
	taskVersion: number,
	now: () => string,
): Promise<void> {
	for (const alert of await tx.investigationAlerts.all()) {
		if (
			alert.ownerId !== ownerId ||
			alert.taskId !== taskId ||
			alert.current.evidence.taskVersion === taskVersion ||
			["handled", "cleared", "capped", "stale"].includes(alert.status)
		)
			continue;
		await invalidateAlertCandidate(tx, alert, "task_rules_revised_requires_new_evidence", now());
	}
}

/** Converts only a current, explicitly evaluated threshold breach to an in-app alert. */
export class InvestigationAlertService {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async evaluateComparison(ownerId: string, comparisonResultId: string): Promise<InvestigationAlert | null> {
		if (!ownerId || !comparisonResultId)
			throw new InvestigationAlertValidationError("invalid comparison reference");
		return this.storage.transaction(async (tx) => {
			const result = await tx.comparisonResults.get(comparisonResultId);
			if (!result || result.ownerId !== ownerId)
				throw new InvestigationAlertValidationError("comparison result not found");
			const current = await tx.evidenceVersions.get(
				`${result.current.evidenceId}:${result.current.version}`,
			);
			if (!current || current.ownerId !== ownerId || current.taskId !== result.taskId)
				throw new InvestigationAlertValidationError("comparison evidence unavailable");
			const task = await tx.tasks.get(result.taskId);
			const rules = await tx.taskVersions.get(`${result.rulesRef.taskId}:${result.rulesRef.version}`);
			if (!task || task.ownerId !== ownerId || !rules)
				throw new InvestigationAlertValidationError("comparison task unavailable");
			const sources = await tx.evidenceSources.all();
			const source = sourceFor(sources, current);
			if (!source) {
				for (const existing of await tx.investigationAlerts.all()) {
					if (
						existing.ownerId === ownerId &&
						existing.taskId === result.taskId &&
						existing.current.evidence.evidenceId === current.evidenceId &&
						current.version > existing.current.evidence.version &&
						!['handled', 'cleared', 'capped'].includes(existing.status)
					) {
						const invalidated = await this.invalidate(tx, existing, "evidence_revision_missing_source", result.id, evidenceRef(current));
						await tx.investigationAlerts.put(invalidated);
					}
				}
				return null;
			}

			const logicalKey = alertIdentity(result.taskId, current, source);
			const alertId = `alert_${digest(logicalKey).slice(0, 40)}`;
			let alert = await tx.investigationAlerts.get(alertId);
			const head = await tx.evidenceHeads.get(current.evidenceId);
			const isLatest =
				task.currentVersion === result.rulesRef.version &&
				current.taskVersion === result.rulesRef.version &&
				head?.currentVersion === current.version;
			if (!isLatest) return alert;

			const currentSnapshot = makeAlertEvidence(result, current, source, rules);
			const qualifies =
				result.canEvaluateCurrentThreshold &&
				result.thresholdEvaluation.status === "exceeded" &&
				result.thresholdEvaluation.metricKey === "cost_per_consultation" &&
				result.thresholdEvaluation.thresholdMinor !== undefined;
			const at = this.now();
			if (!alert) {
				if (!qualifies) return null;
				const taskVersion = await tx.taskVersions.get(`${result.taskId}:${result.rulesRef.version}`);
				if (!taskVersion) return null;
				const maxPushRounds = taskVersion.rules.maxPushRounds ?? 1;
				alert = {
					id: alertId,
					ownerId,
					taskId: result.taskId,
					logicalKey,
					sessionId: `webalert_${digest(logicalKey).slice(0, 40)}`,
					status: "open",
					current: currentSnapshot,
					comparisonResultIds: [result.id],
					maxPushRounds,
					logicalRounds: 0,
					events: [{ type: "opened", at, comparisonResultId: result.id, evidence: evidenceRef(current) }],
					createdAt: at,
					updatedAt: at,
				};
				await tx.investigationAlerts.put(alert);
				await tx.jobs.put({
					id: jobId(alertId),
					task: { kind: "prepare_investigation_alert_session", alertId },
					status: "pending",
					runAt: at,
					attempts: 0,
				});
				return alert;
			}

			const priorVersion = await tx.evidenceVersions.get(
				`${alert.current.evidence.evidenceId}:${alert.current.evidence.version}`,
			);
			const newEvidence = Boolean(
				priorVersion &&
				!sameEvidence(alert.current.evidence, evidenceRef(current)) &&
				(current.evidenceId === priorVersion.evidenceId
					? current.version > priorVersion.version
					: Date.parse(current.createdAt) > Date.parse(priorVersion.createdAt)),
			);
			const resultIds = alert.comparisonResultIds.includes(result.id)
				? alert.comparisonResultIds
				: [...alert.comparisonResultIds, result.id];
			if (!qualifies) {
				if (alert.status === "handled") return alert;
				const cleared = result.thresholdEvaluation.status === "not_exceeded";
				alert = {
					...alert,
					status: cleared ? "cleared" : "stale",
					statusReason: cleared ? "threshold_no_longer_exceeded" : "current_threshold_unavailable",
					current: currentSnapshot,
					comparisonResultIds: resultIds,
					updatedAt: at,
					events: [...alert.events, {
						type: cleared ? "cleared" : "invalidated",
						at,
						comparisonResultId: result.id,
						evidence: evidenceRef(current),
						reason: cleared ? "threshold_no_longer_exceeded" : "current_threshold_unavailable",
					}],
				};
				await tx.investigationAlerts.put(alert);
				await this.invalidateSession(tx, alert, alert.statusReason ?? "current_threshold_unavailable");
				return alert;
			}

			const priorResult = alert.current.comparisonResultId;
			if (!newEvidence) {
				if (!resultIds.includes(priorResult)) resultIds.push(priorResult);
				const unchanged: InvestigationAlert = {
					...alert,
					current: currentSnapshot,
					comparisonResultIds: resultIds,
					updatedAt: at,
					...(alert.events.some((event) => event.comparisonResultId === result.id)
						? {}
						: { events: [...alert.events, { type: "observed", at, comparisonResultId: result.id, evidence: evidenceRef(current) }] }),
				};
				await tx.investigationAlerts.put(unchanged);
				return unchanged;
			}

			const maxPushRounds = (await tx.taskVersions.get(`${result.taskId}:${result.rulesRef.version}`))?.rules.maxPushRounds ?? 1;
			alert = {
				...alert,
				current: currentSnapshot,
				comparisonResultIds: resultIds,
				updatedAt: at,
				status: alert.status === "handled" ? "handled" : alert.logicalRounds >= maxPushRounds ? "capped" : "open",
				maxPushRounds,
				events: [...alert.events, { type: "observed", at, comparisonResultId: result.id, evidence: evidenceRef(current) }],
			};
			if (alert.status !== "handled" && alert.logicalRounds < alert.maxPushRounds) {
				await this.scheduleNextRound(tx, alert, rules, at);
			} else if (alert.status === "capped") {
				alert.events.push({ type: "capped", at, comparisonResultId: result.id, evidence: evidenceRef(current), reason: "max_push_rounds_reached" });
				await this.invalidateSession(tx, alert, "max_push_rounds_reached");
			}
			await tx.investigationAlerts.put(alert);
			return alert;
		});
	}

	async prepareSession(alertId: string): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const alert = await tx.investigationAlerts.get(alertId);
			if (!alert || alert.status !== "open" || alert.logicalRounds >= alert.maxPushRounds) return;
			const task = await tx.tasks.get(alert.taskId);
			const evidence = await tx.evidenceVersions.get(`${alert.current.evidence.evidenceId}:${alert.current.evidence.version}`);
			const version = await tx.taskVersions.get(`${alert.current.evidence.taskId}:${alert.current.evidence.taskVersion}`);
			const head = evidence && await tx.evidenceHeads.get(evidence.evidenceId);
			if (!task || !evidence || !version || !head || task.ownerId !== alert.ownerId || task.currentVersion !== version.version || head.currentVersion !== evidence.version) {
				await this.invalidateSession(tx, alert, "baseline_or_evidence_is_no_longer_current");
				await tx.investigationAlerts.put({ ...alert, status: "stale", statusReason: "baseline_or_evidence_is_no_longer_current", updatedAt: this.now() });
				return;
			}
			const existing = await tx.sessions.get(alert.sessionId);
			if (existing) {
				if (
					existing.ownerId !== alert.ownerId ||
					(existing.investigationAlertId && existing.investigationAlertId !== alert.id) ||
					(existing.deliveryMode && existing.deliveryMode !== "web")
				)
					throw new InvestigationAlertValidationError("alert session identity conflict");
				const linked: Session = {
					...existing,
					deliveryMode: "web",
					investigationAlertId: alert.id,
					initiatedBy: "system",
					alertEvidenceRef: { evidenceId: evidence.evidenceId, version: evidence.version },
					taskRef: { taskId: task.id, taskVersion: version.version },
					strategy: version.strategy,
					signal: signalFor(alert),
					monetarySuggestionsAllowed: false,
				};
				await tx.sessions.put(linked);
				if (linked.status === "planning") {
					const jobs = await tx.jobs.all();
					const rounds = await tx.rounds.all();
					const hasRound = rounds.some((round) => round.sessionId === linked.id && round.strategyVersion === linked.version);
					const hasJob = jobs.some((job) => job.task.kind === "prepare_round" && job.task.sessionId === linked.id && job.task.version === linked.version && ["pending", "running"].includes(job.status));
					if (!hasRound && !hasJob) {
						await tx.jobs.put({ id: `alert-round:${alert.id}:${alert.logicalRounds + 1}`, task: { kind: "prepare_round", sessionId: linked.id, version: linked.version }, status: "pending", runAt: this.now(), attempts: 0 });
					}
				}
				return;
			}
			const session: Session = {
				id: alert.sessionId,
				ownerId: alert.ownerId,
				taskRef: { taskId: task.id, taskVersion: version.version },
				monetarySuggestionsAllowed: false,
				deliveryMode: "web",
				investigationAlertId: alert.id,
				alertEvidenceRef: { evidenceId: evidence.evidenceId, version: evidence.version },
				allowedActorIds: [],
				strategy: version.strategy,
				limits: { maxBudgetChangeRatio: 0, maxBidChangeRatio: 0 },
				signal: signalFor(alert),
				version: 0,
				roundNo: 0,
				status: "planning",
				createdAt: this.now(),
			};
			await tx.sessions.put(session);
			await tx.snapshots.put({ id: `${session.id}:0`, sessionId: session.id, version: 0, strategy: session.strategy, changes: [], createdAt: this.now() });
			await tx.jobs.put({ id: `alert-round:${alert.id}:1`, task: { kind: "prepare_round", sessionId: session.id, version: 0 }, status: "pending", runAt: this.now(), attempts: 0 });
		});
	}

	async observeEvidenceUpdate(
		ownerId: string,
		updated: Array<{ evidenceId: string; version: number }>,
	): Promise<void> {
		if (!updated.length) return;
		const versions = new Map(updated.map((item) => [item.evidenceId, item.version]));
		await this.storage.transaction(async (tx) => {
			for (const alert of await tx.investigationAlerts.all()) {
				const version = versions.get(alert.current.evidence.evidenceId);
				if (
					alert.ownerId !== ownerId ||
					version === undefined ||
					version <= alert.current.evidence.version ||
					["handled", "cleared", "capped", "stale"].includes(alert.status)
				)
					continue;
				const at = this.now();
				const reason = "evidence_revision_requires_re_evaluation";
				const next = {
					...alert,
					status: "stale" as const,
					statusReason: reason,
					updatedAt: at,
					events: [...alert.events, {
						type: "invalidated" as const,
						at,
						comparisonResultId: alert.current.comparisonResultId,
						evidence: alert.current.evidence,
						reason,
					}],
				};
				await this.invalidateSession(tx, alert, reason);
				await tx.investigationAlerts.put(next);
			}
		});
	}

	async observeTaskVersion(ownerId: string, taskId: string, taskVersion: number): Promise<void> {
		await this.storage.transaction(async (tx) => {
			for (const alert of await tx.investigationAlerts.all()) {
				if (
					alert.ownerId !== ownerId ||
					alert.taskId !== taskId ||
					alert.current.evidence.taskVersion === taskVersion ||
					["handled", "cleared", "capped", "stale"].includes(alert.status)
				)
					continue;
				const at = this.now();
				const reason = "task_rules_revised_requires_new_evidence";
				await this.invalidateSession(tx, alert, reason);
				await tx.investigationAlerts.put({
					...alert,
					status: "stale",
					statusReason: reason,
					updatedAt: at,
					events: [...alert.events, {
						type: "invalidated",
						at,
					comparisonResultId: alert.current.comparisonResultId,
						evidence: alert.current.evidence,
						reason,
					}],
				});
			}
		});
	}

	async listForTask(ownerId: string, taskId: string): Promise<InvestigationAlert[]> {
		return this.storage.transaction(async (tx) => {
			const task = await tx.tasks.get(taskId);
			if (!task || task.ownerId !== ownerId)
				throw new InvestigationAlertValidationError("task not found");
			return (await tx.investigationAlerts.all())
				.filter((item) => item.ownerId === ownerId && item.taskId === taskId)
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		});
	}

	async recordChoice(tx: Transaction, alertId: string, candidateId: string, comparisonResultId: string): Promise<void> {
		const alert = await tx.investigationAlerts.get(alertId);
		if (!alert || alert.status !== "open") return;
		const at = this.now();
		const deferred = candidateId === "await_evidence";
		const next: InvestigationAlert = {
				...alert,
				status: deferred ? "awaiting_evidence" : "handled",
				statusReason: deferred ? "awaiting_new_evidence" : `choice:${candidateId}`,
				updatedAt: at,
				events: [...alert.events, {
					type: deferred ? "deferred" : "handled",
					at,
					comparisonResultId,
					evidence: alert.current.evidence,
					reason: candidateId,
				}],
			};
		await tx.investigationAlerts.put(next);
	}

	private async scheduleNextRound(tx: Transaction, alert: InvestigationAlert, rules: TaskVersion, at: string): Promise<void> {
		const session = await tx.sessions.get(alert.sessionId);
		if (!session) {
			await tx.jobs.put({ id: jobId(alert.id), task: { kind: "prepare_investigation_alert_session", alertId: alert.id }, status: "pending", runAt: at, attempts: 0 });
			return;
		}
		if (session.status === "awaiting_input" || session.status === "planning") {
			await this.invalidateOpenRounds(tx, session.id, "new_evidence_superseded_candidate");
		}
		const nextVersion = session.version + 1;
		const currentEvidence = alert.current.evidence;
		const next: Session = {
			...session,
			taskRef: { taskId: rules.taskId, taskVersion: rules.version },
			alertEvidenceRef: { evidenceId: currentEvidence.evidenceId, version: currentEvidence.version },
			strategy: rules.strategy,
			signal: signalFor(alert),
			version: nextVersion,
			status: "planning",
		};
		await tx.sessions.put(next);
		await tx.snapshots.put({ id: `${next.id}:${nextVersion}`, sessionId: next.id, version: nextVersion, strategy: next.strategy, changes: [], createdAt: at });
		await tx.jobs.put({ id: `alert-round:${alert.id}:${alert.logicalRounds + 1}`, task: { kind: "prepare_round", sessionId: next.id, version: nextVersion }, status: "pending", runAt: at, attempts: 0 });
	}

	private async invalidate(tx: Transaction, alert: InvestigationAlert, reason: string, resultId: string, ref: ComparisonEvidenceRef): Promise<InvestigationAlert> {
		const at = this.now();
		await this.invalidateSession(tx, alert, reason);
		return {
			...alert,
			status: "stale",
			statusReason: reason,
			comparisonResultIds: alert.comparisonResultIds.includes(resultId) ? alert.comparisonResultIds : [...alert.comparisonResultIds, resultId],
			updatedAt: at,
			events: [...alert.events, { type: "invalidated", at, comparisonResultId: resultId, evidence: ref, reason }],
		};
	}

	private async invalidateSession(tx: Transaction, alert: InvestigationAlert, reason: string): Promise<void> {
		const session = await tx.sessions.get(alert.sessionId);
		if (!session || ["completed", "cancelled", "stale"].includes(session.status)) return;
		await this.invalidateOpenRounds(tx, session.id, reason);
		await tx.sessions.put({ ...session, status: "stale" });
	}

	private async invalidateOpenRounds(tx: Transaction, sessionId: string, reason: string): Promise<void> {
		for (const round of await tx.rounds.all()) {
			if (round.sessionId === sessionId && round.status === "open")
				await tx.rounds.put({ ...round, status: "invalidated", invalidationReason: reason });
		}
	}
}
