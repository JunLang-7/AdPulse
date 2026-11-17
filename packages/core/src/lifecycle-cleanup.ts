// 在线清理（#40 S3）：删除清单到期后，把该任务及其关联业务数据从在线库物理删除。
//
// 三条不变量：
// 1) 只清理**已到期**的删除清单（requestedAt + 7 天）；未到期不动任何数据。
// 2) 清理可重试：中途失败时清单保持 pending，下一次 tick 从头重放；重放不会报错。
// 3) 只动本清单所属任务的数据，不碰其他用户、不碰来源域（#41 另有保留策略）。
import { MS_PER_DAY } from "./lifecycle.js";
import type { Storage, Transaction } from "./ports/storage.js";
import type { Entities, LifecycleDeletion } from "./state/model.js";

export interface CleanupResult {
	manifests: number;
	removed: Record<string, number>;
}

type TableName = keyof Entities;

export class LifecycleCleanupService {
	constructor(private readonly storage: Storage, private readonly now = () => new Date().toISOString()) {}

	/**
	 * 单飞清理：同一时刻只允许一个进程清理，避免双删与重复计数。
	 * 每份清单独立提交，某个任务失败不阻塞其他任务。
	 */
	async runOnce(): Promise<CleanupResult> {
		const at = new Date(this.now()).toISOString();
		const due = (await new LifecycleCleanupReader(this.storage).due(at)).slice(0, 50);
		const removed: Record<string, number> = {};
		let manifests = 0;
		for (const manifest of due) {
			const lock = await this.storage.runExclusive(
				`lifecycle-cleanup:${manifest.id}`,
				() => this.storage.transaction((tx) => this.cleanIn(tx, manifest, at)),
			);
			// 另一个进程正在清这一份：跳过，下次 tick 再看。
			if (!lock.acquired || !lock.value) continue;
			manifests += 1;
			for (const [table, count] of Object.entries(lock.value)) removed[table] = (removed[table] ?? 0) + count;
		}
		return { manifests, removed };
	}

	private async cleanIn(
		tx: Transaction,
		manifest: LifecycleDeletion,
		at: string,
	): Promise<Record<string, number> | null> {
		const current = await tx.lifecycleDeletions.get(manifest.id);
		if (!current || current.status !== "pending") return null;
		const { ownerId, taskId } = current;

		// 归属检索：先算出本任务的全部引用 id，再按依赖顺序批量删除。
		const alertIds = new Set(
			(await tx.investigationAlerts.all())
				.filter((row) => row.ownerId === ownerId && row.taskId === taskId)
				.map((row) => row.id),
		);
		const sessions = (await tx.sessions.all()).filter(
			(row) => row.ownerId === ownerId
				&& (row.taskRef?.taskId === taskId || (row.investigationAlertId && alertIds.has(row.investigationAlertId))),
		);
		const sessionIds = new Set(sessions.map((row) => row.id));
		const roundIds = new Set(
			(await tx.rounds.all()).filter((row) => sessionIds.has(row.sessionId)).map((row) => row.id),
		);
		const deliveryIds = new Set(
			(await tx.deliveries.all()).filter(
				(row) => row.ownerId === ownerId
					&& ((row.sessionId !== undefined && sessionIds.has(row.sessionId))
						|| (row.roundId !== undefined && roundIds.has(row.roundId))),
			).map((row) => row.id),
		);
		const actionIds = new Set(
			(await tx.actions.all()).filter((row) => roundIds.has(row.roundId)).map((row) => row.id),
		);
		const inboxIds = (await tx.inbox.all())
			.filter((row) => actionIds.has(row.command.actionRef))
			.map((row) => row.id);
		const jobIds = (await tx.jobs.all())
			.filter((row) => {
				const task = row.task;
				if (task.kind === "process_inbox") return inboxIds.includes(task.inboxId);
				if (task.kind === "prepare_round") return sessionIds.has(task.sessionId);
				if (task.kind === "prepare_investigation_alert_session") return alertIds.has(task.alertId);
				if (task.kind === "send_delivery" || task.kind === "send_investigation_decision")
					return deliveryIds.has(task.deliveryId);
				return false;
			})
			.map((row) => row.id);
		const itemIds = (await tx.notificationItems.all())
			.filter((row) => row.ownerId === ownerId && row.taskId === taskId)
			.map((row) => row.id);
		const selectionIds = (await tx.notificationSelections.all())
			.filter((row) => row.ownerId === ownerId
				&& (row.taskId === taskId || (row.alertId !== undefined && alertIds.has(row.alertId))))
			.map((row) => row.id);

		const removed: Record<string, number> = {};
		const remove = async (table: TableName, ids: string[]) => {
			if (ids.length === 0) return;
			const count = await tx[table].remove(ids);
			if (count > 0) removed[table] = count;
		};

		// 依赖顺序：先删引用者，再删被引用者；重放时前面的删除不会报错。
		await remove("jobs", jobIds);
		await remove("inbox", inboxIds);
		await remove("deliveries", [...deliveryIds]);
		await remove("actions", [...actionIds]);
		await remove("rounds", [...roundIds]);
		await remove("snapshots", (await tx.snapshots.all())
			.filter((row) => sessionIds.has(row.sessionId)).map((row) => row.id));
		await remove("sessions", [...sessionIds]);
		await remove("notificationItems", itemIds);
		await remove("notificationSelections", selectionIds);
		await remove("investigationAlerts", [...alertIds]);
		const resultIds = new Set((await tx.comparisonResults.all())
			.filter((row) => row.ownerId === ownerId && row.taskId === taskId).map((row) => row.id));
		const followUpIds = new Set((await tx.comparisonFollowUps.all())
			.filter((row) => row.ownerId === ownerId && row.taskId === taskId).map((row) => row.id));
		await remove("comparisonOperations", (await tx.comparisonOperations.all())
			.filter((row) => row.ownerId === ownerId
				&& (row.resultId !== undefined ? resultIds.has(row.resultId)
					: row.followUpId !== undefined && followUpIds.has(row.followUpId)))
			.map((row) => row.id));
		await remove("comparisonFollowUps", [...followUpIds]);
		await remove("comparisonResults", [...resultIds]);
		const evidenceIds = new Set((await tx.evidenceHeads.all())
			.filter((row) => row.ownerId === ownerId && row.taskId === taskId).map((row) => row.id));
		await remove("evidenceSources", (await tx.evidenceSources.all())
			.filter((row) => row.ownerId === ownerId && evidenceIds.has(row.evidenceId)).map((row) => row.id));
		await remove("evidenceVersions", (await tx.evidenceVersions.all())
			.filter((row) => row.ownerId === ownerId && row.taskId === taskId).map((row) => row.id));
		await remove("evidenceHeads", [...evidenceIds]);
		await remove("evidenceOperations", (await tx.evidenceOperations.all())
			.filter((row) => row.ownerId === ownerId
				&& row.results.some((result) => evidenceIds.has(result.evidenceId)))
			.map((row) => row.id));
		await remove("taskOperations", (await tx.taskOperations.all())
			.filter((row) => row.ownerId === ownerId && row.taskId === taskId).map((row) => row.id));
		await remove("taskVersions", (await tx.taskVersions.all())
			.filter((row) => row.taskId === taskId).map((row) => row.id));
		await remove("tasks", [taskId]);

		await tx.lifecycleDeletions.put({ ...current, status: "cleaned", cleanedAt: at });
		return removed;
	}
}

/** 读取到期清单（独立小类，避免清理服务依赖查询实现细节）。 */
class LifecycleCleanupReader {
	constructor(private readonly storage: Storage) {}
	async due(at: string): Promise<LifecycleDeletion[]> {
		return this.storage.transaction(async (tx) =>
			(await tx.lifecycleDeletions.all())
				.filter((row) => row.status === "pending"
					&& Date.parse(row.deadlineAt) <= Date.parse(at))
				.sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt)),
		);
	}
}

export { MS_PER_DAY };
