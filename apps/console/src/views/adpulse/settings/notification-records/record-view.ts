// 通知记录的展示推导：把批次/条目/投递的机器状态翻译成「为什么收到、为什么没收到」。
// 纯函数，便于单测；不发起请求、不读 window。
//
// 两条原则：
// 1) 只翻译已存事实（状态、原因代码、时间、投递回执）；没有记录原因就写「未记录原因」，不猜。
// 2) 「平台已接收」不等于「你已读」；页面文案不能让人误以为消息已被看过。

export type RecordStatus =
	| "queued"
	| "sent"
	| "cancelled"
	| "expired"
	| "suppressed"
	| "failed";

export type RecordItemStatus = "queued" | "sent" | "cancelled" | "expired";

export type RecordDeliveryStatus =
	| "pending"
	| "sent"
	| "failed"
	| "cancelled"
	| "suppressed";

export interface RecordSourceLike {
	label: string;
	url?: string;
	publishedAt?: string | null;
	observedAt?: string;
}

export interface RecordItemLike {
	id: string;
	title: string;
	summary: string;
	relevance: string;
	sources: RecordSourceLike[];
	revision: number;
	status: RecordItemStatus;
	taskId?: string;
}

export interface RecordDeliveryLike {
	status: RecordDeliveryStatus;
	sentAt?: string;
	externalMessageId?: string;
	lastError?: string;
	suppressionReason?: string;
	checkedAt?: string;
}

export interface RecordLike {
	id: string;
	localDate: string;
	status: RecordStatus;
	statusReason?: string;
	scheduledAt: string;
	sentAt?: string;
	catchUp?: boolean;
	settingsVersion: number;
	items: RecordItemLike[];
	delivery: RecordDeliveryLike | null;
}

export type RecordTone = "ok" | "pending" | "muted" | "warn" | "error";

export interface RecordView {
	/** 例如「11月11日 每日汇总」。 */
	title: string;
	statusLabel: string;
	tone: RecordTone;
	/** 为什么没收到（已发送时为 null）。 */
	reason: { label: string; detail: string } | null;
	/** 已发送时的补充说明：平台接收不等于已读。 */
	deliveryNote: string | null;
	items: Array<{
		id: string;
		title: string;
		summary: string;
		relevance: string;
		statusLabel: string;
		sources: Array<{ label: string; url?: string; publishedAt?: string | null }>;
	}>;
	/** 条目层面的时间：计划时刻与（已发送的）实际发送时刻。 */
	times: { planned: string; sent?: string };
}

const BATCH_STATUS: Record<RecordStatus, { label: string; tone: RecordTone }> = {
	queued: { label: "等待发送", tone: "pending" },
	sent: { label: "已发送", tone: "ok" },
	cancelled: { label: "已取消", tone: "muted" },
	expired: { label: "已过期", tone: "muted" },
	suppressed: { label: "已抑制", tone: "warn" },
	failed: { label: "发送失败", tone: "error" },
};

const ITEM_STATUS: Record<RecordItemStatus, string> = {
	queued: "待发送",
	sent: "已发送",
	cancelled: "已取消",
	expired: "已过期",
};

const DELIVERY_STATUS: Record<RecordDeliveryStatus, string> = {
	pending: "发送中",
	sent: "平台已接收",
	failed: "发送失败",
	cancelled: "已取消",
	suppressed: "已抑制",
};

/**
 * 原因代码 → 文案。代码来自调度/投递侧（notifications-schedule、worker.sendDigest），
 * 这里只做翻译；新增代码没翻译时显示原码，不编造原因。
 */
const REASONS: Record<string, { label: string; detail: string }> = {
	push_disabled: {
		label: "当时关闭了主动提醒",
		detail: "关闭期间不生成也不发送汇总；重新开启不会补发这一批。",
	},
	settings_changed: {
		label: "订阅配置在生成后被修改",
		detail: "这一批按旧配置生成，已作废；新内容会进入之后的汇总。",
	},
	empty: {
		label: "没有新内容",
		detail: "不发空汇总；有新内容时才会在下一个汇总时刻发送。",
	},
	merged_stale: {
		label: "错过了计划时刻",
		detail: "内容已并入之后的汇总，不单独补发旧日报；旧批次保留为记录。",
	},
	destination_missing: {
		label: "没有可用的单聊地址",
		detail: "先确认单聊地址，之后的新内容才能发送。",
	},
	destination_invalidated: {
		label: "单聊地址已失效",
		detail: "平台报告收不到；需要重新确认地址，确认不会自动恢复已撤销的授权。",
	},
	consent_missing: {
		label: "没有通知授权",
		detail: "尚未开启主动提醒，因此没有发送。",
	},
	consent_revoked: {
		label: "主动提醒已撤销",
		detail: "撤销后不再发送；重新开启不会补发这一批。",
	},
	identity_inactive: {
		label: "登录绑定或身份已失效",
		detail: "需要重新登录并确认身份后才能继续接收。",
	},
	channel_unavailable: {
		label: "消息渠道不可用",
		detail: "服务端没有可用的渠道账号，这一批被抑制；恢复后只发新内容。",
	},
	recipient_unreachable: {
		label: "平台报告收件人不可达",
		detail: "地址已标记为失效；需要重新确认地址才能继续接收。",
	},
};

const monthDay = (localDate: string): string => {
	const [, month, day] = localDate.split("-");
	return `${Number(month)}月${Number(day)}日`;
};

/** 展示用北京时间：固定 Asia/Shanghai，不跟随浏览器时区。 */
export function formatBeijing(
	iso: string,
	options: { withDate?: boolean } = {},
): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "—";
	const parts = new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		...(options.withDate === false ? {} : { month: "2-digit" as const, day: "2-digit" as const }),
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(at);
	const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	const time = `${pick("hour")}:${pick("minute")}`;
	if (options.withDate === false) return time;
	return `${Number(pick("month"))}月${Number(pick("day"))}日 ${time}`;
}

function describeReason(record: RecordLike): RecordView["reason"] {
	if (record.status === "sent") return null;
	if (record.statusReason)
		return (
			REASONS[record.statusReason] ?? {
				label: `已取消（${record.statusReason}）`,
				detail: "服务端记录了原因代码，但界面还没有对应文案；不推测具体含义。",
			}
		);
	if (record.status === "queued")
		return {
			label: "已在队列中",
			detail: "还没到发送时刻，或正在免打扰时段内顺延；发送前会重新检查开关、授权与地址。",
		};
	return {
		label: BATCH_STATUS[record.status].label,
		detail: "服务端没有记录原因代码，因此不推测具体原因。",
	};
}

const deliveryNote = (record: RecordLike): string | null => {
	if (!record.delivery) return null;
	if (record.delivery.status === "sent")
		return "平台已接收这条消息，但「已接收」不代表你已读。";
	if (record.delivery.status === "failed")
		return `投递失败${record.delivery.lastError ? `：${record.delivery.lastError}` : ""}；失败不回滚业务结果。`;
	if (record.delivery.status === "suppressed")
		return `投递被抑制${record.delivery.suppressionReason ? `（${record.delivery.suppressionReason}）` : ""}。`;
	if (record.delivery.status === "pending")
		return "投递仍在进行中；发送前会再做一次检查。";
	return `投递状态：${DELIVERY_STATUS[record.delivery.status]}。`;
};

export function describeRecord(record: RecordLike): RecordView {
	const status = BATCH_STATUS[record.status];
	return {
		title: `${monthDay(record.localDate)} 每日汇总${record.catchUp ? "（当日补发）" : ""}`,
		statusLabel: status.label,
		tone: status.tone,
		reason: describeReason(record),
		deliveryNote: deliveryNote(record),
		items: record.items.map((item) => ({
			id: item.id,
			title: item.title,
			summary: item.summary,
			relevance: item.relevance,
			statusLabel: ITEM_STATUS[item.status],
			sources: item.sources.map((source) => ({
				label: source.label,
				...(source.url ? { url: source.url } : {}),
				...(source.publishedAt === undefined
					? {}
					: { publishedAt: source.publishedAt }),
			})),
		})),
		times: {
			planned: formatBeijing(record.scheduledAt, { withDate: false }),
			...(record.sentAt ? { sent: formatBeijing(record.sentAt) } : {}),
		},
	};
}
