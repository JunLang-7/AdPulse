/**
 * 平台标签：只做展示映射，输入来自 /api/me 的 identities[].platform。
 * 不认识的平台原样显示，避免把内部代码硬写成产品名。
 */
const KNOWN: Record<string, string> = {
	feishu: "飞书",
	lark: "飞书",
	dingtalk: "钉钉",
	wecom: "企业微信",
	weixin: "企业微信",
};

export function platformLabel(platform: string | undefined): string | null {
	const value = platform?.trim().toLowerCase();
	if (!value) return null;
	return KNOWN[value] ?? platform!.trim();
}
