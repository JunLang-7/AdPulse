// 删除清单的外置与重放（#40 S4b 演练能力）。
//
// 为什么需要：恢复一份**早于删除请求**的备份时，备份里根本没有删除清单。
// 所以清单必须独立于数据库备份保存（append-only），恢复时先重放清单、再启用服务。
//
// 本文件只做纯逻辑（序列化/反序列化/到期判定），不碰网络与文件系统，便于固定时钟测试。
import type { LifecycleDeletion } from "./state/model.js";

export interface ManifestEntry {
	id: string;
	ownerId: string;
	taskId: string;
	reason: "owner_request" | "retention_expired";
	requestedAt: string;
	deadlineAt: string;
	status: "pending" | "cleaned";
	cleanedAt?: string;
}

/** 一行一条 JSON：便于 append-only 追加与逐行重放。 */
export function serializeManifest(rows: LifecycleDeletion[]): string {
	return rows
		.map((row) => JSON.stringify({
			id: row.id,
			ownerId: row.ownerId,
			taskId: row.taskId,
			reason: row.reason ?? "owner_request",
			requestedAt: row.requestedAt,
			deadlineAt: row.deadlineAt,
			status: row.status,
			...(row.cleanedAt ? { cleanedAt: row.cleanedAt } : {}),
		} satisfies ManifestEntry))
		.join("\n") + (rows.length > 0 ? "\n" : "");
}

const validTime = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

/**
 * 逐行解析；坏行直接报错而不是跳过——重放时静默忽略一条删除请求，
 * 等于让已删数据复活，宁可中止。
 */
export function parseManifest(text: string): ManifestEntry[] {
	const entries: ManifestEntry[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(trimmed);
		} catch {
			throw new Error(`manifest line ${index + 1}: invalid JSON`);
		}
		const entry = raw as Partial<ManifestEntry>;
		if (typeof entry.id !== "string" || !entry.id
			|| typeof entry.ownerId !== "string" || !entry.ownerId
			|| typeof entry.taskId !== "string" || !entry.taskId
			|| !validTime(entry.requestedAt) || !validTime(entry.deadlineAt)
			|| (entry.reason !== undefined && !["owner_request", "retention_expired"].includes(entry.reason))
			|| (entry.status !== undefined && !["pending", "cleaned"].includes(entry.status)))
			throw new Error(`manifest line ${index + 1}: invalid entry`);
		entries.push({
			id: entry.id,
			ownerId: entry.ownerId,
			taskId: entry.taskId,
			reason: entry.reason ?? "owner_request",
			requestedAt: entry.requestedAt,
			deadlineAt: entry.deadlineAt,
			status: entry.status ?? "pending",
			...(entry.cleanedAt ? { cleanedAt: entry.cleanedAt } : {}),
		});
	}
	return entries;
}

/**
 * 重放计划：同一任务在清单里出现多次时以**最早**的请求为准（更早删除的语义不应被后来的记录覆盖）；
 * 已达到 deadline 的条目要在恢复完成后立即清理，而不是等在线库的下一轮 tick。
 */
export function replayPlan(entries: ManifestEntry[], now: Date): {
	applicable: ManifestEntry[];
	dueNow: ManifestEntry[];
} {
	const byTask = new Map<string, ManifestEntry>();
	for (const entry of entries) {
		const key = `${entry.ownerId}:${entry.taskId}`;
		const current = byTask.get(key);
		if (!current || Date.parse(entry.requestedAt) < Date.parse(current.requestedAt))
			byTask.set(key, entry);
	}
	const applicable = [...byTask.values()].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
	return {
		applicable,
		dueNow: applicable.filter((entry) => Date.parse(entry.deadlineAt) <= now.getTime()),
	};
}
