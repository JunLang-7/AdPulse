// 订阅设置的展示推导：把「配置」「地址」「授权」「推送开关」四种状态分开，互不冒充。
// 纯函数，便于单测；不发起请求、不读 window。

export type SubscriptionKind = "task" | "brand" | "competitor";
export type SubscriptionCategory = "effect" | "event" | "evidence";
export type SubscriptionScope = "task_only" | "include_general";

export interface SubscriptionSettingsLike {
	version: number;
	proactiveEnabled: boolean;
	schedule: {
		timezone: string;
		digestAt: string;
		quietStart: string;
		quietEnd: string;
	};
	enabledAt?: string;
	disabledAt?: string;
	updatedAt?: string;
}

export interface SubscriptionTargetLike {
	id: string;
	kind: SubscriptionKind;
	kindLabel: string;
	refId: string;
	label: string;
	sourceUrl?: string;
	categories: SubscriptionCategory[];
	scope: SubscriptionScope;
	status: "active" | "muted";
	updatedAt: string;
}

export interface SubscriptionViewLike {
	settings: SubscriptionSettingsLike;
	targets: SubscriptionTargetLike[];
}

export interface NotificationStatusLike {
	destination: { status: "verified" | "invalidated" } | null;
	consent: { status: "active" | "revoked"; version: number } | null;
	canSendProactive: boolean;
}

export const KIND_OPTIONS: ReadonlyArray<{ value: SubscriptionKind; label: string }> = [
	{ value: "task", label: "我的任务" },
	{ value: "brand", label: "品牌" },
	{ value: "competitor", label: "竞品" },
];

export const CATEGORY_OPTIONS: ReadonlyArray<{
	value: SubscriptionCategory;
	label: string;
	hint: string;
}> = [
	{ value: "effect", label: "效果排查", hint: "投放数据出现异常、需要你判断时" },
	{ value: "event", label: "明确事件", hint: "有来源的市场/竞品明确变化" },
	{ value: "evidence", label: "补证/待处理", hint: "证据不足或需要你补充资料时" },
];

export const SCOPE_OPTIONS: ReadonlyArray<{
	value: SubscriptionScope;
	label: string;
	hint: string;
}> = [
	{ value: "task_only", label: "仅当前任务相关", hint: "只关联该任务上下文" },
	{
		value: "include_general",
		label: "也接收该对象的一般动态",
		hint: "该关注对象的一般消息也收",
	},
];

const KIND_LABELS: Record<SubscriptionKind, string> = {
	task: "我的任务",
	brand: "品牌",
	competitor: "竞品",
};

/** 未知 kind 原样显示，不硬编码成「任务」。 */
export function kindLabel(kind: string, fallback?: string): string {
	return KIND_LABELS[kind as SubscriptionKind] ?? fallback ?? kind;
}

export function categoryLabels(categories: SubscriptionCategory[]): string[] {
	return categories.map(
		(value) =>
			CATEGORY_OPTIONS.find((item) => item.value === value)?.label ?? value,
	);
}

export function scopeLabel(scope: SubscriptionScope): string {
	return (
		SCOPE_OPTIONS.find((item) => item.value === scope)?.label ?? scope
	);
}

/** 汇总与免打扰都用北京时间展示，不依赖浏览器时区。 */
export function formatSchedule(schedule: SubscriptionSettingsLike["schedule"]): {
	digest: string;
	quiet: string;
	timezoneNote: string;
} {
	return {
		digest: `每日 ${schedule.digestAt} 汇总`,
		quiet: `${schedule.quietStart}–${schedule.quietEnd} 免打扰`,
		timezoneNote: `时间均为北京时间（${schedule.timezone}）`,
	};
}

/** 生效中的关注对象：退订（muted）不计入。 */
export function activeTargets(targets: SubscriptionTargetLike[]): SubscriptionTargetLike[] {
	return targets.filter((item) => item.status === "active");
}

/**
 * 四种状态必须分开，任何一种都不能冒充「可以收到提醒」。
 * ready 需要：地址已验证 && 授权 active && 推送开关开启 && 至少一个生效关注对象。
 */
export type ReadinessState =
	| "destination_missing"
	| "destination_invalidated"
	| "consent_missing"
	| "identity_inactive"
	| "push_disabled"
	| "no_targets"
	| "ready";

export interface Readiness {
	state: ReadinessState;
	title: string;
	detail: string;
	/** 能否真的收到主动提醒。 */
	canDeliver: boolean;
}

export function describeReadiness(
	subscription: SubscriptionViewLike,
	notification: NotificationStatusLike,
): Readiness {
	const destination = notification.destination;
	if (!destination)
		return {
			state: "destination_missing",
			title: "还没有可用的单聊地址",
			detail: "保存订阅不会发送任何消息；先在「通知设置」确认一次你的飞书单聊地址。",
			canDeliver: false,
		};
	if (destination.status === "invalidated")
		return {
			state: "destination_invalidated",
			title: "单聊地址已失效",
			detail: "平台报告过收件人不可达。请在「通知设置」重新确认地址，订阅配置会保留。",
			canDeliver: false,
		};
	if (notification.consent?.status !== "active")
		return {
			state: "consent_missing",
			title: "尚未允许主动提醒",
			detail: "地址已确认，但还没有授权。授权在「通知设置」里完成，这里只保存订阅范围。",
			canDeliver: false,
		};
	// 配置齐备但服务端闸门仍关闭：说明登录绑定/身份已失效，投递会被抑制。
	// 不能因为「配置都对」就宣称会收到提醒。
	if (!notification.canSendProactive)
		return {
			state: "identity_inactive",
			title: "登录绑定已失效，提醒会被抑制",
			detail: "订阅配置都在，但当前登录绑定不再有效；请重新登录并重新确认后才会恢复投递。",
			canDeliver: false,
		};
	if (!subscription.settings.proactiveEnabled)
		return {
			state: "push_disabled",
			title: "订阅推送未开启",
			detail: "配置已保存，但你选择了暂不开启；开启前不会有任何主动推送。",
			canDeliver: false,
		};
	if (activeTargets(subscription.targets).length === 0)
		return {
			state: "no_targets",
			title: "还没有关注任何对象",
			detail: "推送已开启，但没有任何生效的关注对象，因此不会有内容。",
			canDeliver: false,
		};
	return {
		state: "ready",
		title: "已开启订阅推送",
		detail: "会在北京时间的汇总时段或需要你及时处理时提醒；免打扰时段内不推送。",
		canDeliver: true,
	};
}

/** 开启前的确认清单：必须让用户看到「将要收到什么」。 */
export function confirmationSummary(
	subscription: SubscriptionViewLike,
): { lines: string[]; warning?: string } {
	const active = activeTargets(subscription.targets);
	const schedule = formatSchedule(subscription.settings.schedule);
	const lines = [
		`关注对象：${active.length} 个${active.length === 0 ? "（当前没有，开启后也不会收到内容）" : `（${active.map((item) => item.label).join("、")}）`}`,
		`接收类别：${[...new Set(active.flatMap((item) => categoryLabels(item.categories)))].join("、") || "未选择"}`,
		`${schedule.digest}，有新内容才发，不发空汇总`,
		`决策类提醒及时发送，但遵守${schedule.quiet}`,
		schedule.timezoneNote,
	];
	return active.length === 0
		? {
				lines,
				warning: "没有生效的关注对象，开启后也不会收到内容；可以先添加关注对象。",
			}
		: { lines };
}

/** 新增/编辑关注对象的输入校验；返回第一个错误，全部通过返回 null。 */
export function validateTargetDraft(draft: {
	kind: SubscriptionKind;
	taskId?: string;
	label?: string;
	sourceUrl?: string;
	categories: SubscriptionCategory[];
}): string | null {
	if (draft.kind === "task" && !draft.taskId)
		return "请选择一个自己的任务。";
	if (draft.kind !== "task") {
		const label = draft.label?.trim() ?? "";
		if (!label) return "请填写名称。";
		if (label.length > 40) return "名称最多 40 个字。";
	}
	const sourceUrl = draft.sourceUrl?.trim();
	if (sourceUrl) {
		let url: URL;
		try {
			url = new URL(sourceUrl);
		} catch {
			return "来源链接格式不正确。";
		}
		if (url.protocol !== "https:" && url.protocol !== "http:")
			return "来源链接必须以 http 或 https 开头。";
	}
	if (draft.categories.length === 0) return "至少选择一个类别。";
	return null;
}

/** 时段草稿校验，与后端规则保持一致（汇总不得落在免打扰内）。 */
export function validateScheduleDraft(schedule: {
	digestAt: string;
	quietStart: string;
	quietEnd: string;
}): string | null {
	const time = /^([01]\d|2[0-3]):[0-5]\d$/;
	for (const value of [schedule.digestAt, schedule.quietStart, schedule.quietEnd])
		if (!time.test(value)) return "时间格式应为 HH:MM，例如 09:30。";
	if (schedule.quietStart === schedule.quietEnd)
		return "免打扰的起止时间不能相同。";
	const minutes = (value: string) =>
		Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
	const point = minutes(schedule.digestAt);
	const from = minutes(schedule.quietStart);
	const to = minutes(schedule.quietEnd);
	const inQuiet =
		from <= to ? point >= from && point < to : point >= from || point < to;
	return inQuiet ? "汇总时间不能落在免打扰时段内，否则永远不会发送。" : null;
}

/** 注意：保存成功不等于可投递，提示语必须写清这一点。 */
export function savedNotice(subscription: SubscriptionViewLike): string {
	return subscription.settings.proactiveEnabled
		? "订阅配置已保存。"
		: "订阅配置已保存，但推送仍是关闭状态，不会发送任何提醒。";
}

export function errorText(status: number): string {
	switch (status) {
		case 401:
			return "登录已过期，请重新登录。";
		case 403:
			return "当前登录身份无权修改这份订阅配置。";
		case 404:
			return "找不到这个关注对象，可能已被删除，请刷新。";
		case 409:
			return "配置已在其他标签页修改，请刷新后重试。";
		case 422:
			return "输入不合法（类别、时间或链接），请检查后重试。";
		default:
			return "操作失败，请稍后重试。";
	}
}
