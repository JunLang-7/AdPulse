import type { DecisionCard } from "../domain/decisionCard.js";

/** accountId is an opaque configured connection; core knows no provider names or HTTP. */
export interface Recipient {
	accountId: string;
	kind: "user" | "group";
	externalId: string;
}
export interface CardDelivery {
	id: string;
	recipient: Recipient;
	card: DecisionCard;
	actions: Array<{ optionId: string; actionRef: string }>;
}
export interface DeliveryReceipt {
	externalMessageId: string;
}
export interface OutboundChannel {
	/** Must reuse delivery.id as provider idempotency key when supported. */
	send(delivery: CardDelivery): Promise<DeliveryReceipt>;
}
export type Actor =
	| { kind: "platform"; accountId: string; externalId: string }
	| { kind: "console"; userId: string };
export interface ChoiceCommand {
	sourceId: string;
	eventId: string;
	actionRef: string;
	actor: Actor;
}
