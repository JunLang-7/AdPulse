// 在线清理（#40 S3）：删除清单到期后，把该任务及其关联业务数据从在线库物理删除。
//
// 四条不变量：
// 1) 只清理**已到期**的清单（本人删除满 7 天、保留期到期）；未到期不动任何数据。
// 2) 清理可重试：中途失败时清单保持 pending，下一次 tick 从头重放；重放不会报错。
// 3) 只动本清单所属任务的数据，不碰其他用户、不碰来源域（#41 另有保留策略）。
// 4) 最小审计只记动作与对象引用，180 天后独立清理；不因业务删除而延长业务原文留存。
import { createHash } from "node:crypto";
import { eventLifecycleIn } from "./event-lifecycle.js";
import { AUDIT_RETENTION_DAYS, MS_PER_DAY, taskLifecycleIn } from "./lifecycle.js";
import type { Storage, Transaction } from "./ports/storage.js";
import type { Entities, LifecycleDeletion } from "./state/model.js";

export interface CleanupResult {
	manifests: number;
	removed: Record<string, number>;
	/** 本次新排入的保留期到期清单数。 */
	scheduled: number;
	/** 本次清理掉的过期审计条数。 */
	auditPurged: number;
	/** 本轮失败、仍为 pending 的清单 id（下轮重试）。 */
	failed: string[];
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
		const scheduled = await this.scheduleExpiredIn(at);
		const due = (await new LifecycleCleanupReader(this.storage).due(at)).slice(0, 50);
		const removed: Record<string, number> = {};
		const failed: string[] = [];
		let manifests = 0;
		// 逐份隔离：单份失败只保留它自己的 pending，不能拖停其他清单与审计清理。
		for (const manifest of due) {
			try {
				const lock = await this.storage.runExclusive(
					`lifecycle-cleanup:${manifest.id}`,
					() => this.storage.transaction((tx) => this.cleanDispatchIn(tx, manifest, at)),
				);
				// 另一个进程正在清这一份：跳过，下次 tick 再看。
				if (!lock.acquired || !lock.value) continue;
				manifests += 1;
				for (const [table, count] of Object.entries(lock.value)) removed[table] = (removed[table] ?? 0) + count;
			} catch (error) {
				failed.push(manifest.id);
				console.error(
					`lifecycle cleanup failed for ${manifest.taskId}; stays pending: ${error instanceof Error ? error.message : "unknown"}`,
				);
			}
		}
		let auditPurged = 0;
		try {
			auditPurged = await this.purgeAuditIn(at);
		} catch (error) {
			console.error(`audit purge failed; will retry: ${error instanceof Error ? error.message : "unknown"}`);
		}
		return { manifests, removed, scheduled, auditPurged, failed };
	}

	/** 清单分派：任务清单走任务清理，事件清单走事件清理（#144 S4）。 */
	/** 到期事件的清单调度：与任务同款，`deadlineAt=expiresAt`（到期即可清）。 */
	private async scheduleExpiredEventsIn(at: string): Promise<number> {
		const now = new Date(at);
		const candidates = await this.storage.transaction(async (tx) => {
			const existing = new Set((await tx.lifecycleDeletions.all())
				.filter((row) => typeof row.marketEventId === "string")
				.map((row) => `${row.ownerId}:${row.marketEventId}`));
			const out: Array<{ id: string; ownerId: string; marketEventId: string; requestedAt: string; deadlineAt: string; status: "pending"; reason: "retention_expired" }> = [];
			for (const head of await tx.marketEvents.all()) {
				if (existing.has(`${head.ownerId}:${head.id}`)) continue;
				if (head.deletion) continue;
				const lifecycle = await eventLifecycleIn(tx, head, now);
				if (!lifecycle.expired || lifecycle.state === "deleted") continue;
				out.push({
					id: lifecycleManifestId(head.ownerId, head.id),
					ownerId: head.ownerId,
					marketEventId: head.id,
					requestedAt: lifecycle.expiresAt,
					deadlineAt: lifecycle.expiresAt,
					status: "pending",
					reason: "retention_expired",
				});
				if (out.length >= 50) break;
			}
			return out;
		});
		if (candidates.length === 0) return 0;
		return this.storage.transaction(async (tx) => {
			let created = 0;
			for (const manifest of candidates) {
				if (await tx.lifecycleDeletions.get(manifest.id)) continue;
				await tx.lifecycleDeletions.put(manifest);
				await tx.auditEvents.put({
					id: `audit:event-expiry:${manifest.id}`,
					at,
					kind: "event_deleted",
					actorId: "system",
					objectId: manifest.marketEventId,
					detail: "retention_expired",
				});
				created += 1;
			}
			return created;
		});
	}

	/** 清单分派：任务清单走任务清理，事件清单走事件清理（#144 S4）。 */
	private async cleanDispatchIn(
		tx: Transaction,
		manifest: LifecycleDeletion,
		at: string,
	): Promise<Record<string, number> | null> {
		return typeof manifest.marketEventId === "string"
			? this.cleanEventIn(tx, manifest as LifecycleDeletion & { marketEventId: string }, at)
			: this.cleanIn(tx, manifest as LifecycleDeletion & { taskId: string }, at);
	}

	/**
	 * 保留期到期（365 天）的任务与事件都要物理清理，而不是永远只是"不可访问"。
	 * 复用同一份删除清单：`reason=retention_expired`，`deadlineAt=expiresAt`（到期即可清）。
	 */
	private async scheduleExpiredIn(at: string): Promise<number> {
		const taskScheduled = await this.scheduleExpiredTasksIn(at);
		const eventScheduled = await this.scheduleExpiredEventsIn(at);
		return taskScheduled + eventScheduled;
	}

	private async scheduleExpiredTasksIn(at: string): Promise<number> {
		const now = new Date(at);
		const candidates = await this.storage.transaction(async (tx) => {
			const existing = new Set((await tx.lifecycleDeletions.all())
				.filter((row) => typeof row.taskId === "string")
				.map((row) => `${row.ownerId}:${row.taskId}`));
			const out: Array<{ id: string; ownerId: string; taskId: string; requestedAt: string; deadlineAt: string; status: "pending"; reason: "retention_expired" }> = [];
			for (const task of await tx.tasks.all()) {
				if (existing.has(`${task.ownerId}:${task.id}`)) continue;
				const lifecycle = await taskLifecycleIn(tx, task, now);
				if (!lifecycle.expired || lifecycle.state === "deleted") continue;
				out.push({
					id: lifecycleManifestId(task.ownerId, task.id),
					ownerId: task.ownerId,
					taskId: task.id,
					requestedAt: lifecycle.expiresAt,
					deadlineAt: lifecycle.expiresAt,
					status: "pending",
					reason: "retention_expired",
				});
				if (out.length >= 50) break;
			}
			return out;
		});
		if (candidates.length === 0) return 0;
		return this.storage.transaction(async (tx) => {
			let created = 0;
			for (const manifest of candidates) {
				if (await tx.lifecycleDeletions.get(manifest.id)) continue;
				await tx.lifecycleDeletions.put(manifest);
				await tx.auditEvents.put({
					id: `audit:expiry:${manifest.id}`,
					at,
					kind: "task_deleted",
					actorId: "system",
					objectId: manifest.taskId,
					detail: "retention_expired",
				});
				created += 1;
			}
			return created;
		});
	}

	/** 最小审计保留 180 天；按 UTC 绝对时刻清理，batches 逐条删除。 */
	private async purgeAuditIn(at: string): Promise<number> {
		const cutoff = new Date(Date.parse(at) - AUDIT_RETENTION_DAYS * MS_PER_DAY).toISOString();
		return this.storage.transaction(async (tx) => {
			const expired = (await tx.auditEvents.all())
				.filter((row) => Date.parse(row.at) < Date.parse(cutoff))
				.map((row) => row.id);
			if (expired.length === 0) return 0;
			await tx.auditEvents.remove(expired);
			await tx.auditEvents.put({
				id: `audit:purge:${at.slice(0, 10)}`,
				at,
				kind: "audit_purged",
				actorId: "system",
				detail: `removed ${expired.length}`,
			});
			return expired.length;
		});
	}

	/**
	 * 事件清单的物理清理（#144 S4）：
	 * - 删全部版本（含材料引用）、别名、操作幂等记录与派生的通知条目/筛选记录；
	 * - **保留 head 骨架**（含 deletion 标记）：读取侧脱敏与「为什么打不开」的解释都靠它，
	 *   且与定稿一致——到期不删记录骨架；审计引用也可追溯。
	 */
	private async cleanEventIn(
		tx: Transaction,
		manifest: LifecycleDeletion & { marketEventId: string },
		at: string,
	): Promise<Record<string, number> | null> {
		const current = await tx.lifecycleDeletions.get(manifest.id);
		if (!current || current.status !== "pending" || typeof current.marketEventId !== "string") return null;
		const { ownerId, marketEventId: eventId } = current as LifecycleDeletion & { marketEventId: string };

		const versionIds = (await tx.marketEventVersions.all())
			.filter((row) => row.ownerId === ownerId && row.eventId === eventId)
			.map((row) => row.id);
		const aliasIds = (await tx.marketEventAliases.all())
			.filter((row) => row.ownerId === ownerId && row.eventId === eventId)
			.map((row) => row.id);
		// 操作幂等记录只有 versionId（`eventId:version`）：按前缀归属到本事件。
		const prefix = `${eventId}:`;
		const operationIds = (await tx.marketEventOperations.all())
			.filter((row) => row.ownerId === ownerId && row.versionId.startsWith(prefix))
			.map((row) => row.id);
		const itemIds = (await tx.notificationItems.all())
			.filter((row) => row.ownerId === ownerId && row.marketEventRef?.eventId === eventId)
			.map((row) => row.id);
		const selectionIds = (await tx.notificationSelections.all())
			.filter((row) => row.ownerId === ownerId && row.marketEventRef?.eventId === eventId)
			.map((row) => row.id);

		const removed: Record<string, number> = {};
		const strip = async (table: "marketEventVersions" | "marketEventAliases" | "marketEventOperations"
			| "notificationItems" | "notificationSelections", ids: string[]) => {
			if (ids.length === 0) return;
			const count = await tx[table].remove(ids);
			if (count > 0) removed[table] = count;
		};
		await strip("notificationSelections", selectionIds);
		await strip("notificationItems", itemIds);
		await strip("marketEventOperations", operationIds);
		await strip("marketEventAliases", aliasIds);
		await strip("marketEventVersions", versionIds);

		// head 保留骨架：owner_request 的删除标记在删除时已写入（S2）；到期清单不加删除标记，
		// 状态保持 expired——「存满一年」和「本人删除」在读取侧是两种解释。
		// 版本已删，锚点退回 head.createdAt，到期判定不变。

		await tx.lifecycleDeletions.put({ ...current, status: "cleaned", cleanedAt: at });
		await tx.auditEvents.put({
			id: `audit:event-purged:${manifest.id}`,
			at,
			kind: "event_purged",
			actorId: "system",
			objectId: eventId,
			detail: current.reason ?? "owner_request",
		});
		return removed;
	}

	/**
	 * 事件清单的物理清理（#144 S4）——见上方实现；此注释占位避免重复声明。
	 */
	private async cleanIn(
		tx: Transaction,
		manifest: LifecycleDeletion & { taskId: string },
		at: string,
	): Promise<Record<string, number> | null> {
		const current = await tx.lifecycleDeletions.get(manifest.id);
		if (!current || current.status !== "pending" || typeof current.taskId !== "string") return null;
		const { ownerId, taskId } = current as LifecycleDeletion & { taskId: string };

		// 归属检索：先算出本任务的全部引用 id，再按依赖顺序批量删除。
		// 归属检索走 listByOwner（PG 上是 data->>'ownerId' + 索引），不做整表扫描。
		const alertIds = new Set(
			(await tx.investigationAlerts.listByOwner(ownerId))
				.filter((row) => row.taskId === taskId)
				.map((row) => row.id),
		);
		const validationCheckIds = new Set(
			(await tx.validationChecks.listByOwner(ownerId))
				.filter((row) => row.taskId === taskId)
				.map((row) => row.id),
		);
		// S3 的引用清理会去掉已写回的 taskRef 指针，但清理定位需要它：
		// 先按清单上的 taskId 找回全部相关会话（含 taskRef 已被清掉的），
		// 再按 alertId 补充。找不到 taskRef 的会话靠删除清单兜底（见下方 or 条件）。
		const sessions = (await tx.sessions.listByOwner(ownerId)).filter(
			(row) => row.taskRef?.taskId === taskId
				|| (row.investigationAlertId !== undefined && alertIds.has(row.investigationAlertId)),
		);
		const sessionIds = new Set(sessions.map((row) => row.id));
		const roundIds = new Set(
			(await tx.rounds.all()).filter((row) => sessionIds.has(row.sessionId)).map((row) => row.id),
		);
		// 决策卡/结果回执由 `queueDelivery()` 创建，**没有 ownerId**；因此按已确认归属的
		// session/round 定位，而不是按 ownerId 过滤，否则会漏掉含业务正文的投递与 send_delivery 任务。
		const deliveryIds = new Set(
			(await tx.deliveries.all()).filter(
				(row) => (row.sessionId !== undefined && sessionIds.has(row.sessionId))
					|| (row.roundId !== undefined && roundIds.has(row.roundId))
					|| (row.ownerId === ownerId
						&& ((row.sessionId !== undefined && sessionIds.has(row.sessionId))
							|| (row.roundId !== undefined && roundIds.has(row.roundId)))),
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
				if (task.kind === "evaluate_validation_check")
					return validationCheckIds.has(task.checkId);
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

		// 已发送批次的卡片内容是冻结在 Delivery.card 里的副本；只删 notificationItems 会让
		// 已删任务的标题/摘要继续出现在「通知记录」里。这里按任务精确摘除，保留同批次其他条目。
		const frozenTitles = new Set(
			(await tx.notificationItems.all())
				.filter((row) => row.ownerId === ownerId && row.taskId === taskId)
				.map((row) => row.title),
		);
		const removed: Record<string, number> = {};
		let strippedCards = 0;
		for (const delivery of await tx.deliveries.listByOwner(ownerId)) {
			const card = delivery.card as {
				items?: Array<{ title: string; detailUrl?: string; [key: string]: unknown }>;
			};
			if (!Array.isArray(card.items) || card.items.length === 0) continue;
			// 优先用 detailUrl 里的任务定位；退回标题匹配，兼容没有 detailBase 的装配。
			const keep = card.items.filter((item) => {
				if (item.detailUrl?.includes(`/tasks/${taskId}`)) return false;
				return !(item.detailUrl === undefined && frozenTitles.has(item.title));
			});
			if (keep.length === card.items.length) continue;
			// 只过滤 items，其余字段原样保留；类型上与冻结卡片的联合类型保持一致。
			await tx.deliveries.put({ ...delivery, card: { ...card, items: keep } as typeof delivery.card });
			strippedCards += 1;
		}
		if (strippedCards > 0) removed.deliveryCards = strippedCards;

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
		await remove("validationChecks", [...validationCheckIds]);
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
		const hypothesisIds = new Set((await tx.hypotheses.listByOwner(ownerId))
			.filter((row) => row.taskId === taskId).map((row) => row.id));
		await remove("hypothesisOperations", (await tx.hypothesisOperations.all())
			.filter((row) => row.ownerId === ownerId
				&& row.resultRef.hypothesisId !== undefined && hypothesisIds.has(row.resultRef.hypothesisId))
			.map((row) => row.id));
		await remove("hypothesisVerdicts", (await tx.hypothesisVerdicts.all())
			.filter((row) => row.ownerId === ownerId && hypothesisIds.has(row.hypothesisId)).map((row) => row.id));
		await remove("hypothesisVersions", (await tx.hypothesisVersions.all())
			.filter((row) => row.ownerId === ownerId && hypothesisIds.has(row.hypothesisId)).map((row) => row.id));
		await remove("hypotheses", [...hypothesisIds]);
		await remove("signalAssessments", (await tx.signalAssessments.all())
			.filter((row) => row.ownerId === ownerId && row.taskId === taskId).map((row) => row.id));
		await remove("taskVersions", (await tx.taskVersions.all())
			.filter((row) => row.taskId === taskId).map((row) => row.id));
		await remove("tasks", [taskId]);

		await tx.lifecycleDeletions.put({ ...current, status: "cleaned", cleanedAt: at });
		await tx.auditEvents.put({
			id: `audit:purged:${manifest.id}`,
			at,
			kind: "task_purged",
			actorId: "system",
			objectId: taskId,
			detail: current.reason ?? "owner_request",
		});
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
					// 任务与事件清单（#144 S4 起都进在线清理），按分派函数处理。
					&& (typeof row.taskId === "string" || typeof row.marketEventId === "string")
					&& Date.parse(row.deadlineAt) <= Date.parse(at))
				.sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt)),
		);
	}
}

/** 与 LifecycleDeletionService 保持一致的确定性清单 id。 */
export function lifecycleManifestId(ownerId: string, taskId: string): string {
	return createHash("sha256").update(JSON.stringify([ownerId, taskId])).digest("hex");
}

export { MS_PER_DAY };
