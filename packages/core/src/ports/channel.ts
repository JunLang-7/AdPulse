import type { DecisionCard } from "../domain/decisionCard.js";
import type { InfoCard } from "../domain/infoCard.js";

/** accountId is an opaque configured connection; core knows no provider names or HTTP. */
export interface Recipient {
	accountId: string;
	kind: "user" | "group";
	externalId: string;
}
export interface CardDelivery {
	id: string;
	recipient: Recipient;
	/** 决策卡（有候选）或信息卡（日汇总，无候选、无 Session）。 */
	card: DecisionCard | InfoCard;
	actions: Array<{ optionId: string; actionRef: string }>;
}
export interface DeliveryReceipt {
	externalMessageId: string;
}
export interface OutboundChannel {
	/** Must reuse delivery.id as provider idempotency key when supported. */
	send(delivery: CardDelivery): Promise<DeliveryReceipt>;
}
/** Provider-attested, tenant/app-scoped identity; never a bare external ID. */
export interface PlatformIdentity {
	platform: string;
	applicationId: string;
	tenantId: string;
	idType: string;
	externalId: string;
}
export type Actor =
	| {
			kind: "platform";
			accountId: string;
			externalId: string;
			/** Resolved server-side from PlatformIdentity; absent means unverified. */
			userId?: string;
		}
	| { kind: "console"; userId: string };
export interface ChoiceCommand {
	sourceId: string;
	eventId: string;
	actionRef: string;
	actor: Actor;
}

/**
 * 平台明确表示「收件人不可达」（用户不存在/不在可用范围/机器人不在会话）。
 * 与限流、网络故障区分：只有这一类才可能让目的地失效。
 */
export class RecipientUnreachableError extends Error {
	constructor(message = "recipient unreachable") {
		super(message);
		this.name = "RecipientUnreachableError";
	}
}
