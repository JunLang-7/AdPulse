import type { Orchestrator } from "./orchestrator.js";
import type { OutboundChannel } from "./ports/channel.js";
import type { Storage } from "./ports/storage.js";
import type { Job } from "./state/model.js";

/** Reusable worker; the same instance can be embedded in API or run in a separate process. */
export class Worker {
	constructor(
		private storage: Storage,
		private decisions: Orchestrator,
		private channels: ReadonlyMap<string, OutboundChannel>,
		private now: () => string = () => new Date().toISOString(),
		private maxAttempts = 5,
	) {}

	async runOnce(): Promise<boolean> {
		const job = await this.storage.claimJob(this.now(), 60_000);
		if (!job) return false;
		try {
			switch (job.task.kind) {
				case "process_inbox":
					await this.decisions.processInbox(job.task.inboxId);
					break;
				case "prepare_round":
					await this.decisions.prepareRound(
						job.task.sessionId,
						job.task.version,
					);
					break;
				case "send_delivery":
					await this.send(job);
					break;
			}
			await this.storage.transaction(async (tx) => {
				const current = await tx.jobs.get(job.id);
				if (
					current?.status === "running" &&
					current.leaseToken === job.leaseToken
				) {
					await tx.jobs.put({ ...current, status: "done" });
				}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "job failed";
			await this.storage.transaction(async (tx) => {
				const current = await tx.jobs.get(job.id);
				if (
					current?.status !== "running" ||
					current.leaseToken !== job.leaseToken
				)
					return;
				if (
					current.task.kind === "process_inbox" &&
					current.attempts >= this.maxAttempts
				) {
					const inbox = await tx.inbox.get(current.task.inboxId);
					if (inbox?.status === "pending")
						await tx.inbox.put({ ...inbox, status: "failed", reason: message });
				}
				const exhausted = current.attempts >= this.maxAttempts;
				await tx.jobs.put({
					...current,
					status: exhausted ? "failed" : "pending",
					lastError: message,
					runAt: new Date(
						Date.parse(this.now()) +
							Math.min(300_000, 1000 * 2 ** current.attempts),
					).toISOString(),
				});
				if (exhausted && current.task.kind === "send_delivery") {
					const delivery = await tx.deliveries.get(current.task.deliveryId);
					if (delivery && delivery.status !== "sent") {
						await tx.deliveries.put({
							...delivery,
							status: "failed",
							lastError: message,
						});
					}
				}
			});
		}
		return true;
	}

	private async send(job: Job): Promise<void> {
		if (job.task.kind !== "send_delivery") return;
		const deliveryId = job.task.deliveryId;
		const delivery = await this.storage.transaction((tx) =>
			tx.deliveries.get(deliveryId),
		);
		if (
			!delivery ||
			delivery.status === "sent" ||
			delivery.status === "cancelled"
		)
			return;
		const round = await this.storage.transaction((tx) =>
			tx.rounds.get(delivery.roundId),
		);
		const session = round
			? await this.storage.transaction((tx) => tx.sessions.get(round.sessionId))
			: null;
		const now = this.now();
		const expired =
			!round || !session || session.expiresAt <= now || round.expiresAt <= now;
		const staleDecision =
			delivery.purpose === "decision" &&
			(expired ||
				round.status !== "open" ||
				session.status !== "awaiting_input");
		const staleConfirmation =
			delivery.purpose === "confirmation" && session?.status === "cancelled";
		if (staleDecision || staleConfirmation || expired) {
			await this.storage.transaction(async (tx) => {
				const current = await tx.deliveries.get(deliveryId);
				if (current && current.status === "pending")
					await tx.deliveries.put({ ...current, status: "cancelled" });
			});
			return;
		}
		const channel = this.channels.get(delivery.recipient.accountId);
		if (!channel) throw new Error("outbound account is not configured");
		// No database lock is held during a network request. Stable ID survives retries/crashes.
		const receipt = await channel.send(delivery);
		await this.storage.transaction(async (tx) => {
			const currentJob = await tx.jobs.get(job.id);
			if (
				currentJob?.status !== "running" ||
				currentJob.leaseToken !== job.leaseToken
			)
				return;
			const current = await tx.deliveries.get(deliveryId);
			if (!current || current.status === "sent") return;
			await tx.deliveries.put({
				...current,
				status: "sent",
				externalMessageId: receipt.externalMessageId,
				sentAt: this.now(),
			});
		});
	}
}
