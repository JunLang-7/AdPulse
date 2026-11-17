// 备份淘汰（#40 S4b）：只管"备份对象"的生命周期，不负责打备份本身。
//
// 已确认口径（用户 2026-11-17）：37 天是**软目标** —— 淘汰失败只记日志与审计，不阻断新备份；
// 演练阶段不加密（仅一次性演练库），因此本模块不宣称"受控备份"。
//
// 两条规则：
// 1) 任何超过 30 天的备份对象都要删（在线清理后旧备份最多再留 30 天）。
// 2) 删除请求后 37 天：所有**早于该请求**的备份都必须消失，否则恢复旧备份会让已删数据复活。
import { BACKUP_RETENTION_DAYS, MS_PER_DAY } from "./lifecycle.js";
import type { Storage } from "./ports/storage.js";
import type { LifecycleDeletion } from "./state/model.js";

export interface BackupEntry {
	/** 对象名，含创建时刻更省事；解析失败的对象一律视为过期（宁可多删）。 */
	name: string;
	createdAt: string;
	sizeBytes?: number;
}

export interface BackupStore {
	list(): Promise<BackupEntry[]>;
	remove(name: string): Promise<void>;
}

export interface EvictionResult {
	removed: string[];
	failed: Array<{ name: string; reason: string }>;
	/** 本次因"删除请求满 37 天"而必须清掉的备份数（含在 removed 内）。 */
	forDeletions: number;
	/** 淘汰后仍存在、且覆盖了满 37 天删除请求的备份（软目标下的残留，需要人工跟进）。 */
	violations: string[];
}

export class LifecycleBackupService {
	constructor(
		private readonly store: BackupStore,
		private readonly storage: Storage,
		private readonly now = () => new Date().toISOString(),
		private readonly retentionDays = BACKUP_RETENTION_DAYS,
		private readonly deletionWindowDays = 37,
	) {}

	/**
	 * 软目标：失败不抛错，逐条记录并在审计里留痕；下一次 tick 继续尝试。
	 * 淘汰成功后写 `auditEvents`（不含任何业务内容）。
	 */
	async evictOnce(): Promise<EvictionResult> {
		const at = new Date(this.now()).toISOString();
		const backups = await this.store.list();
		const deletions = await this.storage.transaction(async (tx) => tx.lifecycleDeletions.all());
		const doomed = new Map<string, "aged" | "deleted_task">();
		for (const backup of backups) {
			const created = Date.parse(backup.createdAt);
			if (!Number.isFinite(created)) {
				doomed.set(backup.name, "aged");
				continue;
			}
			if (Date.parse(at) - created > this.retentionDays * MS_PER_DAY)
				doomed.set(backup.name, "aged");
		}
		// 删除满 37 天的请求：早于它的备份都可能含已删数据，必须消失（软目标失败则下轮重试）。
		const ancient = deletions.filter(
			(row) => Date.parse(at) - Date.parse(row.requestedAt) >= this.deletionWindowDays * MS_PER_DAY,
		);
		let forDeletions = 0;
		for (const backup of backups) {
			const created = Date.parse(backup.createdAt);
			if (!Number.isFinite(created)) continue;
			if (!ancient.some((row) => created <= Date.parse(row.requestedAt))) continue;
			doomed.set(backup.name, "deleted_task");
			forDeletions += 1;
		}

		const removed: string[] = [];
		const failed: Array<{ name: string; reason: string }> = [];
		for (const [name] of doomed) {
			try {
				await this.store.remove(name);
				removed.push(name);
			} catch (error) {
				failed.push({ name, reason: error instanceof Error ? error.message : "unknown" });
			}
		}
		await this.storage.transaction(async (tx) => {
			await tx.auditEvents.put({
				id: `audit:backup:${at}`,
				at,
				kind: "backup_evicted",
				actorId: "system",
				detail: `removed ${removed.length}, failed ${failed.length}`,
			});
		});
		const remaining = new Set((await this.store.list()).map((entry) => entry.name));
		const violations = [...doomed.keys()].filter((name) => remaining.has(name));
		return { removed, failed, forDeletions, violations };
	}
}

export type { LifecycleDeletion };
