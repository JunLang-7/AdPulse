// 通知设置的展示推导：把后端的三态（目的地 / 授权 / 闸门）翻译成界面文案与可用动作。
// 纯函数，便于单测；不发起请求、不读 window。

export interface NotificationStatusLike {
	destination: {
		platform: string;
		externalId: string;
		status: "verified" | "invalidated";
	} | null;
	consent: {
		status: "active" | "revoked";
		version: number;
	} | null;
	canSendProactive: boolean;
}

export type NotificationActionKind = "verify" | "grant" | "revoke";

export interface NotificationAction {
	kind: NotificationActionKind;
	label: string;
	/** 授权/撤销需要带当前版本；确认目的地不需要。 */
	expectedVersion?: number;
}

export interface NotificationView {
	/** 当前状态标题：一眼看出「地址是否确认」「是否允许发送」。 */
	title: string;
	detail: string;
	/** 已确认的地址（脱敏）；未确认时为 null。 */
	destination: { platform: string; maskedId: string } | null;
	actions: NotificationAction[];
	/** 需要额外提醒的情况，例如状态为已授权但闸门仍关闭。 */
	warning?: string;
}

/** 外部标识脱敏：ou_83d5b9c8f1a2fd49 → ou_83d5b***fd49 */
export function maskExternalId(value: string | undefined, head = 8, tail = 4): string {
	if (!value) return "—";
	if (value.length <= head + tail) return `${value.slice(0, 2)}***`;
	return `${value.slice(0, head)}***${value.slice(-tail)}`;
}

const PLATFORM_NAMES: Record<string, string> = {
	feishu: "飞书",
	lark: "飞书",
	dingtalk: "钉钉",
	wecom: "企业微信",
	weixin: "企业微信",
};

export function notificationPlatformLabel(platform: string | undefined): string {
	const key = platform?.trim().toLowerCase();
	if (!key) return "外部账号";
	return PLATFORM_NAMES[key] ?? platform!.trim();
}

/**
 * 状态优先级：地址 → 授权。未确认地址时不能授权；地址失效时先重新确认。
 */
export function describeNotificationStatus(
	status: NotificationStatusLike,
): NotificationView {
	const destination = status.destination;
	if (!destination) {
		return {
			title: "尚未确认单聊地址",
			detail: "确认后系统才知道该把提醒发到哪个单聊；只使用你当前登录的飞书身份。",
			destination: null,
			actions: [{ kind: "verify", label: "确认我的飞书单聊" }],
		};
	}

	const masked = maskExternalId(destination.externalId);
	const shown = {
		platform: notificationPlatformLabel(destination.platform),
		maskedId: masked,
	};

	if (destination.status === "invalidated") {
		// 地址失效期间不发送；但若授权仍是 active，必须允许直接撤销——
		// 否则用户被迫先「重新确认地址」（会立即恢复发送资格）才能撤销。
		const activeConsent =
			status.consent?.status === "active" ? status.consent : null;
		return {
			title: "单聊地址已失效",
			detail: activeConsent
				? "地址失效期间不会发送提醒。你可以重新确认地址，也可以直接撤销提醒授权。"
				: "需要重新确认一次地址；确认不会自动恢复已撤销的提醒授权。",
			destination: shown,
			actions: activeConsent
				? [
						{ kind: "verify", label: "重新确认地址" },
						{
							kind: "revoke",
							label: "撤销主动提醒",
							expectedVersion: activeConsent.version,
						},
					]
				: [{ kind: "verify", label: "重新确认地址" }],
			...(activeConsent
				? { warning: "地址失效，当前不会发送任何提醒。" }
				: {}),
		};
	}

	const consent = status.consent;
	if (!consent) {
		return {
			title: "尚未开启主动提醒",
			detail: "地址已确认。开启后只会在需要你处理时发送提醒，不会群发。",
			destination: shown,
			actions: [{ kind: "grant", label: "开启主动提醒", expectedVersion: 0 }],
		};
	}

	if (consent.status === "revoked") {
		return {
			title: "已撤销主动提醒",
			detail: "撤销不影响登录，也不会删除已确认的地址；随时可以重新开启。",
			destination: shown,
			actions: [
				{ kind: "grant", label: "重新开启", expectedVersion: consent.version },
			],
		};
	}

	return {
		title: "已开启主动提醒",
		detail: "仅发送与你自己任务相关的提醒；随时可以撤销。",
		destination: shown,
		actions: [
			{
				kind: "revoke",
				label: "撤销主动提醒",
				expectedVersion: consent.version,
			},
		],
		// 已授权但闸门仍关闭：说明身份/绑定层面有问题，不能假装一切正常。
		...(status.canSendProactive
			? {}
			: { warning: "当前登录绑定或身份已失效，提醒会被抑制；请重新登录后再确认。" }),
	};
}
