import type { ChannelAccount } from "../contracts.js";
import { FeishuInbound, type FeishuInboundConfig } from "./inbound.js";
import { FeishuOutbound } from "./outbound.js";

/** Only composition knows the provider. Business services receive separate inbound/outbound ports. */
export function createFeishuAccount(
	config: FeishuInboundConfig & { appSecret: string },
): ChannelAccount {
	return {
		id: config.accountId,
		identityScope: {
			platform: "feishu",
			applicationId: config.appId,
			tenantId: config.tenantKey,
		},
		inbound: new FeishuInbound(config),
		outbound: new FeishuOutbound(config),
	};
}
