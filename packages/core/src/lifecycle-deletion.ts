// 本人确认删除（#40 S2）：
// 同一事务内建立「立即不可访问」状态、抑制该任务的待发提醒、写入删除清单。
// 物理清理在 S3；本片只保证删除后旧任务与其历史一律不可访问（含重建同名任务后）。
import { createHash } from "node:crypto";
import { MS_PER_DAY, ONLINE_CLEANUP_DAYS } from "./lifecycle.js";
import { NotificationQueue } from "./notifications-queue.js";
import type { Storage, Transaction } from "./ports/storage.js";
import type { LifecycleDeletion, Task } from "./state/model.js";

export class LifecycleDeletionError extends Error {
	constructor(readonly status: 404 | 409, message: string) {
		super(message);
		this.name = "LifecycleDeletionError";
	}
}

export interface DeletionResult {
	manifest: LifecycleDeletion;
	/** true 表示本次真正写入；false 表示此前已删除（幂等返回原清单）。 */
	created: boolean;
}

const manifestId = (ownerId: string, taskId: string): string =>
	createHash("sha256").update(JSON.stringify([ownerId, taskId])).digest("hex");

export class LifecycleDeletionService {
	private readonly queue: NotificationQueue;
	constructor(private readonly storage: Storage, private readonly now = () => new Date().toISOString()) {
		this.queue = new NotificationQueue(storage, () => new Date(this.now()));
	}

	/**
	 * 本人确认删除任务及其全部关联。
	 * 幂等：重复提交返回同一清单；并发写入由 `runExclusive` 串行化，不会产生两份清单。
	 */
	async requestDelete(ownerId: string, taskId: string): Promise<DeletionResult> {
		const lock = await this.storage.runExclusive(
			`lifecycle-delete:${ownerId}:${taskId}`,
			() => this.storage.transaction((tx) => this.deleteIn(tx, ownerId, taskId)),
		);
		if (!lock.acquired)
			throw new LifecycleDeletionError(409, "deletion already in progress");
		return lock.value!;
	}

	private async deleteIn(tx: Transaction, ownerId: string, taskId: string): Promise<DeletionResult> {
		const task = await tx.tasks.get(taskId);
		if (!task || task.ownerId !== ownerId)
			throw new LifecycleDeletionError(404, "task not found");

		const id = manifestId(ownerId, taskId);
		const existing = await tx.lifecycleDeletions.get(id);
		if (existing) return { manifest: existing, created: false };

		const at = new Date(this.now()).toISOString();
		await tx.tasks.put({
			...task,
			deletion: { at, by: "owner", manifestId: id },
		});

		// 抑制该任务尚未发出的提醒条目；已发送/已取消是终态，不改写。
		await this.queue.cancelPendingIn(tx, ownerId, "task_deleted", (item) => item.taskId === taskId);

		// 抑制该任务关联的决策卡待发（只动本人、且只动这个任务的告警会话）。
		const alertIds = new Set(
			(await tx.investigationAlerts.all())
				.filter((alert) => alert.ownerId === ownerId && alert.taskId === taskId)
				.map((alert) => alert.id),
		);
		for (const delivery of await tx.deliveries.all()) {
			if (!delivery.proactiveDecision || !["pending", "failed"].includes(delivery.status)) continue;
			const session = delivery.sessionId ? await tx.sessions.get(delivery.sessionId) : null;
			if (session?.ownerId !== ownerId) continue;
			if (!session.investigationAlertId || !alertIds.has(session.investigationAlertId)) continue;
			await tx.deliveries.put({ ...delivery, status: "suppressed", suppressionReason: "task_deleted" });
		}

		const manifest: LifecycleDeletion = {
			id,
			ownerId,
			taskId,
			requestedAt: at,
			deadlineAt: new Date(Date.parse(at) + ONLINE_CLEANUP_DAYS * MS_PER_DAY).toISOString(),
			status: "pending",
		};
		await tx.lifecycleDeletions.put(manifest);
		return { manifest, created: true };
	}

	/** 本人范围内的删除清单查询（供控制台与 S3 清理任务使用）。 */
	async list(ownerId: string): Promise<LifecycleDeletion[]> {
		return this.storage.transaction(async (tx) =>
			(await tx.lifecycleDeletions.all())
				.filter((row) => row.ownerId === ownerId)
				.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
		);
	}

	/** 内部使用：S3 清理任务按状态取待清理清单。 */
	async pending(): Promise<LifecycleDeletion[]> {
		return this.storage.transaction(async (tx) =>
			(await tx.lifecycleDeletions.all())
				.filter((row) => row.status === "pending")
				.sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt)),
		);
	}
}

export type { Task };
