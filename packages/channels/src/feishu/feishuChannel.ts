import type { ChannelAccount } from "../contracts.js";
import { FeishuInbound, type FeishuInboundConfig } from "./inbound.js";
import { FeishuOutbound } from "./outbound.js";

/** Only composition knows the provider. Business services receive separate inbound/outbound ports. */
export function createFeishuAccount(
	config: FeishuInboundConfig & { appSecret: string },
): ChannelAccount {
	return {
		id: config.accountId,
		inbound: new FeishuInbound(config),
		outbound: new FeishuOutbound(config),
	};
}
