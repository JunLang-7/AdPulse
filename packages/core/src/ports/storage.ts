import type { Entities, Job } from "../state/model.js";

export interface Table<T extends { id: string }> {
	get(id: string): Promise<T | null>;
	put(entity: T): Promise<void>;
	all(): Promise<T[]>;
}
export type Transaction = { [K in keyof Entities]: Table<Entities[K]> };
export interface Storage {
	/** Serializable; retries may re-run work. Never perform network I/O in work. */
	transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
	claimJob(now: string, leaseMs: number): Promise<Job | null>;
}
