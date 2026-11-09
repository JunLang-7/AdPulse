import {
	type CardDelivery,
	type DeliveryReceipt,
	type OutboundChannel,
	RecipientUnreachableError,
} from "@adpluse/core";
import { toFeishuCard } from "./feishuRenderer.js";

/** 平台表示收件人不可达的错误码：重试无意义，可能意味着地址已失效。 */
const UNREACHABLE_CODES = new Set([230002, 230013, 99992351]);

export interface FeishuOutboundConfig {
	accountId: string;
	appId: string;
	appSecret: string;
}
export class FeishuOutbound implements OutboundChannel {
	private token: { value: string; expiresAt: number } | undefined;
	private refreshing: Promise<string> | undefined;
	constructor(
		private config: FeishuOutboundConfig,
		private http: typeof fetch = fetch,
	) {
		if (Object.values(config).some((value) => !value))
			throw new Error("incomplete Feishu outbound configuration");
	}

	async send(delivery: CardDelivery): Promise<DeliveryReceipt> {
		if (delivery.recipient.accountId !== this.config.accountId)
			throw new Error("recipient account mismatch");
		const type = delivery.recipient.kind === "user" ? "open_id" : "chat_id";
		const token = await this.accessToken();
		const response = await this.http(
			`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${type}`,
			{
				method: "POST",
				signal: AbortSignal.timeout(10_000),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					receive_id: delivery.recipient.externalId,
					msg_type: "interactive",
					content: JSON.stringify(toFeishuCard(delivery)),
					uuid: delivery.id,
				}),
			},
		);
		const body = (await response.json()) as {
			code?: number;
			data?: { message_id?: string };
		};
		if (!response.ok || body.code !== 0 || !body.data?.message_id) {
			// Invalidate on failure; job retry will obtain a fresh token. Do not log provider bodies/secrets.
			this.token = undefined;
			// 230002 用户不存在/不在范围、230013 机器人不在会话、99992351 receive_id 非法：
			// 这些是「收件人不可达」，重试也不会成功，交给上层决定是否让目的地失效。
			if (UNREACHABLE_CODES.has(Number(body.code)))
				throw new RecipientUnreachableError();
			throw new Error(
				`Feishu send failed (HTTP ${response.status}, code ${body.code ?? "unknown"})`,
			);
		}
		return { externalMessageId: body.data.message_id };
	}

	private async accessToken(): Promise<string> {
		if (this.token && this.token.expiresAt > Date.now())
			return this.token.value;
		if (!this.refreshing)
			this.refreshing = this.refreshToken().finally(() => {
				this.refreshing = undefined;
			});
		return this.refreshing;
	}
	private async refreshToken(): Promise<string> {
		const response = await this.http(
			"https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
			{
				method: "POST",
				signal: AbortSignal.timeout(10_000),
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					app_id: this.config.appId,
					app_secret: this.config.appSecret,
				}),
			},
		);
		const body = (await response.json()) as {
			code?: number;
			tenant_access_token?: string;
			expire?: number;
		};
		if (
			!response.ok ||
			body.code !== 0 ||
			!body.tenant_access_token ||
			!body.expire
		) {
			throw new Error(`Feishu token refresh failed (HTTP ${response.status})`);
		}
		this.token = {
			value: body.tenant_access_token,
			expiresAt: Date.now() + Math.max(0, body.expire - 60) * 1000,
		};
		return this.token.value;
	}
}
