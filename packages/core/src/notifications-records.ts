// 个人通知记录与解释（#37 PR4）：把已发生的批次/条目/投递投影成「本人可读的记录」。
// 只读，不改变任何状态：不发消息、不改批次、不重试、不建 Session。
// 解释只陈述已存事实（状态、原因代码、时间、投递回执），不推断未记录的原因。

import type { InfoCard } from "./domain/infoCard.js";
import type { Storage } from "./ports/storage.js";
import type {
	Delivery,
	NotificationBatch,
	NotificationItem,
	NotificationItemStatus,
} from "./state/model.js";

/** 边界层把非法查询参数映射成 400，不静默改写用户输入。 */
export class NotificationRecordError extends Error {
	constructor(
		readonly reason: "invalid_query",
		message: string,
	) {
		super(message);
		this.name = "NotificationRecordError";
	}
}

export const RECORD_PAGE_DEFAULT = 20;
export const RECORD_PAGE_MAX = 50;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 投递回执：与业务状态分开，sent 只代表渠道接收，不代表已读。 */
export interface NotificationRecordDelivery {
	status: "pending" | "sent" | "failed" | "cancelled" | "suppressed";
	sentAt?: string;
	externalMessageId?: string;
	lastError?: string;
	suppressionReason?: string;
	/** 发送前最后一次复检通过的时刻；不是发送回执。 */
	checkedAt?: string;
}

/**
 * 记录条目。`itemsSource` 决定哪些字段可信：
 * - `rows`：来自待发条目行，带 id/kind/revision/status；
 * - `delivery`：来自发送时冻结的卡片内容（用户实际收到的），只保留展示字段，
 *   不补造 revision/status——那一条行可能已因实质更新移到后续批次。
 */
export interface NotificationRecordItem {
	title: string;
	summary: string;
	relevance: string;
	sources: NotificationItem["sources"];
	id?: string;
	kind?: NotificationItem["kind"];
	taskId?: string;
	revision?: number;
	status?: NotificationItemStatus;
	deliveryId?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface NotificationRecord {
	id: string;
	kind: NotificationBatch["kind"];
	/** 北京时间的本地日期；批次按它幂等。 */
	localDate: string;
	status: NotificationBatch["status"];
	/** 取消/抑制/失败的原因代码；具体文案由展示层翻译，不在领域层写死。 */
	statusReason?: string;
	scheduledAt: string;
	sentAt?: string;
	catchUp?: boolean;
	/** 生成时的订阅配置版本，用于解释「配置改过，这批作废」。 */
	settingsVersion: number;
	createdAt: string;
	updatedAt: string;
	/** items 的来源：发送时冻结的卡片内容，或条目行的当前状态。 */
	itemsSource: NotificationRecordItemsSource;
	items: NotificationRecordItem[];
	/** 日汇总的投递回执；从未发起投递时为 null。 */
	delivery: NotificationRecordDelivery | null;
}

export type NotificationRecordItemsSource = "delivery" | "rows";

export interface NotificationRecordPage {
	records: NotificationRecord[];
	/** 下一页游标（上一页最后一条的本地日期）；没有更早记录时为 null。 */
	nextBefore: string | null;
}

/** 日汇总的投递 id 由批次派生（见 worker.sendDigest），不另建对照表。 */
const digestDeliveryId = (id: string): string => `digest:${id}`;

/**
 * 已发送批次的内容只能取自发送那一刻冻结的卡片：
 * queue() 在 revision 提升时复用同一条目行并改 batchId，按行回查会让历史批次变空、
 * 或显示成更新后的版本，而用户当时收到的不是那个版本。
 */
const frozenItems = (delivery: Delivery | null): NotificationRecordItem[] => {
	if (!delivery || delivery.purpose !== "digest") return [];
	const card = delivery.card;
	if (!("items" in card)) return [];
	const infoCard = card as InfoCard;
	return infoCard.items.map((item) => ({
		title: item.title,
		summary: item.summary,
		relevance: item.relevance,
		sources: item.sources,
	}));
};

export class NotificationRecordService {
	constructor(private readonly storage: Storage) {}

	/**
	 * 只返回本人记录；跨用户一律不可见（不提供按 id 直取公开入口，
	 * 因此不存在「知道 id 就能读别人记录」的路径）。
	 * 按本地日期倒序分页，`before` 为排他游标。
	 */
	async list(
		ownerId: string,
		options: { limit?: number; before?: string } = {},
	): Promise<NotificationRecordPage> {
		const limit = options.limit ?? RECORD_PAGE_DEFAULT;
		if (!Number.isInteger(limit) || limit < 1 || limit > RECORD_PAGE_MAX)
			throw new NotificationRecordError(
				"invalid_query",
				`limit must be an integer between 1 and ${RECORD_PAGE_MAX}`,
			);
		const before = options.before;
		if (before !== undefined && !LOCAL_DATE_PATTERN.test(before))
			throw new NotificationRecordError(
				"invalid_query",
				"before must be a local date (YYYY-MM-DD)",
			);

		return this.storage.transaction(async (tx) => {
			const batches = (await tx.notificationBatches.all())
				.filter((batch) => batch.ownerId === ownerId)
				.filter((batch) => (before === undefined ? true : batch.localDate < before))
				.sort((left, right) =>
					left.localDate === right.localDate
						? right.id.localeCompare(left.id)
						: right.localDate.localeCompare(left.localDate),
				);
			const page = batches.slice(0, limit);
			if (page.length === 0) return { records: [], nextBefore: null };

			const items = (await tx.notificationItems.all()).filter(
				(item) => item.ownerId === ownerId,
			);
			const records: NotificationRecord[] = [];
			for (const batch of page) {
				const delivery = await tx.deliveries.get(digestDeliveryId(batch.id));
				const own = delivery && delivery.ownerId === ownerId ? delivery : null;
				// 已发送批次优先用冻结卡片；缺回执（历史/测试数据）时退回条目行。
				const frozen = batch.status === "sent" ? frozenItems(own) : [];
				const rows = items
					.filter((item) => item.batchId === batch.id)
					.sort((left, right) => left.id.localeCompare(right.id));
				records.push({
					...toRecord(batch),
					itemsSource: frozen.length > 0 ? "delivery" : "rows",
					items: frozen.length > 0 ? frozen : rows.map(toRecordItem),
					delivery:
						own
							? {
									status: own.status,
									...(own.sentAt ? { sentAt: own.sentAt } : {}),
									...(own.externalMessageId
										? { externalMessageId: own.externalMessageId }
										: {}),
									...(own.lastError ? { lastError: own.lastError } : {}),
									...(own.suppressionReason
										? { suppressionReason: own.suppressionReason }
										: {}),
									...(own.proactiveCheckedAt
										? { checkedAt: own.proactiveCheckedAt }
										: {}),
								}
							: null,
				});
			}
			return {
				records,
				nextBefore:
					batches.length > page.length
						? (page[page.length - 1]?.localDate ?? null)
						: null,
			};
		});
	}
}

function toRecord(
	batch: NotificationBatch,
): Omit<NotificationRecord, "items" | "itemsSource" | "delivery"> {
	return {
		id: batch.id,
		kind: batch.kind,
		localDate: batch.localDate,
		status: batch.status,
		...(batch.statusReason ? { statusReason: batch.statusReason } : {}),
		scheduledAt: batch.scheduledAt,
		...(batch.sentAt ? { sentAt: batch.sentAt } : {}),
		...(batch.catchUp ? { catchUp: true } : {}),
		settingsVersion: batch.settingsVersion,
		createdAt: batch.createdAt,
		updatedAt: batch.updatedAt,
	};
}

function toRecordItem(item: NotificationItem): NotificationRecordItem {
	return {
		id: item.id,
		kind: item.kind,
		...(item.taskId ? { taskId: item.taskId } : {}),
		title: item.title,
		summary: item.summary,
		relevance: item.relevance,
		sources: item.sources,
		revision: item.revision,
		status: item.status,
		...(item.deliveryId ? { deliveryId: item.deliveryId } : {}),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}
