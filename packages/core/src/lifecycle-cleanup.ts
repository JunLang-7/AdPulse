import {
	LIFECYCLE,
	addLifecycleDays,
	deletionOf,
	isRetentionExpired,
	markCleaned,
	retentionAnchor,
} from "./lifecycle.js";
import type { Storage, Table, Transaction } from "./ports/storage.js";
import type { AuditRecord, Job, Task } from "./state/model.js";

export interface PurgeCounts {
	taskVersions: number;
	evidenceHeads: number;
	evidenceVersions: number;
	evidenceSources: number;
	evidenceOperations: number;
	comparisonResults: number;
	comparisonFollowUps: number;
	comparisonOperations: number;
	investigationAlerts: number;
	sessions: number;
	rounds: number;
	actions: number;
	snapshots: number;
	inbox: number;
	deliveries: number;
	jobs: number;
	notificationItems: number;
	notificationSelections: number;
	subscriptionTargets: number;
}

export interface PurgeResult {
	taskId: string;
	reason: "user_request" | "retention_expired";
	counts: PurgeCounts;
	total: number;
}

/** 参与检索的行只需要 id 与可选归属，避免把业务字段带进清理逻辑。 */
type RowWithId = { id: string };

async function rowsForOwner<T extends RowWithId>(
	table: Table<T>,
	ownerId: string,
): Promise<T[]> {
	if (table.listByOwner) return table.listByOwner(ownerId);
	return (await table.all()).filter(
		(row) => (row as T & { ownerId?: string }).ownerId === ownerId,
	);
}

/** 只按 id 删除；判定条件由调用方给出，清理逻辑不读也不打印业务字段。 */
async function purgeRows<T extends RowWithId>(
	table: Table<T>,
	match: (row: T) => boolean,
): Promise<{ count: number; ids: Set<string> }> {
	const ids = new Set<string>();
	for (const row of await table.all()) {
		if (!match(row)) continue;
		await table.delete(row.id);
		ids.add(row.id);
	}
	return { count: ids.size, ids };
}

async function purgeOwnerRows<T extends RowWithId & { ownerId?: string }>(
	table: Table<T>,
	ownerId: string,
	match: (row: T) => boolean,
): Promise<{ count: number; ids: Set<string> }> {
	const ids = new Set<string>();
	for (const row of await rowsForOwner(table, ownerId)) {
		if (!match(row)) continue;
		await table.delete(row.id);
		ids.add(row.id);
	}
	return { count: ids.size, ids };
}

const emptyCounts = (): PurgeCounts => ({
	taskVersions: 0,
	evidenceHeads: 0,
	evidenceVersions: 0,
	evidenceSources: 0,
	evidenceOperations: 0,
	comparisonResults: 0,
	comparisonFollowUps: 0,
	comparisonOperations: 0,
	investigationAlerts: 0,
	sessions: 0,
	rounds: 0,
	actions: 0,
	snapshots: 0,
	inbox: 0,
	deliveries: 0,
	jobs: 0,
	notificationItems: 0,
	notificationSelections: 0,
	subscriptionTargets: 0,
});

const totalOf = (counts: PurgeCounts): number =>
	Object.values(counts).reduce((sum, value) => sum + value, 0);

/**
 * 在线清理（#40 PR3）。
 *
 * - `tick`：把到期/超过窗口的任务排进可重试任务队列，并按 UTC 日排一次审计清理。
 * - `purgeTask`：按归属与引用图物理删除任务业务资料，保留无业务内容的 head 与清理时间；
 *   同一事务内完成，重跑幂等（已 cleaned 直接跳过）。
 * - `purgeAudit`：删除早于 cutoff 的审计记录，保留 180 天边界内的记录。
 */
export class LifecycleCleanupService {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly id: () => string = () => crypto.randomUUID(),
	) {}

	async tick(at: string = this.now()): Promise<{ tasks: number; audit: boolean }> {
		return this.storage.transaction(async (tx) => {
			const due: string[] = [];
			for (const task of await tx.tasks.all()) {
				const deletion = deletionOf(task);
				if (deletion) {
					if (deletion.state === "restricted" && deletion.cleanupDueAt <= at)
						due.push(task.id);
					continue;
				}
				const version = await tx.taskVersions.get(
					`${task.id}:${task.currentVersion}`,
				);
				if (!version) continue;
				try {
					const anchor = await retentionAnchor(tx, task, version);
					if (isRetentionExpired(anchor, at)) due.push(task.id);
				} catch {
					// 时间不可解析时不把任务当作已到期；保留给人工核对，不静默删除。
				}
			}
			for (const taskId of due) {
				const jobId = `purge_task:${taskId}`;
				const existing = await tx.jobs.get(jobId);
				// done 不重排；failed 允许重新排队重试；pending/running 已有人负责。
				if (existing && existing.status !== "failed") continue;
				const job: Job = {
					id: jobId,
					task: { kind: "purge_task", taskId },
					status: "pending",
					runAt: at,
					attempts: 0,
				};
				await tx.jobs.put(job);
			}
			const day = at.slice(0, 10);
			const auditJobId = `purge_audit:${day}`;
			let audit = false;
			if (!(await tx.jobs.get(auditJobId))) {
				await tx.jobs.put({
					id: auditJobId,
					task: {
						kind: "purge_audit",
						cutoff: addLifecycleDays(at, -LIFECYCLE.auditRetentionDays),
					},
					status: "pending",
					runAt: at,
					attempts: 0,
				});
				audit = true;
			}
			return { tasks: due.length, audit };
		});
	}

	async purgeTask(
		taskId: string,
		at: string = this.now(),
	): Promise<PurgeResult | null> {
		return this.storage.transaction(async (tx) => {
			const task = await tx.tasks.get(taskId);
			if (!task) return null;
			const deletion = deletionOf(task);
			let reason: PurgeResult["reason"];
			if (deletion) {
				// 已清理过或还没到 7 天窗口：不重复删除、不提前删除。
				if (deletion.state === "cleaned") return null;
				if (deletion.cleanupDueAt > at) return null;
				reason = deletion.reason ?? "user_request";
			} else {
				const version = await tx.taskVersions.get(
					`${task.id}:${task.currentVersion}`,
				);
				if (!version) return null;
				const anchor = await retentionAnchor(tx, task, version);
				if (!isRetentionExpired(anchor, at)) return null;
				reason = "retention_expired";
			}

			const counts = await purgeTaskRowsIn(tx, task);
			// head 只保留身份、版本号与删除状态，业务内容随版本一起删除。
			await tx.tasks.put(markCleaned(task, at, reason));

			const actorId = deletion?.requestedBy ?? "system";
			const record: Omit<AuditRecord, "id"> = {
				actorId,
				action:
					reason === "retention_expired"
						? "task.retention.purged"
						: "task.deletion.cleaned",
				objectKind: "task",
				objectId: task.id,
				at,
				outcome: "accepted",
				reason,
				count: totalOf(counts),
			};
			await tx.auditEvents.put({ ...record, id: this.id() });

			return { taskId: task.id, reason, counts, total: totalOf(counts) };
		});
	}

	/** 180 天边界按「早于 cutoff」删除；恰好等于 cutoff 的记录保留。 */
	async purgeAudit(cutoff: string): Promise<number> {
		const cutoffMs = Date.parse(cutoff);
		if (!Number.isFinite(cutoffMs))
			throw new Error("invalid audit cutoff");
		return this.storage.transaction(async (tx) => {
			let purged = 0;
			for (const record of await tx.auditEvents.all()) {
				if (Date.parse(record.at) >= cutoffMs) continue;
				await tx.auditEvents.delete(record.id);
				purged += 1;
			}
			if (purged > 0)
				await tx.auditEvents.put({
					id: this.id(),
					actorId: "system",
					action: "audit.purged",
					objectKind: "audit",
					objectId: "auditEvents",
					at: this.now(),
					outcome: "accepted",
					count: purged,
				});
			return purged;
		});
	}
}

/**
 * 任务归属图的物理删除：先收集引用 id，再逐表删除；不依赖前端隐藏，
 * 也不落任何业务字段到日志或审计。
 */
async function purgeTaskRowsIn(
	tx: Transaction,
	task: Task,
): Promise<PurgeCounts> {
	const counts = emptyCounts();
	const ownerId = task.ownerId;

	counts.taskVersions = (
		await purgeRows(tx.taskVersions, (row) => row.taskId === task.id)
	).count;

	const heads = await purgeOwnerRows(
		tx.evidenceHeads,
		ownerId,
		(row) => row.taskId === task.id,
	);
	counts.evidenceHeads = heads.count;
	const evidenceIds = heads.ids;
	counts.evidenceVersions = (
		await purgeOwnerRows(
			tx.evidenceVersions,
			ownerId,
			(row) => row.taskId === task.id || evidenceIds.has(row.evidenceId),
		)
	).count;
	counts.evidenceSources = (
		await purgeOwnerRows(tx.evidenceSources, ownerId, (row) =>
			evidenceIds.has(row.evidenceId),
		)
	).count;
	counts.evidenceOperations = (
		await purgeOwnerRows(tx.evidenceOperations, ownerId, (row) =>
			row.results.some((result) => evidenceIds.has(result.evidenceId)),
		)
	).count;

	const results = await purgeOwnerRows(
		tx.comparisonResults,
		ownerId,
		(row) => row.taskId === task.id,
	);
	counts.comparisonResults = results.count;
	const followUps = await purgeOwnerRows(
		tx.comparisonFollowUps,
		ownerId,
		(row) => row.taskId === task.id,
	);
	counts.comparisonFollowUps = followUps.count;
	counts.comparisonOperations = (
		await purgeOwnerRows(tx.comparisonOperations, ownerId, (row) =>
			Boolean(
				(row.resultId && results.ids.has(row.resultId)) ||
					(row.followUpId && followUps.ids.has(row.followUpId)),
			),
		)
	).count;

	const alerts = await purgeOwnerRows(
		tx.investigationAlerts,
		ownerId,
		(row) => row.taskId === task.id,
	);
	counts.investigationAlerts = alerts.count;

	const sessions = await purgeOwnerRows(
		tx.sessions,
		ownerId,
		(row) => row.taskRef?.taskId === task.id,
	);
	counts.sessions = sessions.count;
	const sessionIds = sessions.ids;
	const rounds = await purgeRows(tx.rounds, (row) =>
		sessionIds.has(row.sessionId),
	);
	counts.rounds = rounds.count;
	const actions = await purgeRows(tx.actions, (row) =>
		rounds.ids.has(row.roundId),
	);
	counts.actions = actions.count;
	counts.snapshots = (
		await purgeRows(tx.snapshots, (row) => sessionIds.has(row.sessionId))
	).count;
	const inbox = await purgeRows(tx.inbox, (row) =>
		actions.ids.has(row.command.actionRef),
	);
	counts.inbox = inbox.count;
	// 决策投递不带 ownerId（日汇总才有），按会话归属检索，不能按 owner 过滤漏删。
	const deliveries = await purgeRows(tx.deliveries, (row) =>
		Boolean(row.sessionId && sessionIds.has(row.sessionId)),
	);
	counts.deliveries = deliveries.count;

	counts.jobs = (
		await purgeRows(
			tx.jobs,
			(job) => job.id !== `purge_task:${task.id}` && jobMatchesTask(job, {
				sessionIds,
				deliveryIds: deliveries.ids,
				inboxIds: inbox.ids,
				alertIds: alerts.ids,
			}),
		)
	).count;

	counts.notificationItems = (
		await purgeOwnerRows(
			tx.notificationItems,
			ownerId,
			(row) => row.taskId === task.id,
		)
	).count;
	counts.notificationSelections = (
		await purgeOwnerRows(tx.notificationSelections, ownerId, (row) =>
			row.taskId === task.id ||
			Boolean(row.alertId && alerts.ids.has(row.alertId)),
		)
	).count;
	// 订阅对象按 userId 归属（不是 ownerId），因此走通用扫描。
	counts.subscriptionTargets = (
		await purgeRows(
			tx.subscriptionTargets,
			(row) =>
				row.userId === ownerId && row.kind === "task" && row.refId === task.id,
		)
	).count;

	// 清理时间只写进任务 head 的删除状态；其余业务行已物理删除。
	return counts;
}

function jobMatchesTask(
	job: Job,
	refs: {
		sessionIds: Set<string>;
		deliveryIds: Set<string>;
		inboxIds: Set<string>;
		alertIds: Set<string>;
	},
): boolean {
	const task = job.task;
	if (task.kind === "send_delivery" || task.kind === "send_investigation_decision")
		return refs.deliveryIds.has(task.deliveryId);
	if (task.kind === "prepare_round") return refs.sessionIds.has(task.sessionId);
	if (task.kind === "process_inbox") return refs.inboxIds.has(task.inboxId);
	if (task.kind === "prepare_investigation_alert_session")
		return refs.alertIds.has(task.alertId);
	return false;
}
