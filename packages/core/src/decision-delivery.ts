// 决策卡及时推送（#37 PR3）：把效果排查告警接进企业飞书单聊。
import type { Storage } from "./ports/storage.js";
import type { Orchestrator } from "./orchestrator.js";
import type { NotificationService } from "./notifications.js";
import type { Session } from "./state/model.js";

export const DECISION_VALIDITY_HOURS = 24;

export interface DecisionDispatch {
	sessionId: string;
	expiresAt: string;
	created: boolean;
}

export class DecisionDeliveryError extends Error {
	constructor(
		readonly reason:
			| "alert_not_found"
			| "alert_closed"
			| "destination_unavailable"
			| "destination_mismatch"
			| "account_unavailable",
		message: string,
	) {
		super(message);
		this.name = "DecisionDeliveryError";
	}
}

export class DecisionDeliveryService {
	constructor(
		private readonly storage: Storage,
		private readonly decisions: Orchestrator,
		private readonly notifications: NotificationService,
		private readonly accountIdForPlatform: (platform: string) => string | undefined,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async dispatch(
		alertId: string,
		options?: { now?: string; expiresAt?: string },
	): Promise<DecisionDispatch> {
		const at = options?.now ?? this.now();
		const alert = await this.storage.transaction((tx) =>
			tx.investigationAlerts.get(alertId),
		);
		if (!alert) throw new DecisionDeliveryError("alert_not_found", "alert not found");
		if (alert.status !== "open")
			throw new DecisionDeliveryError("alert_closed", `alert is ${alert.status}`);
		const status = await this.notifications.status(alert.ownerId);
		const destination = status.destination;
		if (!destination || destination.status !== "verified")
			throw new DecisionDeliveryError("destination_unavailable", "no verified destination");
		const accountId = this.accountIdForPlatform(destination.platform);
		if (!accountId)
			throw new DecisionDeliveryError("account_unavailable", "no channel account");

		return this.storage.transaction(async (tx) => {
			const existing = await tx.sessions.get(alert.sessionId);
			if (existing) {
				if (existing.ownerId !== alert.ownerId)
					throw new DecisionDeliveryError("destination_mismatch", "owner mismatch");
				if (existing.recipient?.externalId !== destination.externalId)
					throw new DecisionDeliveryError("destination_mismatch", "destination changed");
				return {
					sessionId: existing.id,
					expiresAt: existing.expiresAt ?? "",
					created: false,
				};
			}
			const requested = options?.expiresAt
				? Date.parse(options.expiresAt)
				: Number.POSITIVE_INFINITY;
			const capMs = Date.parse(at) + DECISION_VALIDITY_HOURS * 60 * 60 * 1000;
			const expiresAt = new Date(Math.min(requested, capMs)).toISOString();
			const session: Session = {
				id: alert.sessionId,
				ownerId: alert.ownerId,
				deliveryMode: "channel",
				initiatedBy: "system",
				recipient: {
					accountId,
					kind: "user",
					externalId: destination.externalId,
				},
				allowedActorIds: [destination.externalId],
				strategy: {
					objective: "leads",
					audience: [],
					channels: {},
					sellingPoints: [],
				},
				limits: { maxBidChangeRatio: 0, maxBudgetChangeRatio: 0 },
				signal: {
					id: alert.logicalKey,
					title: alert.taskId,
					summary: "效果排查触发主动提醒",
					evidence: [],
				},
				version: 0,
				roundNo: 0,
				status: "planning",
				expiresAt,
				createdAt: at,
			};
			await tx.sessions.put(session);
			await tx.snapshots.put({
				id: `${session.id}:0`,
				sessionId: session.id,
				version: 0,
				strategy: session.strategy,
				changes: [],
				createdAt: at,
			});
			const jobs = await tx.jobs.all();
			const hasJob = jobs.some(
				(job) =>
					job.task.kind === "prepare_round" &&
					job.task.sessionId === session.id &&
					job.status !== "done",
			);
			if (!hasJob) {
				await tx.jobs.put({
					id: `decision-round:${session.id}:1`,
					task: { kind: "prepare_round", sessionId: session.id, version: 0 },
					status: "pending",
					runAt: at,
					attempts: 0,
				});
			}
			return {
				sessionId: session.id,
				expiresAt,
				created: true,
			};
		});
	}

	async openAlerts(ownerId?: string) {
		const alerts = await this.storage.transaction((tx) =>
			tx.investigationAlerts.all(),
		);
		return alerts.filter(
			(alert) =>
				alert.status === "open" &&
				alert.logicalRounds < alert.maxPushRounds &&
				(!ownerId || alert.ownerId === ownerId),
		);
	}
}
