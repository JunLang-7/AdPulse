// 日汇总的调度（#37 PR2）：只负责「什么时候该发、该不该发」，不负责渲染卡片与平台调用。
// 设计要点：调度与发送都只是**建议**，真正的许可在执行那一刻重新检查（见 worker.sendDigest）。

import type { Storage } from "./ports/storage.js";
import type { NotificationBatch, NotificationItem } from "./state/model.js";
import type { SubscriptionService } from "./subscriptions.js";
import { localDate, type NotificationQueue } from "./notifications-queue.js";

const minutesOf = (value: string): number =>
	Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

/** 北京时间下某时刻的当日分钟数（0–1439）。 */
export function beijingMinutes(at: Date): number {
	const shifted = new Date(at.getTime() + 8 * 60 * 60_000);
	return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** 免打扰可跨零点；端点：22:00 起暂停，08:00 起恢复。 */
export function inQuietHours(
	at: Date,
	schedule: { quietStart: string; quietEnd: string },
): boolean {
	const point = beijingMinutes(at);
	const from = minutesOf(schedule.quietStart);
	const to = minutesOf(schedule.quietEnd);
	if (from === to) return false;
	return from <= to ? point >= from && point < to : point >= from || point < to;
}

/** 免打扰结束时刻（下一次可发送时刻）用于说明「为什么还没发」。 */
export function quietHoursEnd(at: Date, quietEnd: string): string {
	const shifted = new Date(at.getTime() + 8 * 60 * 60_000);
	const target = new Date(
		Date.UTC(
			shifted.getUTCFullYear(),
			shifted.getUTCMonth(),
			shifted.getUTCDate(),
			Math.floor(minutesOf(quietEnd) / 60),
			minutesOf(quietEnd) % 60,
		) - 8 * 60 * 60_000,
	);
	if (target.getTime() <= at.getTime())
		target.setUTCDate(target.getUTCDate() + 1);
	return target.toISOString();
}

export interface ScheduleTickResult {
	/** 新入队的投递任务数。 */
	enqueued: number;
	/** 因关闭/退订/版本变化/内容为空而取消的批次数。 */
	cancelled: number;
	/** 免打扰延后或已有在途任务而跳过的批次数。 */
	deferred: number;
}

/**
 * 扫描到期批次并入队投递任务。
 * - 同一批次的投递任务最多一个（pending/running），重复 tick 不会重复发送；
 * - 关闭推送、配置版本变化、空批次 → 取消批次（并取消其待发条目）；
 * - 免打扰内 → 不动，等下一个 tick。
 */
export class DigestScheduler {
	constructor(
		private readonly storage: Storage,
		private readonly subscriptions: SubscriptionService,
		private readonly queue: NotificationQueue,
		private readonly now: () => Date = () => new Date(),
	) {}

	async tick(): Promise<ScheduleTickResult> {
		const lock = await this.storage.runExclusive("notifications:digest-scheduler", () =>
			this.sweep(),
		);
		return (
			lock.value ?? { enqueued: 0, cancelled: 0, deferred: 0 }
		);
	}

	private async sweep(): Promise<ScheduleTickResult> {
		const at = this.now();
		const atIso = at.toISOString();
		const today = localDate(at);
		const result: ScheduleTickResult = {
			enqueued: 0,
			cancelled: 0,
			deferred: 0,
		};
		// 两轮：跨日合并可能在第一轮里新建当天批次，第二轮才能把它纳入本轮调度，
		// 否则要等到下一次 tick，恢复当天可能只发半份内容。
		// 只有真的发生了合并才跑第二轮，避免把同一批次的 defer/cancel 重复计数。
		let merged = false;
		for (let pass = 0; pass < 2; pass += 1) {
		if (pass === 1 && !merged) break;
		merged = false;
		const due = await this.storage.transaction(async (tx) =>
			(await tx.notificationBatches.all())
				.filter(
					(batch) =>
						batch.status === "queued" && batch.scheduledAt <= atIso,
				)
				.sort((left, right) =>
					left.scheduledAt.localeCompare(right.scheduledAt),
				),
		);
		if (due.length === 0) break;

		for (const batch of due) {
			const view = await this.subscriptions.view(batch.ownerId);
			if (batch.localDate < today) {
				// 跨日恢复：往日批次并入下一次有效汇总，终结旧批次，不补发旧日报。
				if (!view.settings.proactiveEnabled) {
					await this.cancel(batch, "push_disabled", atIso);
				} else {
					merged = true;
					await this.queue.mergeStale(
						batch.ownerId,
						batch.id,
						view.settings.version,
					);
					// 条目已被并入目标批次；旧批次终结并保留原因作为证据。
					await this.cancel(batch, "merged_stale", atIso);
				}
				result.cancelled += 1;
				continue;
			}
			if (!view.settings.proactiveEnabled) {
				await this.cancel(batch, "push_disabled", atIso);
				result.cancelled += 1;
				continue;
			}
			// 配置被改过：批次内容与当前订阅已不匹配，取消并等新内容进下一批。
			if (batch.settingsVersion !== view.settings.version) {
				await this.cancel(batch, "settings_changed", atIso);
				result.cancelled += 1;
				continue;
			}
			if (inQuietHours(at, view.settings.schedule)) {
				result.deferred += 1;
				continue;
			}
			const items = await this.pendingItems(batch.id);
			if (items.length === 0) {
				await this.cancel(batch, "empty", atIso);
				result.cancelled += 1;
				continue;
			}
			const enqueued = await this.enqueue(batch, today, atIso);
			if (enqueued) result.enqueued += 1;
			else result.deferred += 1;
		}
		}
		return result;
	}

	private async pendingItems(batchId: string): Promise<NotificationItem[]> {
		return this.storage.transaction(async (tx) =>
			(await tx.notificationItems.all())
				.filter(
					(item) => item.batchId === batchId && item.status === "queued",
				)
				.sort((left, right) => left.id.localeCompare(right.id)),
		);
	}

	private async enqueue(
		batch: NotificationBatch,
		today: string,
		atIso: string,
	): Promise<boolean> {
		return this.storage.transaction(async (tx) => {
			const jobs = await tx.jobs.all();
			const exists = jobs.some(
				(job) =>
					job.task.kind === "send_digest" &&
					job.task.batchId === batch.id &&
					["pending", "running"].includes(job.status),
			);
			if (exists) return false;
			// 同一天的批次晚于计划时刻才入队 → 标记为「当日补发」。
			const catchUp =
				batch.localDate === today && batch.scheduledAt < atIso
					? { catchUp: true }
					: {};
			await tx.notificationBatches.put({
				...batch,
				updatedAt: atIso,
				...catchUp,
			});
			await tx.jobs.put({
				id: `digest:${batch.id}`,
				task: { kind: "send_digest", batchId: batch.id },
				status: "pending",
				runAt: atIso,
				attempts: 0,
			});
			return true;
		});
	}

	private async cancel(
		batch: NotificationBatch,
		reason: string,
		atIso: string,
	): Promise<void> {
		await this.storage.transaction(async (tx) => {
			for (const item of await tx.notificationItems.all()) {
				if (item.batchId !== batch.id || item.status !== "queued") continue;
				await tx.notificationItems.put({
					...item,
					status: "cancelled",
					updatedAt: atIso,
				});
			}
			const current = await tx.notificationBatches.get(batch.id);
			if (!current || current.status !== "queued") return;
			await tx.notificationBatches.put({
				...current,
				status: "cancelled",
				statusReason: reason,
				updatedAt: atIso,
			});
		});
	}
}
