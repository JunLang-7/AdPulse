import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { promisify } from "node:util";
import {
	NotificationService,
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
		actor: {
			kind: "platform",
			accountId: "account-a",
			externalId: "user-a",
			userId: "owner",
		},
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
		[1, 2, 3, 4, 5, 6, 7, 8],
	);
	const indexes = await admin.query(
		`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
		AND indexname IN ('adpulse_identity_binding_scope', 'adpulse_web_sessions_user',
		'adpulse_login_transactions_expiry', 'adpulse_notification_destination_scope',
		'adpulse_notification_consent_unique') ORDER BY indexname`,
	);
	assert.deepEqual(
		indexes.rows.map((row) => row.indexname),
		[
			"adpulse_identity_binding_scope",
			"adpulse_login_transactions_expiry",
			"adpulse_notification_consent_unique",
			"adpulse_notification_destination_scope",
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

test("PostgreSQL: a failed auth migration rolls back atomically and can be retried", {
	skip: !process.env.TEST_DATABASE_URL,
}, async () => {
	const databaseUrl = process.env.TEST_DATABASE_URL!;
	const { Pool } = createRequire(
		new URL("../packages/storage/package.json", import.meta.url),
	)("pg") as { Pool: new (options: { connectionString: string }) => {
		query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
		end(): Promise<void>;
	} };
	const schema = `auth_migration_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const admin = new Pool({ connectionString: databaseUrl });
	await admin.query(`CREATE SCHEMA ${schema}`);
	const scopedUrl = new URL(databaseUrl);
	scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
	const storage = PostgresStorage.connect(scopedUrl.toString());
	const check = new Pool({ connectionString: scopedUrl.toString() });
	try {
		// Simulate a partially conflicting deployment: the entity table exists but
		// lacks the columns used by the migration's indexes.
		await admin.query(
			`CREATE TABLE ${schema}.adpulse_identityBindings (id text primary key)`,
		);
		await assert.rejects(storage.initialize());
		const tables = await check.query(`SELECT
			to_regclass('adpulse_users') AS users,
			to_regclass('adpulse_webSessions') AS web_sessions,
			to_regclass('adpulse_schema_migrations') AS migrations`);
		assert.deepEqual(tables.rows[0], {
			users: null,
			web_sessions: null,
			migrations: null,
		});

		await admin.query(`DROP TABLE ${schema}.adpulse_identityBindings`);
		await storage.initialize();
		const versions = await check.query(
			"SELECT version FROM adpulse_schema_migrations ORDER BY version",
		);
		assert.deepEqual(
			versions.rows.map((row) => Number(row.version)),
			[1, 2, 3, 4, 5, 6, 7, 8],
		);
	} finally {
		await check.end();
		await storage.close();
		await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
		await admin.end();
	}
});

test("PostgreSQL: authentication survives a process restart and repeated initialization", {
	skip: !process.env.TEST_DATABASE_URL,
}, async () => {
	const databaseUrl = process.env.TEST_DATABASE_URL!;
	const { Pool } = createRequire(
		new URL("../packages/storage/package.json", import.meta.url),
	)("pg") as { Pool: new (options: { connectionString: string }) => {
		query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
		end(): Promise<void>;
	} };
	const schema = `auth_restart_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const admin = new Pool({ connectionString: databaseUrl });
	await admin.query(`CREATE SCHEMA ${schema}`);
	const scopedUrl = new URL(databaseUrl);
	scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
	const storage = PostgresStorage.connect(scopedUrl.toString());
	try {
		await storage.initialize();
		const { AuthenticationService } = await import("../packages/core/dist/index.js");
		const auth = new AuthenticationService(storage);
		const identity = {
			platform: "feishu",
			applicationId: `cli_${schema}`,
			tenantId: `tenant_${schema}`,
			idType: "open_id",
			externalId: `ou_${schema}`,
		};
		const now = new Date().toISOString();
		const sessionId = createHash("sha256").update(`${schema}:session`).digest("hex");
		const created = await auth.createWebSession(identity, sessionId, now);

		const script = `
			import { AuthenticationService } from "./packages/core/dist/index.js";
			import { PostgresStorage } from "./packages/storage/dist/index.js";
			const storage = PostgresStorage.connect(process.env.TEST_SCHEMA_URL);
			await storage.initialize();
			const session = await new AuthenticationService(storage).authenticateSession(
				process.env.SESSION_ID,
				process.env.NOW,
			);
			console.log(JSON.stringify({
				userId: session?.userId ?? null,
				expiresAt: session?.expiresAt ?? null,
			}));
			await storage.close();
		`;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			["--input-type=module", "-e", script],
			{
				cwd: process.cwd(),
				env: {
					...process.env,
					TEST_SCHEMA_URL: scopedUrl.toString(),
					SESSION_ID: sessionId,
					NOW: now,
				},
				timeout: 15_000,
			},
		);
		const output = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
		assert.ok(output);
		assert.deepEqual(JSON.parse(output), {
			userId: created.userId,
			expiresAt: created.expiresAt,
		});
		const bindings = await storage.transaction((tx) => tx.identityBindings.all());
		assert.equal(
			bindings.filter((binding) => binding.externalId === identity.externalId).length,
			1,
			"restart must not duplicate the identity binding",
		);
	} finally {
		await storage.close();
		await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
		await admin.end();
	}
});

test("PostgreSQL: queued platform action is refused after its binding is revoked", {
	skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
	const { AuthenticationService } = await import("../packages/core/dist/index.js");
	const { compose } = await import("../packages/runtime/dist/index.js");
	const storage = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	t.after(() => storage.close());
	await storage.initialize();
	const suffix = crypto.randomUUID();
	const identity = { platform: "test", applicationId: suffix, tenantId: suffix, idType: "open_id", externalId: suffix };
	const auth = new AuthenticationService(storage);
	const owner = await auth.createWebSession(identity, createHash("sha256").update(suffix).digest("hex"), new Date().toISOString());
	let actionRef = "";
	const eventId = crypto.randomUUID();
	const runtime = compose(storage, [{
		id: suffix,
		inbound: {
			identifyActor: () => identity,
			async parse() {
				return { kind: "choice", command: { sourceId: suffix, eventId, actionRef, actor: {
					kind: "platform", accountId: suffix, externalId: suffix,
				} }, response: { status: 200, headers: {}, body: "{}" } };
			},
		},
		outbound: { async send() { throw new Error("this regression must not send"); } },
	}]);
	const session = await runtime.decisions.startSession({
		requestId: crypto.randomUUID(), ownerId: owner.userId,
		recipient: { accountId: suffix, kind: "user", externalId: suffix }, allowedActorIds: [suffix],
		strategy: { objective: "test", audience: [], channels: {}, sellingPoints: [] },
		limits: { maxBudgetChangeRatio: 0.2, maxBidChangeRatio: 0.2 },
		signal: { id: suffix, title: "synthetic", summary: "test", evidence: [] },
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
	});
	await runtime.decisions.prepareRound(session.id, 0);
	actionRef = await storage.transaction(async (tx) => {
		const round = (await tx.rounds.all()).find((round) => round.sessionId === session.id)!;
		return (await tx.actions.all()).find((action) => action.roundId === round.id)!.id;
	});
	await runtime.channels.handle(suffix, { method: "POST", url: "/webhooks/test", headers: {}, rawBody: Buffer.from("{}") }, runtime.decisions, (identity) => auth.resolveIdentity(identity));
	const binding = await storage.transaction(async (tx) => (await tx.identityBindings.all()).find((binding) => binding.userId === owner.userId)!);
	await auth.revokeIdentity(binding.id, new Date().toISOString());
	const inboxId = JSON.stringify([suffix, eventId]);
	await runtime.decisions.processInbox(inboxId);
	const result = await storage.transaction(async (tx) => ({ inbox: await tx.inbox.get(inboxId), session: await tx.sessions.get(session.id) }));
	assert.equal(result.inbox?.status, "rejected");
	assert.equal(result.inbox?.reason, "forbidden");
	assert.equal(result.session?.version, 0);
});

test("PostgreSQL: notification destination scope and consent are unique per user", {
	skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
	const databaseUrl = process.env.TEST_DATABASE_URL!;
	const storage = PostgresStorage.connect(databaseUrl);
	t.after(() => storage.close());
	await storage.initialize();

	const identity = {
		platform: "feishu",
		applicationId: "cli_test",
		tenantId: "tenant-a",
		idType: "open_id",
		externalId: `ou-${crypto.randomUUID()}`,
	};
	const now = new Date().toISOString();
	const userId = crypto.randomUUID();
	await storage.transaction(async (tx) => {
		await tx.users.put({ id: userId, status: "active", createdAt: now });
		await tx.identityBindings.put({
			id: crypto.randomUUID(),
			...identity,
			userId,
			status: "active",
			verifiedAt: now,
		});
	});
	const notifications = new NotificationService(storage);
	const destination = await notifications.verifyDestination(userId, identity);

	// 同一用户同一作用域只能有一条目的地（唯一索引兜并发）。
	await assert.rejects(
		() =>
			storage.transaction((tx) =>
				tx.notificationDestinations.put({ ...destination, id: crypto.randomUUID() }),
			),
		/duplicate key|unique/i,
	);

	// 同一用户的同一目的地只能有一条授权记录。
	const consent = await notifications.grantConsent(userId, destination.id);
	await assert.rejects(
		() =>
			storage.transaction((tx) =>
				tx.notificationConsents.put({ ...consent, id: `${userId}:${destination.id}x` }),
			),
		/duplicate key|unique/i,
	);

	// 迁移是可重复执行的：再次 initialize 不应报错。
	await storage.initialize();
	const status = await notifications.status(userId);
	assert.equal(status.destination?.id, destination.id);
	assert.equal(status.consent?.status, "active");
	assert.equal(status.canSendProactive, true);
});
