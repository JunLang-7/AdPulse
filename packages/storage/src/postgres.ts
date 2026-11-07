import type { Entities, Job, Storage, Transaction } from "@adpluse/core";
import { Pool, type PoolClient } from "pg";
import { tableNames } from "./memory.js";

const retryable = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	["40001", "40P01"].includes(String(error.code));

/** Fixed entity tables: SQL identifiers never come from a request. */
export class PostgresStorage implements Storage {
	constructor(private pool: Pool) {
		// Idle clients can fail outside a query; without a listener pg emits an
		// unhandled error and terminates the process. Do not log client details.
		this.pool.on("error", () => {
			console.error("PostgreSQL idle connection failed; pool will reconnect");
		});
	}

	static connect(connectionString: string): PostgresStorage {
		return new PostgresStorage(new Pool({ connectionString }));
	}

	async close(): Promise<void> {
		await this.pool.end();
	}

	/** Applies ordered, additive schema migrations under a process-wide advisory lock. */
	async initialize(): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT pg_advisory_xact_lock(702445811)");
			await client.query(`CREATE TABLE IF NOT EXISTS adpulse_schema_migrations (
				version integer PRIMARY KEY,
				applied_at timestamptz NOT NULL DEFAULT now()
			)`);
			const applied = await client.query(
				"SELECT version FROM adpulse_schema_migrations ORDER BY version",
			);
			const current = new Set<number>(
				applied.rows.map((row) => Number(row.version)),
			);
			if (!current.has(1)) {
				for (const name of [
					"sessions",
					"rounds",
					"actions",
					"snapshots",
					"inbox",
					"deliveries",
					"jobs",
				]) await this.createEntityTable(client, name);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_round_number
					ON adpulse_rounds ((data->>'sessionId'), (data->>'roundNo'))`);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_strategy_version
					ON adpulse_snapshots ((data->>'sessionId'), (data->>'version'))`);
				await client.query(`CREATE INDEX IF NOT EXISTS adpulse_jobs_due
					ON adpulse_jobs ((data->>'status'), (data->>'runAt'))`);
				await client.query(`CREATE INDEX IF NOT EXISTS adpulse_jobs_lease
					ON adpulse_jobs ((data->>'status'), (data->>'lockedUntil'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (1)",
				);
			}
			if (!current.has(2)) {
				for (const name of ["tasks", "taskVersions", "taskOperations"])
					await this.createEntityTable(client, name);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_task_version
					ON adpulse_taskVersions ((data->>'taskId'), (data->>'version'))`);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_task_operation_key
					ON adpulse_taskOperations ((data->>'ownerId'), (data->>'operation'), (data->>'key'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (2)",
				);
			}
			// Versions 3-6 are reserved for the evidence/comparison/alert/source chain.
			if (!current.has(7)) {
				for (const name of [
					"users",
					"identityBindings",
					"webSessions",
					"loginTransactions",
				]) await this.createEntityTable(client, name);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_identity_binding_scope
					ON adpulse_identityBindings ((data->>'platform'), (data->>'applicationId'),
					(data->>'tenantId'), (data->>'idType'), (data->>'externalId'))`);
				await client.query(`CREATE INDEX IF NOT EXISTS adpulse_web_sessions_user
					ON adpulse_webSessions ((data->>'userId'), (data->>'expiresAt'))`);
				await client.query(`CREATE INDEX IF NOT EXISTS adpulse_login_transactions_expiry
					ON adpulse_loginTransactions ((data->>'status'), (data->>'expiresAt'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (7)",
				);
			}
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	private async createEntityTable(
		client: PoolClient,
		name: string,
	): Promise<void> {
		await client.query(`CREATE TABLE IF NOT EXISTS adpulse_${name} (
			id text PRIMARY KEY,
			data jsonb NOT NULL,
			CONSTRAINT entity_id_matches CHECK (data->>'id' = id)
		)`);
	}

	private tables(client: PoolClient): Transaction {
		return Object.fromEntries(
			tableNames.map((name) => [
				name,
				{
					get: async (id: string) => {
						const result = await client.query(
							`SELECT data FROM adpulse_${name} WHERE id = $1 FOR UPDATE`,
							[id],
						);
						return result.rows[0]?.data ?? null;
					},
					put: async (entity: Entities[typeof name]) => {
						await client.query(
							`INSERT INTO adpulse_${name}(id, data) VALUES ($1, $2::jsonb)
          ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
							[entity.id, JSON.stringify(entity)],
						);
					},
					all: async () => {
						const result = await client.query(
							`SELECT data FROM adpulse_${name} ORDER BY id`,
						);
						return result.rows.map((row) => row.data);
					},
				},
			]),
		) as Transaction;
	}

	async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const client = await this.pool.connect();
			try {
				await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
				const result = await work(this.tables(client));
				await client.query("COMMIT");
				return result;
			} catch (error) {
				await client.query("ROLLBACK");
				if (attempt < 4 && retryable(error)) continue;
				throw error;
			} finally {
				client.release();
			}
		}
	}

	async claimJob(now: string, leaseMs: number): Promise<Job | null> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await client.query(
				`SELECT data FROM adpulse_jobs
        WHERE (data->>'status' = 'pending' AND data->>'runAt' <= $1)
           OR (data->>'status' = 'running' AND data->>'lockedUntil' <= $1)
        ORDER BY data->>'runAt', id FOR UPDATE SKIP LOCKED LIMIT 1`,
				[now],
			);
			const job = result.rows[0]?.data as Job | undefined;
			if (!job) {
				await client.query("COMMIT");
				return null;
			}
			const claimed: Job = {
				...job,
				status: "running",
				attempts: job.attempts + 1,
				leaseToken: crypto.randomUUID(),
				lockedUntil: new Date(Date.parse(now) + leaseMs).toISOString(),
			};
			await client.query(
				"UPDATE adpulse_jobs SET data = $2::jsonb WHERE id = $1",
				[job.id, JSON.stringify(claimed)],
			);
			await client.query("COMMIT");
			return claimed;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
}
