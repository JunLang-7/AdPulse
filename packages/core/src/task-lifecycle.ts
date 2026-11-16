import { deletionOf, deletionWindow, restrictForDeletion } from "./lifecycle.js";
import type { Storage, Transaction } from "./ports/storage.js";
import type { AuditRecord, Task } from "./state/model.js";

export class TaskLifecycleError extends Error {
	constructor(readonly code: "task_not_found") {
		super(code);
		this.name = "TaskLifecycleError";
	}
}

export interface TaskDeletionView {
	taskId: string;
	state: "restricted" | "cleaned";
	requestedAt: string;
	cleanupDueAt: string;
	cleanedAt?: string;
	/** 本次调用是否首次确认；重复确认是幂等的，不刷新首次时间。 */
	newlyRequested: boolean;
	suppressed: {
		items: number;
		batches: number;
		deliveries: number;
		jobs: number;
		sessions: number;
		inboxes: number;
	};
}

const noSuppression = (): TaskDeletionView["suppressed"] => ({
	items: 0,
	batches: 0,
	deliveries: 0,
	jobs: 0,
	sessions: 0,
	inboxes: 0,
});

function viewOf(task: Task, newlyRequested: boolean): TaskDeletionView {
	const deletion = deletionOf(task);
	if (!deletion) throw new TaskLifecycleError("task_not_found");
	return {
		taskId: task.id,
		state: deletion.state,
		requestedAt: deletion.requestedAt,
		cleanupDueAt: deletion.cleanupDueAt,
		...(deletion.cleanedAt ? { cleanedAt: deletion.cleanedAt } : {}),
		newlyRequested,
		suppressed: noSuppression(),
	};
}

/**
 * 本人确认删除（#40 PR2）。
 *
 * 同一事务内：标记 restricted（立即不可访问/不可处理）→ 抑制关联待发（队列条目、
 * 批次、pending 投递、pending 任务、未处理 inbox、打开中的会话）→ 写最小审计。
 * 物理清理由后续清理任务完成，这里不删业务原文。
 */
export class TaskLifecycleService {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly id: () => string = () => crypto.randomUUID(),
	) {}

	async requestDeletion(
		ownerId: string,
		taskId: string,
	): Promise<TaskDeletionView> {
		if (!ownerId || !taskId) throw new TaskLifecycleError("task_not_found");
		return this.storage.transaction(async (tx) => {
			const task = await tx.tasks.get(taskId);
			// 他人任务按不存在处理，不确认「这个 id 存在但不是你的」。
			if (!task || task.ownerId !== ownerId)
				throw new TaskLifecycleError("task_not_found");
			const existing = deletionOf(task);
			if (existing) return viewOf(task, false);

			const at = this.now();
			const restricted = restrictForDeletion(task, at, ownerId);
			await tx.tasks.put(restricted);

			const suppressed = noSuppression();
			const sessions = (await tx.sessions.all()).filter(
				(session) => session.taskRef?.taskId === taskId,
			);
			const sessionIds = new Set(sessions.map((session) => session.id));
			for (const session of sessions) {
				if (session.status !== "planning" && session.status !== "awaiting_input")
					continue;
				await tx.sessions.put({ ...session, status: "cancelled" });
				suppressed.sessions += 1;
			}

			// 会话内待处理动作对应的 inbox：直接按业务拒绝，旧卡点击不再排队。
			const roundIds = new Set(
				(await tx.rounds.all())
					.filter((round) => sessionIds.has(round.sessionId))
					.map((round) => round.id),
			);
			const actionRefs = new Set(
				(await tx.actions.all())
					.filter((action) => roundIds.has(action.roundId))
					.map((action) => action.id),
			);
			const inboxIds = new Set<string>();
			for (const inbox of await tx.inbox.all()) {
				if (inbox.status !== "pending" || !actionRefs.has(inbox.command.actionRef))
					continue;
				await tx.inbox.put({ ...inbox, status: "rejected", reason: "task_deleted" });
				inboxIds.add(inbox.id);
				suppressed.inboxes += 1;
			}

			const deliveryIds = new Set<string>();
			for (const delivery of await tx.deliveries.all()) {
				if (delivery.status !== "pending") continue;
				if (!delivery.sessionId || !sessionIds.has(delivery.sessionId)) continue;
				await tx.deliveries.put({ ...delivery, status: "cancelled" });
				deliveryIds.add(delivery.id);
				suppressed.deliveries += 1;
			}

			const affectedBatches = new Set<string>();
			for (const item of await tx.notificationItems.all()) {
				if (
					item.ownerId !== ownerId ||
					item.taskId !== taskId ||
					item.status !== "queued"
				)
					continue;
				await tx.notificationItems.put({
					...item,
					status: "cancelled",
					updatedAt: at,
				});
				affectedBatches.add(item.batchId);
				suppressed.items += 1;
			}
			const queuedBatches = (await tx.notificationBatches.all()).filter(
				(batch) => batch.status === "queued" && affectedBatches.has(batch.id),
			);
			for (const batch of queuedBatches) {
				const remaining = (await tx.notificationItems.all()).some(
					(item) => item.batchId === batch.id && item.status === "queued",
				);
				if (remaining) continue;
				await tx.notificationBatches.put({
					...batch,
					status: "cancelled",
					statusReason: "task_deleted",
					updatedAt: at,
				});
				suppressed.batches += 1;
			}

			const alertIds = new Set(
				(await tx.investigationAlerts.all())
					.filter((alert) => alert.taskId === taskId)
					.map((alert) => alert.id),
			);
			for (const job of await tx.jobs.all()) {
				// running 任务不能被打断，由 worker 的发送前守卫兜底。
				if (job.status !== "pending") continue;
				const task = job.task;
				const affected =
					task.kind === "send_delivery" ||
					task.kind === "send_investigation_decision"
						? deliveryIds.has(task.deliveryId)
						: task.kind === "send_digest"
							? affectedBatches.has(task.batchId)
							: task.kind === "process_inbox"
								? inboxIds.has(task.inboxId)
								: task.kind === "prepare_round"
									? sessionIds.has(task.sessionId)
									: alertIds.has(task.alertId);
				if (!affected) continue;
				await tx.jobs.put({ ...job, status: "cancelled" });
				suppressed.jobs += 1;
			}

			await this.recordIn(tx, {
				actorId: ownerId,
				action: "task.deletion.requested",
				objectKind: "task",
				objectId: taskId,
				at,
				outcome: "accepted",
				version: task.currentVersion,
			});
			for (const [objectKind, count] of [
				["notification_item", suppressed.items],
				["delivery", suppressed.deliveries],
				["job", suppressed.jobs],
			] as const) {
				if (count === 0) continue;
				await this.recordIn(tx, {
					actorId: ownerId,
					action: "task.deletion.suppressed",
					objectKind,
					objectId: taskId,
					at,
					outcome: "accepted",
					reason: "task_deleted",
					count,
				});
			}

			return { ...viewOf(restricted, true), suppressed };
		});
	}

	/** 本人可见的删除状态；未删除或不属于本人时返回 null。 */
	async viewDeletion(
		ownerId: string,
		taskId: string,
	): Promise<TaskDeletionView | null> {
		return this.storage.transaction(async (tx) => {
			const task = await tx.tasks.get(taskId);
			if (!task || task.ownerId !== ownerId || !deletionOf(task)) return null;
			return viewOf(task, false);
		});
	}

	private async recordIn(
		tx: Transaction,
		record: Omit<AuditRecord, "id">,
	): Promise<void> {
		await tx.auditEvents.put({ ...record, id: this.id() });
	}
}
