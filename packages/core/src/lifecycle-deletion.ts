// 本人确认删除（#40 S2）：
// 同一事务内建立「立即不可访问」状态、抑制该任务的待发提醒、写入删除清单。
// 物理清理在 S3；本片只保证删除后旧任务与其历史一律不可访问（含重建同名任务后）。
import { cleanTaskReferencesIn } from "./event-reference-cleanup.js";
import { MS_PER_DAY, ONLINE_CLEANUP_DAYS } from "./lifecycle.js";
import { lifecycleManifestId } from "./lifecycle-cleanup.js";
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
	lifecycleManifestId(ownerId, taskId);

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

		// #144 S3：清掉事件 taskRefs 与系统会话 taskRef 里指向该任务的引用；
		// 事件本体保留，不改证据、不推进版本。
		await cleanTaskReferencesIn(tx, ownerId, taskId, at, id);

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
			reason: "owner_request",
			requestedAt: at,
			deadlineAt: new Date(Date.parse(at) + ONLINE_CLEANUP_DAYS * MS_PER_DAY).toISOString(),
			status: "pending",
		};
		await tx.lifecycleDeletions.put(manifest);
		await tx.auditEvents.put({
			id: `audit:delete:${id}`,
			at,
			kind: "task_deleted",
			actorId: ownerId,
			objectId: taskId,
			detail: "owner_request",
		});
		return { manifest, created: true };
	}

	/**
	 * 本人范围内的**任务**删除清单（供控制台与清理任务使用）。
	 * 事件删除清单（#144）由事件侧接口展示，不混进任务清理进度，避免出现永远排队的「已删除的任务」。
	 */
	async list(ownerId: string): Promise<LifecycleDeletion[]> {
		return this.storage.transaction(async (tx) =>
			(await tx.lifecycleDeletions.all())
				.filter((row) => row.ownerId === ownerId && typeof row.taskId === "string")
				.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
		);
	}

	/**
	 * 备份恢复后的清单重放：把外置清单写回库中。
	 *
	 * 外置清单是**删除台账**，不是清理进度：即使源库里这份清单已经 `cleaned`，
	 * 恢复出来的旧备份里数据仍然存在，所以重放一律写回 `pending`，由清理任务重新执行（幂等）。
	 * 已存在的条目**不覆盖**（更早的请求优先）。
	 */
	async replay(entries: Array<{
		id: string; ownerId: string;
		/** 任务清单带 taskId；事件清单带 marketEventId，两者恰有一（#144 S4）。 */
		taskId?: string; marketEventId?: string;
		reason?: "owner_request" | "retention_expired";
		requestedAt: string; deadlineAt: string;
		status?: "pending" | "cleaned"; cleanedAt?: string;
	}>): Promise<{ inserted: number; kept: number }> {
		return this.storage.transaction(async (tx) => {
			let inserted = 0;
			let kept = 0;
			for (const entry of entries) {
				if ((typeof entry.taskId === "string") === (typeof entry.marketEventId === "string"))
					throw new LifecycleDeletionError(409, "manifest entry must carry exactly one of taskId or marketEventId");
				const existing = await tx.lifecycleDeletions.get(entry.id);
				if (existing) {
					kept += 1;
					continue;
				}
				await tx.lifecycleDeletions.put({
					id: entry.id,
					ownerId: entry.ownerId,
					...(typeof entry.taskId === "string" ? { taskId: entry.taskId } : { marketEventId: entry.marketEventId! }),
					reason: entry.reason ?? "owner_request",
					requestedAt: entry.requestedAt,
					deadlineAt: entry.deadlineAt,
					status: "pending",
				});
				// 清单里出现即代表本人已确认删除：恢复出来的对象必须立即限访，不能等服务再跑。
				if (typeof entry.taskId === "string") {
					const task = await tx.tasks.get(entry.taskId);
					if (task && task.ownerId === entry.ownerId && !task.deletion)
						await tx.tasks.put({
							...task,
							deletion: { at: entry.requestedAt, by: "owner", manifestId: entry.id },
						});
				} else {
					const head = await tx.marketEvents.get(entry.marketEventId!);
					if (head && head.ownerId === entry.ownerId && !head.deletion)
						await tx.marketEvents.put({
							...head,
							deletion: { at: entry.requestedAt, by: "owner", manifestId: entry.id },
						});
					// 恢复出来的待发条目立即取消：不能等发送前复检才发现输入已删。
					await this.queue.cancelPendingIn(tx, entry.ownerId, "event_deleted",
						(item) => item.marketEventRef?.eventId === entry.marketEventId!);
				}
				inserted += 1;
			}
			return { inserted, kept };
		});
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
