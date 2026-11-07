import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { promisify } from "node:util";
import {
	SourceService,
	type ChoiceCommand,
} from "../packages/core/dist/index.js";
import { PostgresStorage } from "../packages/storage/dist/index.js";
import { fixture } from "./helpers.ts";

// Isolate the process: an unhandled Pool error must fail the test, not the runner.
test("PostgreSQL: idle connection termination does not crash and pool reconnects", {
	skip: !process.env.TEST_DATABASE_URL,
}, async () => {
	const script = `
		import { createRequire } from "node:module";
		import { PostgresStorage } from "./packages/storage/dist/index.js";
		const { Pool } = createRequire(new URL("./packages/storage/package.json", import.meta.url))("pg");
		const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
		const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
		const storage = new PostgresStorage(pool);
		try {
			await storage.initialize();
			const result = await pool.query("SELECT pg_backend_pid() AS pid");
			const disconnected = new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("idle error not observed")), 5000);
				pool.once("error", () => { clearTimeout(timer); resolve(); });
			});
			await admin.query("SELECT pg_terminate_backend($1)", [result.rows[0].pid]);
			await disconnected;
			await storage.transaction(async (tx) => { await tx.sessions.all(); });
		} finally {
			await storage.close();
			await admin.end();
		}
	`;
	await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
		timeout: 15_000,
	});
});

// Use a dedicated, disposable database. Normal unit tests require no database.
test("PostgreSQL: serializable decisions, rollback, reconnect and SKIP LOCKED claims", {
	skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
	const databaseUrl = process.env.TEST_DATABASE_URL!;
	const storage = PostgresStorage.connect(databaseUrl);
	t.after(() => storage.close());
	await storage.initialize();
	const f = fixture(storage);
	const session = await f.start();
	await f.decisions.prepareRound(session.id, 0);
	const actions = await storage.transaction(async (tx) =>
		(await tx.actions.all()).filter((a) => a.roundId === `${session.id}:1`),
	);
	const command: ChoiceCommand = {
		sourceId: "account-a",
		eventId: crypto.randomUUID(),
		actionRef: actions[0].id,
		actor: { kind: "platform", accountId: "account-a", externalId: "user-a" },
	};
	const duplicate = await Promise.all(
		Array.from({ length: 20 }, () => f.decisions.receiveChoice(command)),
	);
	assert.equal(new Set(duplicate.map((x) => x.id)).size, 1);
	const other = await f.decisions.receiveChoice({
		...command,
		eventId: crypto.randomUUID(),
		actionRef: actions[1].id,
	});
	await Promise.all([
		f.decisions.processInbox(duplicate[0].id),
		f.decisions.processInbox(other.id),
	]);
	const saved = await storage.transaction((tx) => tx.sessions.get(session.id));
	assert.ok(saved);
	assert.equal(saved.version, 1);
	const outcomes = await storage.transaction(async (tx) => [
		await tx.inbox.get(duplicate[0].id),
		await tx.inbox.get(other.id),
	]);
	assert.deepEqual(outcomes.map((x) => x!.status).sort(), [
		"processed",
		"rejected",
	]);
	await assert.rejects(
		storage.transaction(async (tx) => {
			const current = await tx.sessions.get(session.id);
			assert.ok(current);
			await tx.sessions.put({ ...current, version: 999 });
			throw new Error("rollback test");
		}),
		/rollback test/,
	);
	const reconnected = PostgresStorage.connect(databaseUrl);
	try {
		assert.equal(
			(await reconnected.transaction((tx) => tx.sessions.get(session.id)))!
				.version,
			1,
		);
	} finally {
		await reconnected.close();
	}
	const claims = await Promise.all([
		storage.claimJob(f.now(), 60_000),
		storage.claimJob(f.now(), 60_000),
	]);
	assert.ok(claims.every(Boolean));
	assert.notEqual(claims[0]!.id, claims[1]!.id);
});

test("PostgreSQL: source tables, advisory lock and purge deletion", {
	skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
	const databaseUrl = process.env.TEST_DATABASE_URL!;
	const storage = PostgresStorage.connect(databaseUrl);
	t.after(() => storage.close());
	await storage.initialize();

	// Migration 6 must have created the three source tables.
	const tables = await storage.transaction(async (tx) => ({
		runs: (await tx.sourceRuns.all()).length,
		snapshots: (await tx.sourceSnapshots.all()).length,
		items: (await tx.sourceItems.all()).length,
		states: (await tx.sourceStates.all()).length,
	}));
	assert.ok(tables.runs >= 0 && tables.items >= 0 && tables.states >= 0);

	// Advisory lock excludes a second connection and is released afterwards.
	const other = PostgresStorage.connect(databaseUrl);
	t.after(() => other.close());
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const holder = storage.runExclusive("source:haier_news", async () => {
		await gate;
		return "first";
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	const blocked = await other.runExclusive("source:haier_news", async () => "second");
	assert.equal(blocked.acquired, false);
	release();
	const held = await holder;
	assert.equal(held.acquired, true);
	assert.equal(held.value, "first");
	const afterRelease = await other.runExclusive("source:haier_news", async () => "third");
	assert.equal(afterRelease.acquired, true);
	assert.equal(afterRelease.value, "third");

	// Purge removes snapshot rows and keeps the identity as purged.
	const service = new SourceService(
		storage,
		{ async fetchText() { throw new Error("network disabled in tests"); } },
		{ enabled: false },
	);
	await storage.transaction(async (tx) => {
		await tx.sourceItems.put({
			id: "haier_news:https://www.haier.com/about_haier/xinwen/20261106_296220.shtml",
			sourceKey: "haier_news",
			itemKey: "https://www.haier.com/about_haier/xinwen/20261106_296220.shtml",
			title: "测试条目",
			itemUrl: "https://www.haier.com/about_haier/xinwen/20261106_296220.shtml",
			publishedAt: null,
			firstSeenAt: "2026-11-07T00:00:00.000Z",
			lastSeenAt: "2026-11-07T00:00:00.000Z",
			titleUpdatedAt: null,
			contentScope: "title_link_only",
			status: "active",
		});
		await tx.sourceSnapshots.put({
			id: "run-test:entry",
			runId: "run-test",
			sourceKey: "haier_news",
			itemKey: "https://www.haier.com/about_haier/xinwen/20261106_296220.shtml",
			contentHash: "abc",
			createdAt: "2026-11-07T00:00:00.000Z",
		});
	});
	await service.purge("haier_news", "2026-11-07T01:00:00.000Z");
	const remaining = await storage.transaction(async (tx) => ({
		snapshots: (await tx.sourceSnapshots.all()).filter(
			(row) => row.sourceKey === "haier_news",
		).length,
		items: (await tx.sourceItems.all()).filter(
			(row) => row.sourceKey === "haier_news" && row.status === "purged",
		).length,
	}));
	assert.equal(remaining.snapshots, 0);
	assert.ok(remaining.items >= 1);
});

test("PostgreSQL: auth migration is idempotent and concurrent first logins reuse one user", {
	skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
	const databaseUrl = process.env.TEST_DATABASE_URL!;
	const storage = PostgresStorage.connect(databaseUrl);
	const reconnected = PostgresStorage.connect(databaseUrl);
	t.after(async () => {
		await storage.close();
		await reconnected.close();
	});
	await storage.initialize();
	await storage.initialize();

	const { Pool } = createRequire(
		new URL("../packages/storage/package.json", import.meta.url),
	)("pg") as { Pool: new (options: { connectionString: string }) => {
		query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
		end(): Promise<void>;
	} };
	const admin = new Pool({ connectionString: databaseUrl });
	t.after(() => admin.end());
	const migrations = await admin.query(
		"SELECT version FROM adpulse_schema_migrations ORDER BY version",
	);
	assert.deepEqual(
		migrations.rows.map((row) => Number(row.version)),
		[1, 2, 3, 4, 5, 6, 7],
	);
	const indexes = await admin.query(
		`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
		AND indexname IN ('adpulse_identity_binding_scope', 'adpulse_web_sessions_user',
		'adpulse_login_transactions_expiry') ORDER BY indexname`,
	);
	assert.deepEqual(
		indexes.rows.map((row) => row.indexname),
		[
			"adpulse_identity_binding_scope",
			"adpulse_login_transactions_expiry",
			"adpulse_web_sessions_user",
		],
	);

	const { AuthenticationService } = await import("../packages/core/dist/index.js");
	const auth = new AuthenticationService(storage);
	const scope = crypto.randomUUID();
	const identity = {
		platform: "feishu",
		applicationId: `cli_${scope}`,
		tenantId: `tenant-${scope}`,
		idType: "open_id",
		externalId: `ou_${scope}`,
	};
	const now = new Date().toISOString();
	const sessions = await Promise.all(
		Array.from({ length: 12 }, (_, index) =>
			auth.createWebSession(
				identity,
				createHash("sha256").update(`${scope}:${index}`).digest("hex"),
				now,
			),
		),
	);
	assert.equal(new Set(sessions.map((session) => session.userId)).size, 1);
	const bindings = await storage.transaction((tx) => tx.identityBindings.all());
	assert.equal(
		bindings.filter((binding) => binding.externalId === identity.externalId).length,
		1,
	);
	assert.equal(
		(
			await reconnected.transaction((tx) => tx.users.all())
		).filter((user) => user.id === sessions[0].userId).length,
		1,
		"the session user survives a new pool",
	);
	assert.equal(
		(
			await reconnected.transaction((tx) =>
				tx.webSessions.get(sessions[0].sessionId),
			)
		)?.userId,
		sessions[0].userId,
	);
});
