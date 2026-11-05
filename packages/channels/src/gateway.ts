import type { Orchestrator, OutboundChannel } from "@adpluse/core";
import type {
	ChannelAccount,
	WebhookRequest,
	WebhookResponse,
} from "./contracts.js";
import { WebhookError } from "./contracts.js";

/** Connection registry: adding a provider never changes the business service or HTTP router. */
export class ChannelRegistry {
	private accounts = new Map<string, ChannelAccount>();
	constructor(accounts: ChannelAccount[]) {
		for (const account of accounts) {
			if (!account.id || this.accounts.has(account.id))
				throw new Error("duplicate or empty channel account");
			this.accounts.set(account.id, account);
		}
	}
	outbound(): ReadonlyMap<string, OutboundChannel> {
		return new Map(
			[...this.accounts].map(([id, account]) => [id, account.outbound]),
		);
	}
	has(id: string): boolean {
		return this.accounts.has(id);
	}
	async handle(
		accountId: string,
		request: WebhookRequest,
		decisions: Orchestrator,
	): Promise<WebhookResponse> {
		const account = this.accounts.get(accountId);
		if (!account) throw new WebhookError(404, "unknown account");
		const result = await account.inbound.parse(request);
		if (result.kind === "choice") {
			// The registry, not the untrusted body, determines the event namespace.
			if (
				result.command.actor.kind !== "platform" ||
				result.command.actor.accountId !== accountId
			) {
				throw new WebhookError(403, "account mismatch");
			}
			await decisions.receiveChoice({ ...result.command, sourceId: accountId });
		}
		// Database errors propagate: never ACK an event that was not durably accepted.
		return result.response;
	}
}
