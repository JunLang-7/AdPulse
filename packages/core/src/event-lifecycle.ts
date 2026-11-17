// 事件生命周期（#144 S1）：只做到期判定与读取限访。
// 删除入口（S2）、任务引用清理（S3）、在线清理与备份重放（S4）在后续切片实现。
//
// 与任务的差别：事件没有观测期，锚点固定取「最后业务更新」（首次录入或最后一次修订）。
// 补录旧公告不会一录入就到期；代价是「今年录入的三年前公告」会多存一年，这是用户 2026-11-17 的选择。
import { MS_PER_DAY, RETENTION_DAYS } from "./lifecycle.js";
import type { MarketEventHead } from "./market-events.js";
import type { Transaction } from "./ports/storage.js";

export type EventLifecycleState = "active" | "expired" | "deleted";

export interface EventLifecycle {
	eventId: string;
	state: EventLifecycleState;
	/** 计时锚点：最后业务更新（首次录入或最后一次修订）。 */
	anchor: string;
	anchorSource: "last_business_update";
	lastBusinessUpdate: string;
	expiresAt: string;
	retentionDays: number;
	/** 当前是否已到期或已删除；与 state 同源，便于直接断言「到期即限访」。 */
	expired: boolean;
	/** 本人确认删除的时刻；未删除时为 null。删除优先于到期。 */
	deletedAt: string | null;
}

const iso = (value: string | null | undefined): string | null => {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
	return new Date(value).toISOString();
};

/**
 * 最后业务更新：只看事件版本写入（录入与修订），不看读取、筛选、投递等派生动作。
 * 派生数据不计入，避免重试或查看延长留存。
 */
export async function eventLastBusinessUpdateIn(
	tx: Transaction,
	eventId: string,
	fallback: string,
): Promise<string> {
	let latest = iso(fallback) ?? new Date(0).toISOString();
	for (const version of await tx.marketEventVersions.all()) {
		if (version.eventId !== eventId) continue;
		const at = iso(version.createdAt);
		if (at && Date.parse(at) > Date.parse(latest)) latest = at;
	}
	return latest;
}

export function eventLifecycleOf(
	head: MarketEventHead,
	lastBusinessUpdate: string,
): EventLifecycle {
	const anchor = iso(lastBusinessUpdate) ?? new Date(head.createdAt).toISOString();
	return {
		eventId: head.id,
		state: "active",
		anchor,
		anchorSource: "last_business_update",
		lastBusinessUpdate: anchor,
		expiresAt: new Date(Date.parse(anchor) + RETENTION_DAYS * MS_PER_DAY).toISOString(),
		retentionDays: RETENTION_DAYS,
		expired: false,
		deletedAt: null,
	};
}

/** 判定入口：读取侧统一调用，避免各服务各写一套到期规则。 */
export async function eventLifecycleIn(
	tx: Transaction,
	head: MarketEventHead,
	now: Date,
): Promise<EventLifecycle> {
	const lastBusinessUpdate = await eventLastBusinessUpdateIn(tx, head.id, head.createdAt);
	const lifecycle = eventLifecycleOf(head, lastBusinessUpdate);
	// 删除优先于到期：删了就立即不可访问，不再等保留期。
	if (head.deletion) {
		const at = new Date(head.deletion.at).toISOString();
		return { ...lifecycle, state: "deleted", expired: true, deletedAt: at };
	}
	const expired = Date.parse(lifecycle.expiresAt) <= now.getTime();
	return { ...lifecycle, state: expired ? "expired" : "active", expired, deletedAt: null };
}

/** 到期即限访：返回 false 表示不可读、不可修订、不可参与通知。 */
export async function eventActiveIn(
	tx: Transaction,
	head: MarketEventHead,
	now: Date,
): Promise<boolean> {
	return !(await eventLifecycleIn(tx, head, now)).expired;
}

/**
 * 服务层便捷入口：按 owner 取事件头并判定。
 * 返回 null 表示不存在、非本人或已到期——对调用方保持一致的「不可访问」。
 */
export async function activeEventHeadIn(
	tx: Transaction,
	ownerId: string,
	eventId: string,
	now: Date,
): Promise<MarketEventHead | null> {
	const head = await tx.marketEvents.get(eventId);
	if (!head || head.ownerId !== ownerId) return null;
	return (await eventActiveIn(tx, head, now)) ? head : null;
}
