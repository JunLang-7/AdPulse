import type {
	ChoiceCommand,
	OutboundChannel,
	PlatformIdentity,
} from "@adpluse/core";

export interface WebhookRequest {
	method: string;
	url: string;
	headers: Readonly<Record<string, string>>;
	rawBody: Uint8Array;
}
export interface WebhookResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
}
export type InboundResult =
	| { kind: "response"; response: WebhookResponse }
	| { kind: "choice"; command: ChoiceCommand; response: WebhookResponse };

export interface InboundChannel {
	/** Authenticate, decrypt, normalize and construct the provider-specific response. No business writes. */
	parse(request: WebhookRequest): Promise<InboundResult>;
	/** Provider-attested identity for a normalized platform actor, scoped to app and tenant. */
	identifyActor?(actor: {
		accountId: string;
		externalId: string;
	}): PlatformIdentity | null;
}
export interface ChannelAccount {
	id: string;
	/** Verified identity scope this connection can attest; absent for synthetic/demo accounts. */
	identityScope?: {
		platform: string;
		applicationId: string;
		tenantId: string;
	};
	inbound: InboundChannel;
	outbound: OutboundChannel;
}
export class WebhookError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}
export const jsonResponse = (body: unknown, status = 200): WebhookResponse => ({
	status,
	headers: { "content-type": "application/json; charset=utf-8" },
	body: JSON.stringify(body),
});
