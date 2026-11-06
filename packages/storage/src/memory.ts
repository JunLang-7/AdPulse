import type { Entities, Job, Storage, Transaction } from "@adpluse/core";

export const tableNames = [
	"tasks",
	"taskVersions",
	"taskOperations",
	"evidenceHeads",
	"evidenceVersions",
	"evidenceSources",
	"evidenceOperations",
	"comparisonResults",
	"comparisonOperations",
	"comparisonFollowUps",
	"investigationAlerts",
	"sessions",
	"rounds",
	"actions",
	"snapshots",
	"inbox",
	"deliveries",
	"jobs",
] as const;
type Data = { [K in keyof Entities]: Map<string, Entities[K]> };

/** Test/demo only. Serializes transactions, clones values and rolls back all tables on error. */
export class MemoryStorage implements Storage {
	private data = Object.fromEntries(
		tableNames.map((name) => [name, new Map()]),
	) as Data;
	private tail: Promise<void> = Promise.resolve();

	async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			const draft = structuredClone(this.data);
			const tx = Object.fromEntries(
				tableNames.map((name) => [
					name,
					{
						get: async (id: string) =>
							structuredClone(draft[name].get(id) ?? null),
						put: async (entity: { id: string }) => {
							(draft[name] as Map<string, { id: string }>).set(
								entity.id,
								structuredClone(entity),
							);
						},
						all: async () => structuredClone([...draft[name].values()]),
					},
				]),
			) as unknown as Transaction;
			const result = await work(tx);
			this.data = draft;
			return structuredClone(result);
		} finally {
			release();
		}
	}

	async claimJob(now: string, leaseMs: number): Promise<Job | null> {
		return this.transaction(async (tx) => {
			const ready = (await tx.jobs.all()).filter(
				(job) =>
					(job.status === "pending" && job.runAt <= now) ||
					(job.status === "running" && (job.lockedUntil ?? "") <= now),
			);
			ready.sort(
				(a, b) => a.runAt.localeCompare(b.runAt) || a.id.localeCompare(b.id),
			);
			const job = ready[0];
			if (!job) return null;
			const claimed: Job = {
				...job,
				status: "running",
				attempts: job.attempts + 1,
				leaseToken: crypto.randomUUID(),
				lockedUntil: new Date(Date.parse(now) + leaseMs).toISOString(),
			};
			await tx.jobs.put(claimed);
			return claimed;
		});
	}
}
