// 生命周期（#40 S1）：只做到期判定与读取限访。
// 物理清理（7 天）、备份 30 天与 180 天最小审计在后续切片实现。
//
// 三条不变量：
// 1) 计时口径固定：UTC 绝对时刻 + 24 小时/天，不跟随服务器时区；测试可注入时钟。
// 2) 普通查看、消息重试、worker 重启都不续期；只有真正的业务写入才推进「最后有效业务更新」。
// 3) 到期即限访：判定在读取侧执行，不依赖前端隐藏。
import type { Storage, Transaction } from "./ports/storage.js";
import type { Task } from "./state/model.js";

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** 任务与必要证据/决定记录：365 天。 */
export const RETENTION_DAYS = 365;
/** 本人确认删除后，在线业务资料最多 7 天清理。 */
export const ONLINE_CLEANUP_DAYS = 7;
/** 在线清理后旧备份最多再保留 30 天（请求起总计 37 天）。 */
export const BACKUP_RETENTION_DAYS = 30;
/** 最小操作审计独立保留 180 天，不因业务删除而延长业务原文留存。 */
export const AUDIT_RETENTION_DAYS = 180;

export type TaskLifecycleState = "active" | "expired" | "deleted";

export interface TaskLifecycle {
	taskId: string;
	state: TaskLifecycleState;
	/** 计时锚点：取「最后有效业务更新」与「观测期结束」中较早的已知时刻。 */
	anchor: string;
	anchorSource: "observation_ends_at" | "last_business_update";
	/** 最后有效业务更新的时刻（任务修订、证据导入、比较、告警处理的最大值）。 */
	lastBusinessUpdate: string;
	observationEndsAt: string | null;
	expiresAt: string;
	retentionDays: number;
	/** 当前是否已到期；与 state 同源，便于直接断言「到期即限访」。 */
	expired: boolean;
	/** 本人确认删除的时刻；未删除时为 null。删除优先于到期。 */
	deletedAt: string | null;
}

const iso = (value: string | null | undefined): string | null => {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
	return new Date(value).toISOString();
};

/**
 * 最后有效业务更新：只看真正的业务写入，不看 `createdAt` 之外的读取动作。
 * 派生数据（通知、投递、任务队列）不计入，避免重试或查看延长留存。
 */
export async function lastBusinessUpdateIn(
	tx: Transaction,
	taskId: string,
	fallback: string,
): Promise<string> {
	let latest = iso(fallback) ?? new Date(0).toISOString();
	const bump = (value: string | undefined | null) => {
		const at = iso(value);
		if (at && Date.parse(at) > Date.parse(latest)) latest = at;
	};
	for (const version of await tx.taskVersions.all()) {
		if (version.taskId === taskId) bump(version.createdAt);
	}
	for (const version of await tx.evidenceVersions.all()) {
		if (version.taskId === taskId) bump(version.createdAt);
	}
	for (const result of await tx.comparisonResults.all()) {
		if (result.taskId === taskId) bump(result.createdAt);
	}
	for (const alert of await tx.investigationAlerts.all()) {
		if (alert.taskId === taskId) bump(alert.updatedAt);
	}
	return latest;
}

export function taskLifecycleOf(
	task: Task,
	lastBusinessUpdate: string,
	taskEndsAt: string | null,
): TaskLifecycle {
	const endsAt = iso(taskEndsAt);
	const update = iso(lastBusinessUpdate) ?? new Date(task.createdAt).toISOString();
	// 取较早者：有观测期结束就按结束计时，否则按最后有效业务更新，避免用派生引用续期。
	const useEnds = endsAt !== null && Date.parse(endsAt) <= Date.parse(update);
	const anchor = useEnds ? endsAt : update;
	const expiresAt = new Date(Date.parse(anchor) + RETENTION_DAYS * MS_PER_DAY).toISOString();
	return {
		taskId: task.id,
		state: "active",
		anchor,
		anchorSource: useEnds ? "observation_ends_at" : "last_business_update",
		lastBusinessUpdate: update,
		observationEndsAt: endsAt,
		expiresAt,
		retentionDays: RETENTION_DAYS,
		expired: false,
		deletedAt: null,
	};
}

/** 判定入口：读取侧统一调用，避免各服务各写一套到期规则。 */
export async function taskLifecycleIn(
	tx: Transaction,
	task: Task,
	now: Date,
): Promise<TaskLifecycle> {
	const versions = await tx.taskVersions.all();
	const current = versions.find(
		(version) => version.taskId === task.id && version.version === task.currentVersion,
	);
	const lastBusinessUpdate = await lastBusinessUpdateIn(tx, task.id, task.createdAt);
	const lifecycle = taskLifecycleOf(task, lastBusinessUpdate, current?.observation.endsAt ?? null);
	// 删除优先于到期：删了就立即不可访问，不再走保留期。
	if (task.deletion) {
		const at = new Date(task.deletion.at).toISOString();
		return { ...lifecycle, state: "deleted", expired: true, deletedAt: at };
	}
	const expired = Date.parse(lifecycle.expiresAt) <= now.getTime();
	return { ...lifecycle, state: expired ? "expired" : "active", expired, deletedAt: null };
}

/** 到期即限访：返回 false 表示不可读、不可写、不可参与通知。 */
export async function taskActiveIn(
	tx: Transaction,
	task: Task,
	now: Date,
): Promise<boolean> {
	return !(await taskLifecycleIn(tx, task, now)).expired;
}

/**
 * 服务层便捷入口：按 owner 取任务并判定。
 * 返回 null 表示不存在、非本人或已到期——对调用方保持一致的「不可访问」。
 */
export async function activeTaskIn(
	tx: Transaction,
	ownerId: string,
	taskId: string,
	now: Date,
): Promise<Task | null> {
	const task = await tx.tasks.get(taskId);
	if (!task || task.ownerId !== ownerId) return null;
	return (await taskActiveIn(tx, task, now)) ? task : null;
}

export type { Storage };
