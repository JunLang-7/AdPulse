import type { Transaction } from "./ports/storage.js";

/** Cancel only pending proactive decisions, never business state or user-operation receipts. */
export async function cancelDecisionDeliveriesIn(
	tx: Transaction,
	userId: string,
	reason: string,
	exceptDeliveryId?: string,
): Promise<void> {
	for (const delivery of await tx.deliveries.all()) {
		if (
			delivery.id === exceptDeliveryId ||
			!delivery.proactiveDecision ||
			!["pending", "failed"].includes(delivery.status)
		)
			continue;
		const session = delivery.sessionId
			? await tx.sessions.get(delivery.sessionId)
			: null;
		if (session?.ownerId !== userId) continue;
		await tx.deliveries.put({
			...delivery,
			status: "suppressed",
			suppressionReason: reason,
		});
	}
}
