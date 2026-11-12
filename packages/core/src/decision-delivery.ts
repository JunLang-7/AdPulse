import { canSendProactiveIn } from "./notifications.js";
import { inQuietHours, quietHoursEnd } from "./notifications-schedule.js";
import type { Transaction } from "./ports/storage.js";
import type {
	Delivery,
	NotificationDestination,
	Session,
} from "./state/model.js";

/** Local account lookup only; never performs network I/O inside a transaction. */
export type DecisionAccountResolver = (
	destination: NotificationDestination,
) => string | undefined;

/** Evaluated only while a new candidate is frozen, never by scanning historical rounds. */
export async function admitDecisionIn(
	tx: Transaction,
	session: Session,
	frozenAt: string,
	resolveAccount?: DecisionAccountResolver,
) {
	if (!resolveAccount || !session.investigationAlertId || !session.taskRef)
		return null;
	const settings = await tx.subscriptionSettings.get(session.ownerId);
	const confirmation = settings?.decisionCards;
	if (
		!settings?.proactiveEnabled ||
		!confirmation?.enabled ||
		!confirmation.enabledAt ||
		!confirmation.confirmedVersion ||
		!(Date.parse(frozenAt) > Date.parse(confirmation.enabledAt)) ||
		!settings.enabledAt ||
		!(Date.parse(frozenAt) > Date.parse(settings.enabledAt))
	)
		return null;
	const targets = await tx.subscriptionTargets.all();
	if (
		!targets.some(
			(target) =>
				target.userId === session.ownerId &&
				target.kind === "task" &&
				target.refId === session.taskRef?.taskId &&
				target.status === "active" &&
				target.categories.includes("effect"),
		)
	)
		return null;
	if (!(await canSendProactiveIn(tx, session.ownerId))) return null;
	const destination = (await tx.notificationDestinations.all()).find(
		(item) => item.userId === session.ownerId && item.status === "verified",
	);
	if (!destination) return null;
	const consent = await tx.notificationConsents.get(
		`${session.ownerId}:${destination.id}`,
	);
	const accountId = resolveAccount(destination);
	if (!accountId || !consent || consent.status !== "active") return null;
	return {
		recipient: {
			accountId,
			kind: "user" as const,
			externalId: destination.externalId,
		},
		snapshot: {
			frozenAt,
			settingsVersion: settings.version,
			confirmedVersion: confirmation.confirmedVersion,
			enabledAt: confirmation.enabledAt,
			destinationId: destination.id,
			destinationVerifiedAt: destination.verifiedAt,
			consentVersion: consent.version,
		},
	};
}

export type DecisionPreflight =
	| { kind: "send" }
	| { kind: "suppress"; reason: string }
	| { kind: "defer"; runAt: string };

/** All mutable prerequisites are reloaded in one transaction immediately before sending. */
export async function checkDecisionIn(
	tx: Transaction,
	delivery: Delivery,
	at: string,
	resolveAccount?: DecisionAccountResolver,
): Promise<DecisionPreflight> {
	const suppress = (reason: string): DecisionPreflight => ({
		kind: "suppress",
		reason,
	});
	const snapshot = delivery.proactiveDecision;
	if (!snapshot || !resolveAccount || delivery.purpose !== "decision")
		return suppress("decision_delivery_disabled");
	const session = delivery.sessionId
		? await tx.sessions.get(delivery.sessionId)
		: null;
	const round = delivery.roundId ? await tx.rounds.get(delivery.roundId) : null;
	if (
		session?.deliveryMode !== "channel" ||
		session.initiatedBy !== "system" ||
		session.recipient?.accountId !== delivery.recipient.accountId ||
		session.recipient?.externalId !== delivery.recipient.externalId ||
		!round ||
		round.sessionId !== session.id ||
		round.status !== "open" ||
		session.status !== "awaiting_input" ||
		session.roundNo !== round.roundNo ||
		session.version !== round.strategyVersion
	)
		return suppress("candidate_no_longer_open");
	if (
		!round.expiresAt ||
		!Number.isFinite(Date.parse(at)) ||
		(Boolean(session.expiresAt) &&
			!Number.isFinite(Date.parse(session.expiresAt ?? ""))) ||
		!Number.isFinite(Date.parse(round.expiresAt)) ||
		!Number.isFinite(Date.parse(snapshot.frozenAt)) ||
		!Number.isFinite(Date.parse(delivery.expiresAt)) ||
		Date.parse(at) >=
			Math.min(
				Date.parse(round.expiresAt),
				Date.parse(delivery.expiresAt),
				Date.parse(snapshot.frozenAt) + 24 * 60 * 60_000,
				session.expiresAt ? Date.parse(session.expiresAt) : Infinity,
			)
	)
		return suppress("decision_expired");
	const alert = session.investigationAlertId
		? await tx.investigationAlerts.get(session.investigationAlertId)
		: null;
	const task = session.taskRef
		? await tx.tasks.get(session.taskRef.taskId)
		: null;
	const version = session.taskRef
		? await tx.taskVersions.get(
				`${session.taskRef.taskId}:${session.taskRef.taskVersion}`,
			)
		: null;
	const head = session.alertEvidenceRef
		? await tx.evidenceHeads.get(session.alertEvidenceRef.evidenceId)
		: null;
	const evidence = session.alertEvidenceRef
		? await tx.evidenceVersions.get(
				`${session.alertEvidenceRef.evidenceId}:${session.alertEvidenceRef.version}`,
			)
		: null;
	if (
		!alert ||
		alert.ownerId !== session.ownerId ||
		alert.sessionId !== session.id ||
		alert.status !== "open" ||
		!task ||
		task.ownerId !== session.ownerId ||
		task.currentVersion !== session.taskRef?.taskVersion ||
		!version ||
		!head ||
		!evidence ||
		evidence.ownerId !== session.ownerId ||
		evidence.taskId !== task.id ||
		evidence.taskVersion !== version.version ||
		head.ownerId !== session.ownerId ||
		head.taskId !== task.id ||
		head.taskVersion !== version.version ||
		head.currentVersion !== session.alertEvidenceRef?.version ||
		alert.taskId !== task.id ||
		alert.current.evidence.taskVersion !== version.version ||
		alert.current.evidence.evidenceId !== session.alertEvidenceRef.evidenceId ||
		alert.current.evidence.version !== session.alertEvidenceRef.version
	)
		return suppress("stale_evidence_or_task");
	const freeze = alert.events
		.filter((event) => event.type === "candidate_created")
		.at(-1);
	if (freeze?.at !== snapshot.frozenAt) return suppress("freeze_mismatch");
	if (
		!(await tx.evidenceSources.all()).some(
			(source) =>
				source.ownerId === session.ownerId &&
				source.evidenceId === evidence.evidenceId &&
				source.evidenceVersion === evidence.version &&
				source.source.platform === alert.current.source.platform &&
				source.source.accountRef === alert.current.source.accountRef,
		)
	)
		return suppress("evidence_source_unavailable");
	if (
		version.observation.endsAt &&
		Date.parse(version.observation.endsAt) <= Date.parse(at)
	)
		return suppress("decision_expired");
	const admission = await admitDecisionIn(
		tx,
		session,
		snapshot.frozenAt,
		resolveAccount,
	);
	if (!admission) return suppress("preferences_or_authorization_invalid");
	const current = admission.snapshot;
	if (
		current.settingsVersion !== snapshot.settingsVersion ||
		current.confirmedVersion !== snapshot.confirmedVersion ||
		current.enabledAt !== snapshot.enabledAt ||
		current.destinationId !== snapshot.destinationId ||
		current.destinationVerifiedAt !== snapshot.destinationVerifiedAt ||
		current.consentVersion !== snapshot.consentVersion ||
		admission.recipient.accountId !== delivery.recipient.accountId ||
		admission.recipient.externalId !== delivery.recipient.externalId ||
		delivery.recipient.kind !== "user"
	)
		return suppress("settings_or_destination_changed");
	const settings = await tx.subscriptionSettings.get(session.ownerId);
	if (!settings) return suppress("preferences_or_authorization_invalid");
	if (inQuietHours(new Date(at), settings.schedule)) {
		const runAt = quietHoursEnd(new Date(at), settings.schedule.quietEnd);
		if (runAt >= delivery.expiresAt || runAt >= round.expiresAt)
			return suppress("expires_during_quiet_hours");
		return { kind: "defer", runAt };
	}
	return { kind: "send" };
}
