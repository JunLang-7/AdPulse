import type { Transaction } from "./ports/storage.js";
import type { Task, TaskDeletion, TaskVersion } from "./state/model.js";

const DAY_MS = 86_400_000;

/**
 * #40 已确认的生命周期口径。全部是 UTC 绝对时刻，界面另行换算北京时间；
 * 不按自然月或服务器本地时区计算。
 */
export const LIFECYCLE = {
	/** 任务、必要证据与决定记录默认保留一年（365 天）。 */
	businessRetentionDays: 365,
	/** 在线业务资料在删除请求后最多 7 天清理。 */
	onlineCleanupDays: 7,
	/** 旧备份在在线清理后最多再保留 30 天。 */
	backupRetentionDays: 30,
	/** 删除请求起 37 天为在线清理 + 旧备份的上限。 */
	cleanupTotalDays: 37,
	/** 最小操作审计独立保留 180 天，不是永久留存许可。 */
	auditRetentionDays: 180,
} as const;

export class LifecycleValidationError extends Error {
	constructor(
		readonly fieldPath: string,
		message: string,
	) {
		super(message);
		this.name = "LifecycleValidationError";
	}
}

export class TaskNotActiveError extends Error {
	constructor(readonly reason: "restricted" | "cleaned") {
		super(`task lifecycle is ${reason}`);
		this.name = "TaskNotActiveError";
	}
}

function parseUtc(value: string, fieldPath: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed))
		throw new LifecycleValidationError(fieldPath, "invalid lifecycle timestamp");
	return parsed;
}

/** UTC 绝对时刻 + 24 小时的整数倍；跨月、跨年与闰日都不走本地时区。 */
export function addLifecycleDays(value: string, days: number): string {
	const parsed = parseUtc(value, "lifecycle.at");
	if (!Number.isSafeInteger(days))
		throw new LifecycleValidationError("lifecycle.days", "invalid day count");
	return new Date(parsed + days * DAY_MS).toISOString();
}

export interface DeletionWindow {
	requestedAt: string;
	/** 在线业务资料最迟清理时刻（+7 天）。 */
	onlineCleanupDueAt: string;
	/** 含旧备份的最迟淘汰时刻（+37 天）。 */
	backupDueAt: string;
	/** 最小审计的清理时刻（+180 天）。 */
	auditDueAt: string;
}

/** 删除确认时刻推出的三个上限；调用方只展示已知值，不据此承诺已完成。 */
export function deletionWindow(requestedAt: string): DeletionWindow {
	return {
		requestedAt,
		onlineCleanupDueAt: addLifecycleDays(
			requestedAt,
			LIFECYCLE.onlineCleanupDays,
		),
		backupDueAt: addLifecycleDays(requestedAt, LIFECYCLE.cleanupTotalDays),
		auditDueAt: addLifecycleDays(requestedAt, LIFECYCLE.auditRetentionDays),
	};
}

export type RetentionAnchorSource = "observation_end" | "last_business_update";

export interface RetentionAnchor {
	anchorAt: string;
	source: RetentionAnchorSource;
}

/**
 * 「最后有效业务更新」只由业务写入决定：任务版本、证据版本、比较结果与跟进、
 * 效果告警、以及关联任务的决策会话。普通查看、投递回写、筛选记录都不续期。
 */
export async function lastBusinessUpdateAt(
	tx: Transaction,
	task: Task,
): Promise<string> {
	const candidates: string[] = [task.createdAt];
	const push = (value: string | undefined | null): void => {
		if (typeof value === "string" && Number.isFinite(Date.parse(value)))
			candidates.push(value);
	};

	for (const version of await tx.taskVersions.all())
		if (version.taskId === task.id) push(version.createdAt);
	for (const head of await tx.evidenceHeads.all())
		if (head.taskId === task.id) push(head.createdAt);
	for (const version of await tx.evidenceVersions.all())
		if (version.taskId === task.id) push(version.createdAt);
	for (const result of await tx.comparisonResults.all())
		if (result.taskId === task.id) push(result.createdAt);
	for (const followUp of await tx.comparisonFollowUps.all()) {
		if (followUp.taskId !== task.id) continue;
		push(followUp.createdAt);
		push(followUp.updatedAt);
		for (const event of followUp.events) push(event.at);
	}
	for (const alert of await tx.investigationAlerts.all()) {
		if (alert.taskId !== task.id) continue;
		push(alert.createdAt);
		push(alert.updatedAt);
		for (const event of alert.events) push(event.at);
	}
	for (const session of await tx.sessions.all())
		if (session.taskRef?.taskId === task.id) push(session.createdAt);

	return candidates.reduce((latest, candidate) =>
		parseUtc(candidate, "lifecycle.candidate") > parseUtc(latest, "lifecycle.latest")
			? candidate
			: latest,
	);
}

/**
 * 一年计时锚点：已结束/已到期任务按观察期结束时刻；没有结束时刻的任务
 * 按最后有效业务更新。未知时间不补造成确定事实。
 */
export async function retentionAnchor(
	tx: Transaction,
	task: Task,
	currentVersion: TaskVersion,
): Promise<RetentionAnchor> {
	const endsAt = currentVersion.observation?.endsAt;
	if (typeof endsAt === "string" && Number.isFinite(Date.parse(endsAt)))
		return { anchorAt: endsAt, source: "observation_end" };
	return { anchorAt: await lastBusinessUpdateAt(tx, task), source: "last_business_update" };
}

/** 保留期末尾：锚点 + 365 天。 */
export function retentionDeadline(anchor: RetentionAnchor): string {
	return addLifecycleDays(anchor.anchorAt, LIFECYCLE.businessRetentionDays);
}

/** 恰好到达末尾即视为到期，不用「小于」放宽边界。 */
export function isRetentionExpired(anchor: RetentionAnchor, now: string): boolean {
	const deadline = Date.parse(retentionDeadline(anchor));
	return deadline <= parseUtc(now, "lifecycle.now");
}

export function deletionOf(task: Task): TaskDeletion | null {
	return task.lifecycle?.deletion ?? null;
}

/** restricted 与 cleaned 都不可访问/不可处理；只有从未删除的任务是 active。 */
export function assertTaskActive(task: Task): Task {
	const deletion = deletionOf(task);
	if (deletion) throw new TaskNotActiveError(deletion.state);
	return task;
}

/** 删除确认与清理都保留原始时刻；重复确认不改写首次请求时间。 */
export function restrictForDeletion(
	task: Task,
	requestedAt: string,
	requestedBy: string,
): Task {
	const existing = deletionOf(task);
	if (existing) return task;
	const window = deletionWindow(requestedAt);
	return {
		...task,
		lifecycle: {
			deletion: {
				requestedAt,
				requestedBy,
				state: "restricted",
				cleanupDueAt: window.onlineCleanupDueAt,
			},
		},
	};
}

/** 在线清理完成标记；不删除记录本身，保留「已删除」不可访问状态与清理时间。 */
export function markCleaned(task: Task, cleanedAt: string): Task {
	const deletion = deletionOf(task);
	if (!deletion) return task;
	return {
		...task,
		lifecycle: { deletion: { ...deletion, state: "cleaned", cleanedAt } },
	};
}

/**
 * 读取任务 head，并要求本人归属且未确认删除；restricted/cleaned 一律按不存在处理，
 * 沿用调用方既有的「task not found」语义，不额外泄露删除状态。
 */
export async function activeTaskIn(
	tx: Transaction,
	taskId: string,
	ownerId: string,
): Promise<Task | null> {
	const task = await tx.tasks.get(taskId);
	if (!task || task.ownerId !== ownerId || deletionOf(task)) return null;
	return task;
}
