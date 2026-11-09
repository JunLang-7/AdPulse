// 账号菜单用的展示逻辑：只做脱敏与格式化，便于单独测试。
// 这里不发起请求、不读 window，输入都来自 /api/me。

/** 保留头尾的脱敏：ou_83d5b9c8f1a2fd49 → ou_83d5b***fd49 */
export function maskIdentifier(value: string | undefined, head = 8, tail = 4): string {
	if (!value) return "—";
	if (value.length <= head + tail) return `${value.slice(0, 2)}***`;
	return `${value.slice(0, head)}***${value.slice(-tail)}`;
}

/** 租户/应用只露尾部，避免把完整标识铺在界面上。 */
export function maskScope(value: string | undefined, tail = 4): string {
	if (!value) return "—";
	if (value.length <= tail) return "***";
	return `…${value.slice(-tail)}`;
}

/** 会话到期：同日只显示时分，跨日显示月日时分；无效输入返回 null 由调用方降级。 */
export function formatSessionExpiry(
	expiresAt: string | undefined,
	now: Date = new Date(),
): string | null {
	if (!expiresAt) return null;
	const target = new Date(expiresAt);
	if (Number.isNaN(target.getTime())) return null;
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${pad(target.getHours())}:${pad(target.getMinutes())}`;
	const sameDay =
		target.getFullYear() === now.getFullYear() &&
		target.getMonth() === now.getMonth() &&
		target.getDate() === now.getDate();
	const day = sameDay
		? "今天"
		: `${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
	return `${day} ${time} 到期`;
}

export interface AccountIdentity {
	platform: string;
	applicationId: string;
	tenantId: string;
	idType: string;
	externalId: string;
}

/**
 * 菜单里的身份摘要：平台名 + 脱敏外部标识 + 租户/应用尾部。
 * 没有绑定时明确说明，不编造姓名。
 */
export function describeIdentity(identity: AccountIdentity | undefined): {
	title: string;
	scope: string;
} {
	if (!identity) return { title: "未绑定外部身份", scope: "—" };
	const platformName = identity.platform === "feishu" ? "飞书" : identity.platform;
	return {
		title: `${platformName} · ${maskIdentifier(identity.externalId)}`,
		scope: `租户 ${maskScope(identity.tenantId)} · 应用 ${maskScope(identity.applicationId)}`,
	};
}
