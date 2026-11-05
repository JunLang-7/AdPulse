import { Orchestrator, Worker } from "../packages/core/dist/index.js";
import type {
	CardDelivery,
	OutboundChannel,
	Proposal,
	Session,
	StartSession,
	Storage,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

export const proposal: Proposal = {
	card: {
		title: "复核出价",
		summary: "仅调整方案草案",
		evidence: [{ label: "CPC", value: "2 → 2.4" }],
	},
	candidates: [
		{
			id: "adjust",
			label: "出价降 10%",
			changes: [{ kind: "bidCpc", channelId: "ads", from: 2, to: 1.8 }],
			complete: true,
		},
		{ id: "observe", label: "继续观察", changes: [], complete: false },
	],
};

export interface Fixture {
	storage: Storage;
	decisions: Orchestrator;
	worker: Worker;
	sent: Map<string, CardDelivery>;
	now: () => string;
	advance(): void;
	start(overrides?: Partial<StartSession>): Promise<Session>;
}

export function fixture(storage: Storage = new MemoryStorage()): Fixture {
	let clock = "2026-01-01T00:00:00.000Z";
	const now = () => clock;
	const sent = new Map<string, CardDelivery>();
	const decisions = new Orchestrator(
		storage,
		{ propose: async () => structuredClone(proposal) },
		now,
	);
	const worker = new Worker(
		storage,
		decisions,
		new Map<string, OutboundChannel>([
			[
				"account-a",
				{
					async send(delivery) {
						sent.set(delivery.id, structuredClone(delivery));
						return { externalMessageId: delivery.id };
					},
				},
			],
		]),
		now,
	);
	return {
		storage,
		decisions,
		worker,
		sent,
		now,
		advance() {
			clock = new Date(Date.parse(clock) + 600_000).toISOString();
		},
		async start(overrides = {}) {
			return decisions.startSession({
				requestId: crypto.randomUUID(),
				ownerId: "owner",
				recipient: {
					accountId: "account-a",
					kind: "user",
					externalId: "user-a",
				},
				allowedActorIds: ["user-a"],
				strategy: {
					objective: "leads",
					audience: [],
					channels: { ads: { bidCpc: 2, budget: 100 } },
					sellingPoints: [],
				},
				limits: { maxBidChangeRatio: 0.2, maxBudgetChangeRatio: 0.2 },
				signal: {
					id: "sig",
					title: "成本变化",
					summary: "需要复核",
					evidence: proposal.card.evidence,
				},
				expiresAt: "2026-01-02T00:00:00.000Z",
				...overrides,
			});
		},
	};
}
