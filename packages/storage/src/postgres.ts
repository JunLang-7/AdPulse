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
			if (!current.has(3)) {
				for (const name of [
					"evidenceHeads",
					"evidenceVersions",
					"evidenceSources",
					"evidenceOperations",
				]) await this.createEntityTable(client, name);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_evidence_version
					ON adpulse_evidenceVersions ((data->>'evidenceId'), (data->>'version'))`);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_evidence_source_ref
					ON adpulse_evidenceSources ((data->>'evidenceId'), (data->>'evidenceVersion'), (data->'source'->>'reportRef'))`);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_evidence_operation_key
					ON adpulse_evidenceOperations ((data->>'ownerId'), (data->>'operation'), (data->>'key'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (3)",
				);
			}
			if (!current.has(4)) {
				for (const name of [
					"comparisonResults",
					"comparisonOperations",
					"comparisonFollowUps",
				]) await this.createEntityTable(client, name);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_comparison_operation_key
					ON adpulse_comparisonOperations ((data->>'ownerId'), (data->>'operation'), (data->>'key'))`);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_comparison_follow_up_dedup
					ON adpulse_comparisonFollowUps ((data->>'dedupKey'))`);
				await client.query(`CREATE INDEX IF NOT EXISTS adpulse_comparison_result_task
					ON adpulse_comparisonResults ((data->>'ownerId'), (data->>'taskId'), (data->>'createdAt'))`);
				await client.query(`CREATE INDEX IF NOT EXISTS adpulse_comparison_follow_up_task
					ON adpulse_comparisonFollowUps ((data->>'ownerId'), (data->>'taskId'), (data->>'status'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (4)",
				);
			}
			if (!current.has(5)) {
				await this.createEntityTable(client, "investigationAlerts");
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_investigation_alert_logical_gap
					ON adpulse_investigationAlerts ((data->>'ownerId'), (data->>'logicalKey'))`);
				await client.query(`CREATE INDEX IF NOT EXISTS adpulse_investigation_alert_task
					ON adpulse_investigationAlerts ((data->>'ownerId'), (data->>'taskId'), (data->>'updatedAt'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (5)",
				);
			}
			if (!current.has(6)) {
				for (const name of [
					"sourceStates",
					"sourceRuns",
					"sourceSnapshots",
					"sourceItems",
				]) await this.createEntityTable(client, name);
				await client.query(`CREATE INDEX IF NOT EXISTS adpulse_source_run_source
					ON adpulse_sourceRuns ((data->>'sourceKey'), (data->>'startedAt'))`);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_source_snapshot_entry
					ON adpulse_sourceSnapshots ((data->>'runId'), (data->>'itemKey'))`);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_source_item_identity
					ON adpulse_sourceItems ((data->>'sourceKey'), (data->>'itemKey'))`);
				await client.query(`CREATE INDEX IF NOT EXISTS adpulse_source_item_status
					ON adpulse_sourceItems ((data->>'sourceKey'), (data->>'status'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (6)",
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
			if (!current.has(8)) {
				for (const name of [
					"notificationDestinations",
					"notificationConsents",
				]) await this.createEntityTable(client, name);
			// 每人每个平台作用域只有一个目的地：唯一约束兜住并发与串号。
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_notification_destination_scope
					ON adpulse_notificationDestinations ((data->>'userId'), (data->>'platform'),
					(data->>'applicationId'), (data->>'tenantId'), (data->>'idType'),
					(data->>'externalId'))`);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_notification_consent_unique
					ON adpulse_notificationConsents ((data->>'userId'), (data->>'destinationId'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (8)",
				);
			}
			if (!current.has(9)) {
				for (const name of ["subscriptionSettings", "subscriptionTargets"])
					await this.createEntityTable(client, name);
				// 每人一份设置；关注对象在同一 user + kind + refId 下唯一，堵住并发重复录入。
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_subscription_settings_user
					ON adpulse_subscriptionSettings ((data->>'userId'))`);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_subscription_target_ref
					ON adpulse_subscriptionTargets ((data->>'userId'), (data->>'kind'), (data->>'refId'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (9)",
				);
			}
			if (!current.has(10)) {
				for (const name of ["notificationBatches", "notificationItems"])
					await this.createEntityTable(client, name);
				// 一人一天一类一份批次：并发调度不会生成两份；条目按逻辑事件唯一。
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_notification_batch_key
					ON adpulse_notificationBatches ((data->>'ownerId'), (data->>'kind'), (data->>'localDate'))`);
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_notification_item_key
					ON adpulse_notificationItems ((data->>'ownerId'), (data->>'logicalKey'))`);
				await client.query(`CREATE INDEX IF NOT EXISTS adpulse_notification_item_batch
					ON adpulse_notificationItems ((data->>'batchId'), (data->>'status'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (10)",
				);
			}
			if (!current.has(11)) {
				for (const name of [
					"userModelConnections",
					"userModelCredentials",
					"userModelPreferences",
				]) await this.createEntityTable(client, name);
				// 同一用户的 Provider ID 唯一；跨用户同名允许存在。并发创建由唯一索引兜底。
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_model_connection_provider
					ON adpulse_userModelConnections ((data->>'ownerId'), (data->>'providerId'))`);
				// 每条连接一份凭据；id 与 connectionId 相同，这里再按归属加一道约束。
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_model_credential_connection
					ON adpulse_userModelCredentials ((data->>'ownerId'), (data->>'connectionId'))`);
				// 每人一份默认选择。
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_model_preference_owner
					ON adpulse_userModelPreferences ((data->>'ownerId'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (11)",
				);
			}
			if (!current.has(12)) {
				// 撤销墓碑与连接/密文分表：恢复备份后用它重新执行删除，防止旧凭据复活。
				await this.createEntityTable(client, "userModelRevocations");
				await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS adpulse_model_revocation_connection
					ON adpulse_userModelRevocations ((data->>'ownerId'), (data->>'connectionId'))`);
				await client.query(
					"INSERT INTO adpulse_schema_migrations(version) VALUES (12)",
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
					delete: async (id: string) => {
						await client.query(`DELETE FROM adpulse_${name} WHERE id = $1`, [
							id,
						]);
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

	/**
	 * Cross-process guard for scheduled polling. Uses a session advisory lock on
	 * a dedicated client; the lock is released even when the work throws.
	 */
	async runExclusive<T>(
		key: string,
		work: () => Promise<T>,
	): Promise<{ acquired: boolean; value: T | null }> {
		const client = await this.pool.connect();
		let locked = false;
		try {
			const result = await client.query(
				"SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
				[key],
			);
			locked = result.rows[0]?.locked === true;
			if (!locked) return { acquired: false, value: null };
			return { acquired: true, value: await work() };
		} finally {
			if (locked)
				await client
					.query("SELECT pg_advisory_unlock(hashtext($1))", [key])
					.catch(() => undefined);
			client.release();
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
