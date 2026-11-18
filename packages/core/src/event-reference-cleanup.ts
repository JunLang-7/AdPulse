// 任务删除后的引用清理（#144 S3）：
// 事件是独立证据，不因任务删除而销毁；但指向已删任务的 taskRefs 要清掉，
// 否则详情页 404、筛选解释引用不存在的任务。系统会话的 taskRef 在任务物理清理时
// 随会话一起消失（清理定位依赖它），删除时只审计计数。
//
// 不变量：
// 1) 只清引用，不改证据：不推进 evidenceRevision、不产生新版本，避免「删任务」触发通知。
// 2) 审计只记对象引用与原因，不含标题或正文。
// 3) 幂等：重复执行同一清理不产生第二条审计、不写第二次。
import type { Transaction } from "./ports/storage.js";

export interface ReferenceCleanupResult {
	/** 被清理 taskRefs 的事件数。 */
	events: number;
	/** 引用该任务的系统会话数（指针随任务清理一并消失，此处只审计计数）。 */
	sessions: number;
}

/** 在任务删除事务内调用：清掉事件与系统会话里指向该任务的引用。 */
export async function cleanTaskReferencesIn(
	tx: Transaction,
	ownerId: string,
	taskId: string,
	at: string,
	auditKey: string,
): Promise<ReferenceCleanupResult> {
	let events = 0;
	for (const version of await tx.marketEventVersions.listByOwner(ownerId)) {
		if (!version.input.taskRefs.some((ref) => ref.taskId === taskId)) continue;
		// 只移除该任务的引用，保留其他任务关联与全部证据内容；
		// 不写新版本（写新版本会推进 createdAt，等于给事件续期）。
		const taskRefs = version.input.taskRefs.filter((ref) => ref.taskId !== taskId);
		const input = { ...version.input, taskRefs };
		const changed = (await tx.marketEventVersions.get(version.id)) ?? version;
		await tx.marketEventVersions.put({ ...changed, input: structuredClone(input) });
		events += 1;
	}

	let sessions = 0;
	for (const session of await tx.sessions.listByOwner(ownerId)) {
		if (session.taskRef?.taskId !== taskId) continue;
		// 会话的 taskRef 不能在这里去掉：任务清理（lifecycle-cleanup.cleanIn）靠它定位
		// 没有 ownerId 的决策卡投递（session → delivery 链）。指针改在清理完成时去掉
		// （cleanIn 删除会话时指针随之消失），此处只计数与审计。
		sessions += 1;
	}

	if (events > 0 || sessions > 0) {
		await tx.auditEvents.put({
			id: `audit:task-refs:${auditKey}`,
			at,
			kind: "task_refs_cleaned",
			actorId: "system",
			objectId: taskId,
			detail: `events=${events};sessions=${sessions}`,
		});
	}
	return { events, sessions };
}
