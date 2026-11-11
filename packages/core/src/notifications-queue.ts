// 主动通知的批次与去重（#37 PR1）：只建模「哪些信息该发、什么时候该发、什么时候取消」。
// 不做筛选规则、不做渲染、不发消息——调度与投递在 PR2，决策卡在 PR3。
//
// 三条不变量：
// 1) 幂等：ownerId + 本地日期 + 类型 只有一份批次；并发调度不会生成两份。
// 2) 去重：ownerId + logicalKey 只有一行条目；重试/换标题/多源转载不新增通知，
//    只有实质更新（revision 提升）才再次通知。
// 3) 取消是终态：关闭推送/退订后条目置 cancelled，重新开启不得复活旧队列。

import crypto from "node:crypto";
import type { Storage, Transaction } from "./ports/storage.js";
import type {
	NotificationBatch,
	NotificationItem,
	NotificationItemKind,
	NotificationItemStatus,
} from "./state/model.js";

/** 北京时间固定 UTC+8（中国自 1991 年起无夏令时），不依赖服务器时区。 */
const SHANGHAI_OFFSET_MINUTES = 8 * 60;
const DIGEST_HOUR = 9;
const DIGEST_MINUTE = 30;

export class NotificationQueueError extends Error {
	constructor(
		readonly reason: "invalid_item" | "batch_unavailable",
		message: string,
	) {
		super(message);
		this.name = "NotificationQueueError";
	}
}

/** 某时刻对应的北京时间本地日期（YYYY-MM-DD）。 */
export function localDate(at: Date): string {
	const shifted = new Date(at.getTime() + SHANGHAI_OFFSET_MINUTES * 60_000);
	return shifted.toISOString().slice(0, 10);
}

/** 指定北京日期 09:30 对应的 UTC 时刻。 */
export function digestInstant(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	const utcMs =
		Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, DIGEST_HOUR, DIGEST_MINUTE) -
		SHANGHAI_OFFSET_MINUTES * 60_000;
	return new Date(utcMs).toISOString();
}

export const batchId = (
	ownerId: string,
	kind: NotificationBatch["kind"],
	date: string,
): string => `${kind}:${ownerId}:${date}`;

/** 条目幂等标识：同一逻辑事件在本人范围内唯一。 */
export const itemId = (ownerId: string, logicalKey: string): string =>
	`${ownerId}:${logicalKey}`;

const validText = (value: unknown, max: number): value is string =>
	typeof value === "string" &&
	value.trim().length > 0 &&
	value.trim().length <= max &&
	!/[\u0000-\u001f]/.test(value);

export interface QueueItemInput {
	logicalKey: string;
	kind: NotificationItemKind;
	taskId?: string;
	title: string;
	summary: string;
	relevance: string;
	sources: NotificationItem["sources"];
	/** 实质更新序号；同键同 revision 视为重复投递请求。 */
	revision: number;
}

export interface QueueResult {
	/** queued：本次新增或提升版本后重新排队；duplicate：同一版本已排队/已发；cancelled：已取消过，不复活。 */
	outcome: "queued" | "duplicate" | "cancelled";
	item?: NotificationItem;
}

export class NotificationQueue {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => Date = () => new Date(),
	) {}

	/**
	 * 生成（或取回）当天批次。同一 owner + 本地日期 + 类型只可能有一份；
	 * 关闭推送期间不生成新批次（返回 null），避免为已关闭用户排队。
	 */
	async ensureDigestBatch(
		ownerId: string,
		options: { settingsVersion: number; enabled: boolean },
	): Promise<NotificationBatch | null> {
		if (!options.enabled) return null;
		return this.storage.transaction((tx) =>
			this.resolveBatch(tx, ownerId, options.settingsVersion),
		);
	}

	/**
	 * 在事务内解析「新内容应当进入哪一批」：
	 * - 今天已有 queued 批次 → 用它；
	 * - 今天批次已是终态（sent/cancelled/expired/suppressed/failed）→ 用下一计划日的批次，
	 *   绝不复用终态批次：否则条目会挂在无法被调度发现的批次下，且等于变相恢复旧队列。
	 * 同一天的终态批次行保持不变，作为「当天已取消/已发送」的证据。
	 */
	private async resolveBatch(
		tx: Transaction,
		ownerId: string,
		settingsVersion: number,
	): Promise<NotificationBatch> {
		const at = this.now();
		const today = localDate(at);
		const existingToday = await tx.notificationBatches.get(
			batchId(ownerId, "digest", today),
		);
		if (existingToday?.status === "queued") return existingToday;

		// 今天没有批次时用今天；今天已终态则用下一次计划日（此时是「下一批」而非补发）。
		const date =
			existingToday === null
				? today
				: localDate(new Date(at.getTime() + 24 * 60 * 60 * 1000));
		const id = batchId(ownerId, "digest", date);
		const existing = await tx.notificationBatches.get(id);
		if (existing) return existing;
		const batch: NotificationBatch = {
			id,
			ownerId,
			kind: "digest",
			localDate: date,
			settingsVersion,
			status: "queued",
			scheduledAt: digestInstant(date),
			createdAt: at.toISOString(),
			updatedAt: at.toISOString(),
		};
		await tx.notificationBatches.put(batch);
		return batch;
	}

	/**
	 * 把一条信息排进当天批次。
	 * - 同 logicalKey 已存在且 revision 不高于现存：duplicate（不重复通知）
	 * - 已取消过：cancelled（重新开启不补旧队列）
	 * - revision 提升：更新内容并重新排队，作为「实质更新」再次通知
	 */
	async queue(
		ownerId: string,
		input: QueueItemInput,
		options: { settingsVersion: number; enabled: boolean },
	): Promise<QueueResult> {
		if (!validText(input.logicalKey, 200))
			throw new NotificationQueueError("invalid_item", "logicalKey required");
		if (!validText(input.title, 200) || !validText(input.summary, 1000))
			throw new NotificationQueueError("invalid_item", "title and summary required");
		if (!Number.isInteger(input.revision) || input.revision < 1)
			throw new NotificationQueueError("invalid_item", "revision must be >= 1");
		if (!options.enabled)
			throw new NotificationQueueError(
				"batch_unavailable",
				"proactive notifications are disabled",
			);

		// 批次解析与条目写入在同一个事务里：取消操作不能插在两者之间，
		// 否则条目会挂在刚被取消的批次下，调度永远发现不了。
		return this.storage.transaction(async (tx) => {
			const id = itemId(ownerId, input.logicalKey);
			const existing = await tx.notificationItems.get(id);
			const at = this.now().toISOString();
			if (existing) {
				// 已取消/已过期是终态：不因重新开启或重复投递请求复活。
				if (existing.status === "cancelled" || existing.status === "expired")
					return { outcome: "cancelled", item: existing };
				if (input.revision <= existing.revision)
					return { outcome: "duplicate", item: existing };
			}
			const batch = await this.resolveBatch(
				tx,
				ownerId,
				options.settingsVersion,
			);
			if (existing) {
				const taskId = input.taskId ?? existing.taskId;
				const next: NotificationItem = {
					...existing,
					batchId: batch.id,
					...(taskId ? { taskId } : {}),
					title: input.title.trim(),
					summary: input.summary.trim(),
					relevance: input.relevance,
					sources: input.sources,
					revision: input.revision,
					status: "queued",
					updatedAt: at,
					...(existing.deliveryId ? { deliveryId: existing.deliveryId } : {}),
				};
				await tx.notificationItems.put(next);
				return { outcome: "queued", item: next };
			}
			const item: NotificationItem = {
				id,
				ownerId,
				batchId: batch.id,
				logicalKey: input.logicalKey,
				kind: input.kind,
				...(input.taskId ? { taskId: input.taskId } : {}),
				title: input.title.trim(),
				summary: input.summary.trim(),
				relevance: input.relevance,
				sources: input.sources,
				revision: input.revision,
				status: "queued",
				createdAt: at,
				updatedAt: at,
			};
			await tx.notificationItems.put(item);
			return { outcome: "queued", item };
		});
	}

	/** 本人待发条目（queued），按 key 稳定排序，便于批次内容冻结。 */
	async pending(ownerId: string): Promise<NotificationItem[]> {
		return this.storage.transaction(async (tx) =>
			(await tx.notificationItems.all())
				.filter((item) => item.ownerId === ownerId && item.status === "queued")
				.sort((left, right) => left.id.localeCompare(right.id)),
		);
	}

	/**
	 * 取消尚未发送的通知（关闭全部推送、退订对象、身份/授权失效、删除资料）。
	 * 只动 queued；sent 不回滚，也不改业务结果。
	 */
	async cancelPending(
		ownerId: string,
		reason: string,
		filter?: (item: NotificationItem) => boolean,
	): Promise<{ items: number; batches: number }> {
		const at = this.now().toISOString();
		return this.storage.transaction(async (tx) => {
			let items = 0;
			for (const item of await tx.notificationItems.all()) {
				if (item.ownerId !== ownerId || item.status !== "queued") continue;
				if (filter && !filter(item)) continue;
				await tx.notificationItems.put({
					...item,
					status: "cancelled" satisfies NotificationItemStatus,
					updatedAt: at,
				});
				items += 1;
			}
			let batches = 0;
			for (const batch of await tx.notificationBatches.all()) {
				if (batch.ownerId !== ownerId || batch.status !== "queued") continue;
				// 只取消已经没有待发条目的批次；还有条目的批次留给投递。
				const remaining = (
					await tx.notificationItems.all()
				).some(
					(item) =>
						item.batchId === batch.id && item.status === "queued",
				);
				if (remaining) continue;
				await tx.notificationBatches.put({
					...batch,
					status: "cancelled",
					statusReason: reason,
					updatedAt: at,
				});
				batches += 1;
			}
			return { items, batches };
		});
	}

	/**
	 * 标记条目已投递。必须带上**发送时冻结的 revision**：
	 * 发送期间若条目被实质更新（revision 提升），旧回执不得把新版本标成已发送，
	 * 否则尚未发出的更新会从待发里消失。
	 */
	async markSent(
		ownerId: string,
		logicalKey: string,
		options: { deliveryId: string; revision: number },
	): Promise<boolean> {
		return this.storage.transaction((tx) =>
			this.markSentIn(tx, ownerId, logicalKey, options),
		);
	}

	/** 事务内版本：调用方可在同一事务里先做租约校验再回写。 */
	async markSentIn(
		tx: Transaction,
		ownerId: string,
		logicalKey: string,
		options: { deliveryId: string; revision: number },
	): Promise<boolean> {
		const id = itemId(ownerId, logicalKey);
		const item = await tx.notificationItems.get(id);
		if (!item || item.ownerId !== ownerId || item.status !== "queued")
			return false;
		if (item.revision !== options.revision) return false;
		await tx.notificationItems.put({
			...item,
			status: "sent",
			deliveryId: options.deliveryId,
			updatedAt: this.now().toISOString(),
		});
		return true;
	}

	/** 批次状态流转；revision 不参与，批次只关心排队/终态。 */
	async setBatchStatus(
		id: string,
		status: NotificationBatch["status"],
		options: { reason?: string; catchUp?: boolean } = {},
	): Promise<NotificationBatch | null> {
		return this.storage.transaction((tx) =>
			this.setBatchStatusIn(tx, id, status, options),
		);
	}

	/** 事务内版本：与投递回写放在同一事务，避免租约过期后改写别人的结果。 */
	async setBatchStatusIn(
		tx: Transaction,
		id: string,
		status: NotificationBatch["status"],
		options: { reason?: string; catchUp?: boolean } = {},
	): Promise<NotificationBatch | null> {
		const batch = await tx.notificationBatches.get(id);
		if (!batch) return null;
		const at = this.now().toISOString();
		const next: NotificationBatch = {
			...batch,
			status,
			updatedAt: at,
			...(status === "sent" ? { sentAt: at } : {}),
			...(options.reason ? { statusReason: options.reason } : {}),
			...(options.catchUp ? { catchUp: true } : {}),
		};
		await tx.notificationBatches.put(next);
		return next;
	}

	/**
	 * 卡片容量有限：本轮没展示的条目移到下一个可调度批次，而不是留在已发送批次里变孤儿。
	 */
	async deferItems(
		ownerId: string,
		logicalKeys: string[],
		settingsVersion: number,
	): Promise<number> {
		if (logicalKeys.length === 0) return 0;
		return this.storage.transaction((tx) =>
			this.deferItemsIn(tx, ownerId, logicalKeys, settingsVersion),
		);
	}

	async deferItemsIn(
		tx: Transaction,
		ownerId: string,
		logicalKeys: string[],
		settingsVersion: number,
	): Promise<number> {
		if (logicalKeys.length === 0) return 0;
		const batch = await this.resolveBatch(tx, ownerId, settingsVersion);
		const at = this.now().toISOString();
		let moved = 0;
		for (const key of logicalKeys) {
			const item = await tx.notificationItems.get(itemId(ownerId, key));
			if (!item || item.ownerId !== ownerId || item.status !== "queued")
				continue;
			if (item.batchId === batch.id) continue;
			await tx.notificationItems.put({
				...item,
				batchId: batch.id,
				updatedAt: at,
			});
			moved += 1;
		}
		return moved;
	}

	/**
	 * 跨日恢复：把往日批次里仍待发的条目并入下一次有效汇总，并终结旧批次。
	 * 不连发多份旧日报（#37 已确认规则）；旧批次保留为「已合并」的证据。
	 */
	async mergeStale(
		ownerId: string,
		fromBatchId: string,
		settingsVersion: number,
	): Promise<number> {
		return this.storage.transaction(async (tx) => {
			const at = this.now();
			const atIso = at.toISOString();
			const today = localDate(at);
			const todayBatch = await tx.notificationBatches.get(
				batchId(ownerId, "digest", today),
			);
			// 今天还没有批次或仍是排队中 → 并进今天；今天的批次已终结 → 顺延明天。
			const date =
				todayBatch && todayBatch.status !== "queued"
					? localDate(new Date(at.getTime() + 24 * 60 * 60 * 1000))
					: today;
			const id = batchId(ownerId, "digest", date);
			let target = await tx.notificationBatches.get(id);
			if (!target) {
				target = {
					id,
					ownerId,
					kind: "digest",
					localDate: date,
					settingsVersion,
					status: "queued",
					scheduledAt: digestInstant(date),
					createdAt: atIso,
					updatedAt: atIso,
				};
				await tx.notificationBatches.put(target);
			}
			let moved = 0;
			for (const item of await tx.notificationItems.all()) {
				if (item.batchId !== fromBatchId || item.status !== "queued") continue;
				await tx.notificationItems.put({
					...item,
					batchId: target.id,
					updatedAt: atIso,
				});
				moved += 1;
			}
			return moved;
		});
	}

	/** 供 PR2 的调度使用：所有排队中的批次。 */
	async queuedBatches(): Promise<NotificationBatch[]> {
		return this.storage.transaction(async (tx) =>
			(await tx.notificationBatches.all())
				.filter((batch) => batch.status === "queued")
				.sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt)),
		);
	}
}

/** 生成稳定的逻辑事件键：同一来源的同一事件在本人范围内恒定。 */
export function logicalKeyFor(input: {
	kind: NotificationItemKind;
	taskId?: string;
	sourceRef: string;
	eventRef: string;
}): string {
	const scope = input.taskId ? `task:${input.taskId}` : "account";
	return [input.kind, scope, input.sourceRef, input.eventRef]
		.map((part) => part.replace(/[|\s]+/g, "_"))
		.join("|");
}

/** 条目在批次渲染时需要的指纹，用于判断「内容是否真的变了」。 */
export function itemFingerprint(item: Pick<NotificationItem, "title" | "summary" | "revision">): string {
	return crypto
		.createHash("sha256")
		.update(`${item.revision}\n${item.title}\n${item.summary}`)
		.digest("hex")
		.slice(0, 16);
}
