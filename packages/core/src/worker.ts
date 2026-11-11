import type { Orchestrator } from "./orchestrator.js";
import type { InvestigationAlertService } from "./investigation-alerts.js";
import {
	canSendProactiveIn,
	noteUnreachableIn,
	type NotificationService,
} from "./notifications.js";
import { buildDigestCard, MAX_INFO_ITEMS } from "./domain/infoCard.js";
import {
	inQuietHours,
	type DigestScheduler,
} from "./notifications-schedule.js";
import {
	localDate,
	type NotificationQueue,
} from "./notifications-queue.js";
import type { SubscriptionService } from "./subscriptions.js";
import type { DecisionDeliveryService } from "./decision-delivery.js";
import { RecipientUnreachableError, type OutboundChannel } from "./ports/channel.js";
import type { Storage, Transaction } from "./ports/storage.js";
import type { Job } from "./state/model.js";

/** Reusable worker; the same instance can be embedded in API or run in a separate process. */
export class Worker {
	constructor(
		private storage: Storage,
		private decisions: Orchestrator,
		private channels: ReadonlyMap<string, OutboundChannel>,
		private now: () => string = () => new Date().toISOString(),
		private maxAttempts = 5,
		private investigationAlerts?: InvestigationAlertService,
		/** 主动通知闸门；未注入时不做抑制（保持既有测试与旧装配的行为）。 */
		private notifications?: NotificationService,
		/** 日汇总：调度、订阅配置、队列与平台账号解析；未注入时不做推送。 */
		private digest?: {
			scheduler: DigestScheduler;
			subscriptions: SubscriptionService;
			queue: NotificationQueue;
			/** 目的地平台 → 渠道账号 id；解析不到即视为渠道不可用。 */
			accountIdForPlatform: (platform: string) => string | undefined;
			detailBase?: string;
		},
		/** 决策卡及时推送：把 open 告警接进单聊。 */
		private decisionDelivery?: DecisionDeliveryService,
		private readonly scheduleIntervalMs = 30_000,
		private readonly scanIntervalMs = 30_000,
	) {}

	/** 上一次日汇总调度的时间戳，用于在没有任务可领时按间隔触发。 */
	private lastScheduleTick = 0;
	/** 上一次扫描 open 告警的时间戳。 */
	private lastDecisionScan = 0;

	/**
	 * 本次领取的租约在**当前事务**里是否仍然有效。
	 * 过期 worker 不得改写投递/条目/批次，也不得把有效地址判为失效。
	 */
	private async holdsLease(tx: Transaction, job: Job): Promise<boolean> {
		const current = await tx.jobs.get(job.id);
		return (
			current?.status === "running" &&
			current.leaseToken !== undefined &&
			current.leaseToken === job.leaseToken
		);
	}

	async runOnce(): Promise<boolean> {
		const job = await this.storage.claimJob(this.now(), 60_000);
		if (!job) {
			// 没有任务可领时按间隔触发一次日汇总调度；不引第二个调度进程。
			// 决策卡及时推送：没有任务可领时按间隔扫一次 open 告警。
			if (
				this.decisionDelivery &&
				typeof (this.decisionDelivery as any).openAlerts === "function" &&
				Date.parse(this.now()) - this.lastDecisionScan >= this.scanIntervalMs
			) {
				this.lastDecisionScan = Date.parse(this.now());
				for (const alert of await (this.decisionDelivery as any).openAlerts(undefined))
					await this.decisionDelivery.dispatch(alert.id).catch(() => undefined);
			}
			if (
				this.digest &&
				Date.parse(this.now()) - this.lastScheduleTick >= this.scheduleIntervalMs
			) {
				this.lastScheduleTick = Date.parse(this.now());
				await this.digest.scheduler.tick();
			}
			return false;
		}
		try {
			switch (job.task.kind) {
				case "process_inbox":
					await this.decisions.processInbox(job.task.inboxId);
					break;
				case "prepare_round":
					await this.decisions.prepareRound(
						job.task.sessionId,
						job.task.version,
					);
					break;
				case "send_digest":
					await this.sendDigest(job);
					break;
				case "prepare_investigation_alert_session":
					if (!this.investigationAlerts)
						throw new Error("investigation alert service is not configured");
					await this.investigationAlerts.prepareSession(job.task.alertId);
					break;
				case "send_delivery":
					await this.send(job);
					break;
			}
			await this.storage.transaction(async (tx) => {
				const current = await tx.jobs.get(job.id);
				if (
					current?.status === "running" &&
					current.leaseToken === job.leaseToken
				) {
					await tx.jobs.put({ ...current, status: "done" });
				}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "job failed";
			await this.storage.transaction(async (tx) => {
				const current = await tx.jobs.get(job.id);
				if (
					current?.status !== "running" ||
					current.leaseToken !== job.leaseToken
				)
					return;
				if (
					current.task.kind === "process_inbox" &&
					current.attempts >= this.maxAttempts
				) {
					const inbox = await tx.inbox.get(current.task.inboxId);
					if (inbox?.status === "pending")
						await tx.inbox.put({ ...inbox, status: "failed", reason: message });
				}
				const exhausted = current.attempts >= this.maxAttempts;
				await tx.jobs.put({
					...current,
					status: exhausted ? "failed" : "pending",
					lastError: message,
					runAt: new Date(
						Date.parse(this.now()) +
							Math.min(300_000, 1000 * 2 ** current.attempts),
					).toISOString(),
				});
				if (exhausted && current.task.kind === "send_delivery") {
					const delivery = await tx.deliveries.get(current.task.deliveryId);
					if (delivery && delivery.status !== "sent") {
						await tx.deliveries.put({
							...delivery,
							status: "failed",
							lastError: message,
						});
					}
				}
			});
		}
		return true;
	}

	/**
	 * 日汇总发送。调度只是「建议」，这里在执行那一刻重新检查：
	 * 订阅开关与版本、免打扰、目的地与授权、条目是否仍待发；任何一项不成立都不发。
	 */
	private async sendDigest(job: Job): Promise<void> {
		if (!this.digest || !this.notifications) return;
		if (job.task.kind !== "send_digest") return;
		const batchId = job.task.batchId;
		const at = new Date(this.now());
		if (!(await this.storage.transaction((tx) => this.holdsLease(tx, job))))
			return;
		const view = await this.storage.transaction(async (tx) => {
			const batch = await tx.notificationBatches.get(batchId);
			if (!batch || batch.status !== "queued") return null;
			return { batch, ownerId: batch.ownerId };
		});
		if (!view) return;

		// 跨日守卫：往日的汇总不得此刻补发，合并进下一次有效汇总后终结旧批次。
		// 调度侧已判过一次，这里防「任务早已入队、跨日才被领取」。
		if (view.batch.localDate < localDate(at)) {
			const settings = await this.digest.subscriptions.view(view.ownerId);
			if (!settings.settings.proactiveEnabled) {
				await this.digest.queue.cancelPending(
					view.ownerId,
					"push_disabled",
					(item) => item.batchId === batchId,
				);
				await this.digest.queue.setBatchStatus(batchId, "cancelled", {
					reason: "push_disabled",
				});
				return;
			}
			await this.digest.queue.mergeStale(
				view.ownerId,
				batchId,
				settings.settings.version,
			);
			await this.digest.queue.setBatchStatus(batchId, "cancelled", {
				reason: "merged_stale",
			});
			return;
		}
		const subscription = await this.digest.subscriptions.view(view.ownerId);
		const cancel = (reason: string) =>
			this.digest!.queue.cancelPending(
				view.ownerId,
				reason,
				(item) => item.batchId === batchId,
			);
		if (!subscription.settings.proactiveEnabled) {
			await cancel("push_disabled");
			await this.digest.queue.setBatchStatus(batchId, "cancelled", {
				reason: "push_disabled",
			});
			return;
		}
		if (subscription.settings.version !== view.batch.settingsVersion) {
			await cancel("settings_changed");
			await this.digest.queue.setBatchStatus(batchId, "cancelled", {
				reason: "settings_changed",
			});
			return;
		}
		// 免打扰：本批次留着，等窗口结束后的下一次 tick。
		if (inQuietHours(at, subscription.settings.schedule)) return;

		const allowed = await this.storage.transaction((tx) =>
			canSendProactiveIn(tx, view.ownerId),
		);
		if (!allowed) {
			const status = await this.notifications.status(view.ownerId);
			const reason = !status.destination
				? "destination_missing"
				: status.destination.status !== "verified"
					? "destination_invalidated"
					: !status.consent
						? "consent_missing"
						: status.consent.status !== "active"
							? "consent_revoked"
							: "identity_inactive";
			await cancel(reason);
			await this.digest.queue.setBatchStatus(batchId, "suppressed", {
				reason,
			});
			return;
		}

		const items = (await this.digest.queue.pending(view.ownerId)).filter(
			(item) => item.batchId === batchId,
		);
		if (items.length === 0) {
			await this.digest.queue.setBatchStatus(batchId, "cancelled", {
				reason: "empty",
			});
			return;
		}
		const shown = items.slice(0, MAX_INFO_ITEMS);
		const remaining = items.slice(MAX_INFO_ITEMS);
		const detailBase = this.digest.detailBase;
		const card = buildDigestCard(
			shown.map((item) => ({
				title: item.title,
				summary: item.summary,
				relevance: item.relevance,
				sources: item.sources,
				...(detailBase && item.taskId
					? { detailUrl: `${detailBase}/tasks/${item.taskId}` }
					: {}),
			})),
			{
				date: localDate(at),
				remaining: remaining.length,
				...(detailBase
					? { detailUrl: `${detailBase}/settings/subscriptions` }
					: {}),
			},
		);

		const destination = (
			await this.notifications.status(view.ownerId)
		).destination;
		if (!destination) return;
		const accountId = this.digest.accountIdForPlatform(destination.platform);
		const channel = accountId ? this.channels.get(accountId) : undefined;
		if (!channel) {
			await this.digest.queue.setBatchStatus(batchId, "suppressed", {
				reason: "channel_unavailable",
			});
			return;
		}

		const deliveryId = `digest:${batchId}`;
		const delivery = {
			id: deliveryId,
			recipient: {
				accountId: accountId!,
				kind: "user" as const,
				externalId: destination.externalId,
			},
			card,
			actions: [],
			purpose: "digest" as const,
			ownerId: view.ownerId,
			batchId,
			expiresAt: new Date(at.getTime() + 24 * 60 * 60_000).toISOString(),
			status: "pending" as const,
		};
		await this.storage.transaction((tx) => tx.deliveries.put({ ...delivery }));

		let receipt;
		try {
			receipt = await channel.send(delivery as never);
		} catch (error) {
			// 与成功分支一样先校验租约：新 worker 已接管时，本次结果一律作废。
			await this.storage.transaction(async (tx) => {
				if (!(await this.holdsLease(tx, job))) return;
				const current = await tx.deliveries.get(deliveryId);
				if (current && current.status === "pending")
					await tx.deliveries.put({
						...current,
						status: "failed",
						lastError:
							error instanceof RecipientUnreachableError
								? "recipient unreachable"
								: "send failed",
					});
				if (!(error instanceof RecipientUnreachableError)) return;
				// 地址不可用：与决策卡一致，一次即判定失效。
				await noteUnreachableIn(tx, view.ownerId, this.now(), {
					accountId: accountId!,
					kind: "user",
					externalId: destination.externalId,
				});
				for (const item of await tx.notificationItems.all())
					if (item.batchId === batchId && item.status === "queued")
						await tx.notificationItems.put({
							...item,
							status: "cancelled",
							updatedAt: this.now(),
						});
				await this.digest!.queue.setBatchStatusIn(tx, batchId, "failed", {
					reason: "recipient_unreachable",
				});
			});
			if (error instanceof RecipientUnreachableError) return;
			throw error;
		}

		await this.storage.transaction(async (tx) => {
			if (!(await this.holdsLease(tx, job))) return;
			const current = await tx.deliveries.get(deliveryId);
			if (current && current.status === "pending")
				await tx.deliveries.put({
					...current,
					status: "sent",
					externalMessageId: receipt.externalMessageId,
					sentAt: this.now(),
				});
			// 只把**本卡展示的 revision** 标为已发送；期间发生的实质更新仍是待发。
			for (const item of shown)
				await this.digest!.queue.markSentIn(tx, view.ownerId, item.logicalKey, {
					deliveryId,
					revision: item.revision,
				});
			await this.digest!.queue.setBatchStatusIn(tx, batchId, "sent");
			// 发送期间被实质更新（或超出卡片容量）的条目仍在 queued：
			// 批次已置为已发送，顺延到下一批次，避免留在已发送批次里成为孤儿。
			const stillQueued = (await tx.notificationItems.all()).filter(
				(item) =>
					item.ownerId === view.ownerId &&
					item.status === "queued" &&
					item.batchId === batchId,
			);
			const keys = [
				...new Set(
					[...remaining, ...stillQueued].map((item) => item.logicalKey),
				),
			];
			if (keys.length > 0)
				await this.digest!.queue.deferItemsIn(
					tx,
					view.ownerId,
					keys,
					subscription.settings.version,
				);
		});
	}

	private async send(job: Job): Promise<void> {
		if (job.task.kind !== "send_delivery") return;
		const deliveryId = job.task.deliveryId;
		const delivery = await this.storage.transaction((tx) =>
			tx.deliveries.get(deliveryId),
		);
		if (
			!delivery ||
			delivery.status === "sent" ||
			delivery.status === "cancelled" ||
			// 已抑制的投递是终态：写入 suppressed 与 job 完成分属两个事务，
			// 若中途退出导致任务被重新领取，不能把这张卡补发出去。
			delivery.status === "suppressed"
		)
			return;
		const round = delivery.roundId
			? await this.storage.transaction((tx) => tx.rounds.get(delivery.roundId!))
			: null;
		const session = round
			? await this.storage.transaction((tx) => tx.sessions.get(round.sessionId))
			: null;
		const now = this.now();
		const expired =
			!round ||
			!session ||
			(Boolean(session.expiresAt) && session.expiresAt! <= now) ||
			(Boolean(round.expiresAt) && round.expiresAt! <= now);
		const staleDecision =
			delivery.purpose === "decision" &&
			(expired ||
				round.status !== "open" ||
				session.status !== "awaiting_input");
		const staleConfirmation =
			delivery.purpose === "confirmation" && session?.status === "cancelled";
		if (staleDecision || staleConfirmation || expired) {
			await this.storage.transaction(async (tx) => {
				const current = await tx.deliveries.get(deliveryId);
				if (current && current.status === "pending")
					await tx.deliveries.put({ ...current, status: "cancelled" });
			});
			return;
		}
		// 主动通知闸门：只拦系统主动发起的会话（initiatedBy=system）。
		// 用户自己在控制台创建/处理的会话属于本人操作回执，不受授权影响。
		if (
			this.notifications &&
			session &&
			delivery.purpose === "decision" &&
			session.initiatedBy === "system"
		) {
			const status = await this.notifications.status(session.ownerId);
			const allowed = await this.storage.transaction((tx) =>
				canSendProactiveIn(tx, session.ownerId),
			);
			if (!allowed) {
				const reason = !status.destination
					? "destination_missing"
					: status.destination.status !== "verified"
						? "destination_invalidated"
						: !status.consent
							? "consent_missing"
							: status.consent.status !== "active"
								? "consent_revoked"
								: "identity_inactive";
				await this.storage.transaction(async (tx) => {
					const current = await tx.deliveries.get(deliveryId);
					if (current && current.status === "pending")
						await tx.deliveries.put({
							...current,
							status: "suppressed",
							suppressionReason: reason,
						});
				});
				return;
			}
		}

		const channel = this.channels.get(delivery.recipient.accountId);
		if (!channel) throw new Error("outbound account is not configured");
		// No database lock is held during a network request. Stable ID survives retries/crashes.
		let receipt;
		try {
			receipt = await channel.send(delivery);
		} catch (error) {
			// 平台明确说「收件人不可达」：重试无意义，直接终态失败并记一次。
			// 与成功分支一样先校验租约：若新 worker 已接管并发送成功，
			// 过期 worker 不得改写投递状态，也不得把地址判为失效。
			if (!(error instanceof RecipientUnreachableError)) throw error;
			await this.storage.transaction(async (tx) => {
				const currentJob = await tx.jobs.get(job.id);
				if (
					currentJob?.status !== "running" ||
					currentJob.leaseToken !== job.leaseToken
				)
					return;
				const current = await tx.deliveries.get(deliveryId);
				if (!current || current.status === "sent" || current.status === "suppressed")
					return;
				await tx.deliveries.put({
					...current,
					status: "failed",
					lastError: "recipient unreachable",
				});
				if (this.notifications && session)
					await noteUnreachableIn(tx, session.ownerId, now, delivery.recipient);
			});
			return;
		}
		await this.storage.transaction(async (tx) => {
			const currentJob = await tx.jobs.get(job.id);
			if (
				currentJob?.status !== "running" ||
				currentJob.leaseToken !== job.leaseToken
			)
				return;
			const current = await tx.deliveries.get(deliveryId);
			if (!current || current.status === "sent") return;
			await tx.deliveries.put({
				...current,
				status: "sent",
				externalMessageId: receipt.externalMessageId,
				sentAt: this.now(),
			});
		});
	}
}
