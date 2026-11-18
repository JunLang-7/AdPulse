// 个人通知记录与解释（#37 PR4）：把已发生的批次/条目/投递投影成「本人可读的记录」。
// 只读，不改变任何状态：不发消息、不改批次、不重试、不建 Session。
// 解释只陈述已存事实（状态、原因代码、时间、投递回执），不推断未记录的原因。

import type { InfoCard } from "./domain/infoCard.js";
import { eventLifecycleIn } from "./event-lifecycle.js";
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
	/** 来源事件已过期或不可用：内容不返回，只留状态。 */
	inputExpired?: boolean;
	/** 不可用原因：删除或保留期到期，便于界面区分说法。 */
	inputRemoved?: "deleted" | "expired";
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
type RecordItemDraft = NotificationRecordItem & {
	marketEventRef?: { eventId: string; version: number; evidenceRevision: number };
};

const frozenItems = (delivery: Delivery | null): RecordItemDraft[] => {
	if (!delivery || delivery.purpose !== "digest") return [];
	const card = delivery.card;
	if (!("items" in card)) return [];
	const infoCard = card as InfoCard;
	return infoCard.items.map((item) => ({
		title: item.title,
		summary: item.summary,
		relevance: item.relevance,
		sources: item.sources,
		...(item.marketEventRef ? { marketEventRef: item.marketEventRef } : {}),
	}));
};

/**
 * 到期或已不存在的事件 id 集合：这些事件的内容不得出现在记录页。
 * 与详情/列表用同一套生命周期判定，不另写一份到期规则。
 */
async function unavailableEventsIn(
	tx: Parameters<Parameters<Storage["transaction"]>[0]>[0],
	ownerId: string,
	now: Date,
): Promise<{ byId: Map<string, "deleted" | "expired">; byUrl: Map<string, "deleted" | "expired"> }> {
	const byId = new Map<string, "deleted" | "expired">();
	const byUrl = new Map<string, "deleted" | "expired">();
	for (const head of await tx.marketEvents.all()) {
		if (head.ownerId !== ownerId) continue;
		const lifecycle = await eventLifecycleIn(tx, head, now);
		if (!lifecycle.expired) continue;
		const reason = lifecycle.state === "deleted" ? "deleted" as const : "expired" as const;
		byId.set(head.id, reason);
		// 早期汇总卡片没有 marketEventRef：用来源地址回退识别，避免把已删事件的标题继续回显。
		for (const version of await tx.marketEventVersions.all()) {
			if (version.eventId !== head.id) continue;
			for (const source of version.input.sources ?? []) {
				if (source.url) byUrl.set(source.url, reason);
			}
		}
	}
	return { byId, byUrl };
}

export class NotificationRecordService {
	constructor(
		private readonly storage: Storage,
		private now: () => string = () => new Date().toISOString(),
	) {}

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
			const unavailable = await unavailableEventsIn(tx, ownerId, new Date(this.now()));
			const redact = (item: RecordItemDraft): NotificationRecordItem => {
				const ref = item.marketEventRef;
				// 有引用按事件判断；早期卡片没有引用，则按来源地址回退识别。
				const reason = ref
					? unavailable.byId.get(ref.eventId)
					: item.sources.map((source) => (source.url ? unavailable.byUrl.get(source.url) : undefined)).find(Boolean);
				if (!reason) {
					const { marketEventRef: _ref, ...rest } = item;
					return rest;
				}
				// 删除/到期后只保留状态，不返回标题、摘要、关联理由与来源链接。
				return {
					...(item.id ? { id: item.id } : {}),
					...(item.kind ? { kind: item.kind } : {}),
					...(item.status ? { status: item.status } : {}),
					title: reason === "deleted" ? "已删除的事件" : "已到期的事件",
					summary: reason === "deleted"
						? "这条事件已被删除，内容不再展示。"
						: "这条事件已过保留期（365 天），内容不再展示。",
					relevance: "",
					sources: [],
					inputExpired: true,
					inputRemoved: reason,
				};
			};
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
					items: (frozen.length > 0 ? frozen : rows.map(toRecordItem)).map(redact),
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

function toRecordItem(item: NotificationItem): RecordItemDraft {
	return {
		id: item.id,
		// 仅供投影内部判断到期使用，不返回给客户端。
		...(item.marketEventRef ? { marketEventRef: item.marketEventRef } : {}),
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
