// 个人模型连接的 PostgreSQL 证据（#86 PR1）：迁移、唯一约束、并发版本冲突、
// 密文落库与重连一致。必须指向专用、可丢弃的测试库；未配置时 SKIP，不冒充通过。

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { ModelConnectionError, ModelConnectionService } from "../packages/core/dist/index.js";
import { createModelCredentialCipher } from "../packages/runtime/dist/model-credential-cipher.js";
import { PostgresStorage } from "../packages/storage/dist/index.js";
import { eventSelectionFixture } from "./selection-helpers.ts";

const skip = !process.env.TEST_DATABASE_URL;

function service(storage: PostgresStorage): ModelConnectionService {
	const cipher = createModelCredentialCipher({
		MODEL_CREDENTIAL_KEYRING: `test:${crypto.randomBytes(32).toString("base64")}`,
	});
	assert.ok(cipher, "test keyring must be valid");
	return new ModelConnectionService(storage, cipher);
}

const inputFor = (owner: string, providerId = "mimo") => ({
	providerId,
	kind: "custom" as const,
	displayName: `${owner} 的 MiMo`,
	baseUrl: "https://api.xiaomimimo.com/v1",
	protocol: "openai-completions" as const,
	models: [{ id: "mimo-v2.6-flash" }],
	apiKey: `synthetic-key-${owner}`,
});

async function cleanup(storage: PostgresStorage, ownerId: string): Promise<void> {
	await storage.transaction(async (tx) => {
		for (const connection of (await tx.userModelConnections.all()).filter((item) => item.ownerId === ownerId))
			await tx.userModelConnections.delete(connection.id);
		for (const credential of (await tx.userModelCredentials.all()).filter((item) => item.ownerId === ownerId))
			await tx.userModelCredentials.delete(credential.id);
		for (const revocation of (await tx.userModelRevocations.all()).filter((item) => item.ownerId === ownerId))
			await tx.userModelRevocations.delete(revocation.id);
		await tx.userModelPreferences.delete(ownerId);
	});
}

test("PostgreSQL: revocations persist, replay after restore, and survive reconnect", { skip }, async (t) => {
	const ownerId = `owner-${crypto.randomUUID()}`;
	const first = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	t.after(async () => {
		await cleanup(first, ownerId);
		await first.close();
	});
	await first.initialize();
	const created = await service(first).create(ownerId, inputFor(ownerId), { verified: true });
	await service(first).setPreference(ownerId, { expectedVersion: 0, connectionId: created.id, modelId: "mimo-v2.6-flash" });
	await service(first).removeCredential(ownerId, created.id, created.version);
	const exported = await service(first).listRevocations();
	assert.equal(exported.length, 1);
	assert.doesNotMatch(JSON.stringify(exported), /synthetic-key|ciphertext|authTag|nonce/);

	// 模拟“恢复到删除前”：清掉墓碑并把旧连接、旧密文、旧默认写回。
	const cipher = createModelCredentialCipher({
		MODEL_CREDENTIAL_KEYRING: `test:${crypto.randomBytes(32).toString("base64")}`,
	});
	assert.ok(cipher);
	await first.transaction(async (tx) => {
		await tx.userModelRevocations.delete(created.id);
		await tx.userModelConnections.put({
			id: created.id, ownerId, providerId: created.providerId, kind: "custom", displayName: created.displayName,
			baseUrl: created.baseUrl, protocol: created.protocol, models: created.models, status: "active",
			version: created.version, verifiedAt: new Date().toISOString(), verifiedVersion: created.version,
			createdAt: created.createdAt, updatedAt: created.updatedAt,
		});
		await tx.userModelCredentials.put({
			id: created.id, ownerId, connectionId: created.id, credentialVersion: 1, keyId: "test",
			algorithm: "aes-256-gcm", nonce: "restored", ciphertext: "restored", authTag: "restored",
			createdAt: created.createdAt, updatedAt: created.updatedAt,
		});
		await tx.userModelPreferences.put({
			id: ownerId, ownerId, connectionId: created.id, modelId: "mimo-v2.6-flash",
			version: 3, updatedAt: created.updatedAt,
		});
	});

	// 新连接（模拟重启后的实例）看到的是同一个墓碑表，重放结果一致。
	const second = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	t.after(() => second.close());
	await second.initialize();
	const replay = await service(second).replayRevocations(exported, { apply: true });
	assert.deepEqual(replay, { skipped: 0, disabled: 1, tombstoned: 0 });
	await assert.rejects(service(second).resolveCredential(ownerId, created.id), /disabled|revoked/u);
	const view = await service(second).view(ownerId);
	assert.equal(view.preference.connectionId, null);
	assert.equal(view.connections[0]?.status, "disabled");
});

test("PostgreSQL: migrations 13 and 14 preserve market events and notification selections from version 12", { skip }, async () => {
	const { Pool } = createRequire(new URL("../packages/storage/package.json", import.meta.url))("pg") as {
		Pool: new (options: { connectionString: string }) => ConstructorParameters<typeof PostgresStorage>[0];
	};
	const databaseUrl = process.env.TEST_DATABASE_URL!;
	const schema = `model_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
	const admin = new Pool({ connectionString: databaseUrl });
	const scopedUrl = new URL(databaseUrl);
	scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
	const pool = new Pool({ connectionString: scopedUrl.href });
	const storage = new PostgresStorage(pool);
	try {
		await admin.query(`CREATE SCHEMA ${schema}`);
		await storage.initialize();
		// Reconstruct the main branch's version 12 in this disposable schema.
		await pool.query("DROP TABLE adpulse_userModelConnections, adpulse_userModelCredentials, adpulse_userModelPreferences, adpulse_userModelRevocations");
		// #40 S2 的删除清单也要回到 v12 基线，否则重跑迁移链时状态不真实。
		await pool.query("DROP TABLE IF EXISTS adpulse_lifecycleDeletions, adpulse_auditEvents, adpulse_validationChecks, adpulse_hypotheses, adpulse_hypothesisVersions, adpulse_hypothesisVerdicts, adpulse_hypothesisOperations");
		await pool.query("DELETE FROM adpulse_schema_migrations WHERE version IN (13, 14, 15, 16, 17, 18)");
		const fixture = await eventSelectionFixture(storage);
		await fixture.create();
		const mainRows = () => storage.transaction(async (tx) => ({
			events: await tx.marketEvents.all(),
			selections: await tx.notificationSelections.all(),
		}));
		const before = await mainRows();
		assert.equal(before.events.length, 1);
		assert.equal(before.selections.length, 1);

		await storage.initialize();
		await storage.initialize();
		assert.deepEqual(await mainRows(), before);
		const migrations = await pool.query("SELECT version FROM adpulse_schema_migrations WHERE version >= 11 ORDER BY version");
		assert.deepEqual(migrations.rows.map((row) => row.version), [11, 12, 13, 14, 15, 16, 17, 18]);
		const created = await service(storage).create(fixture.owner, inputFor(fixture.owner));
		const credential = await storage.transaction((tx) => tx.userModelCredentials.get(created.id));
		assert.ok(credential?.ciphertext);
	} finally {
		await storage.close();
		await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
		await admin.end();
	}
});

test("PostgreSQL: concurrent duplicate provider ids create exactly one connection", { skip }, async (t) => {
	const ownerId = `owner-${crypto.randomUUID()}`;
	const first = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	const second = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	t.after(async () => {
		await cleanup(first, ownerId);
		await first.close();
		await second.close();
	});
	await first.initialize();
	await second.initialize();

	const results = await Promise.allSettled([
		service(first).create(ownerId, inputFor(ownerId)),
		service(second).create(ownerId, inputFor(ownerId)),
	]);
	const fulfilled = results.filter((item) => item.status === "fulfilled");
	const rejected = results.filter((item) => item.status === "rejected");
	assert.equal(fulfilled.length, 1);
	assert.equal(rejected.length, 1);
	const failure = (rejected[0] as PromiseRejectedResult).reason;
	assert.ok(failure instanceof ModelConnectionError, "conflict must surface as a domain error");
	assert.equal(failure.reason, "connection_conflict");

	const view = await service(first).view(ownerId);
	assert.equal(view.connections.length, 1);
});

test("PostgreSQL: stored rows hold ciphertext only and survive a reconnect", { skip }, async (t) => {
	const ownerId = `owner-${crypto.randomUUID()}`;
	const storage = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	t.after(async () => {
		await cleanup(storage, ownerId);
		await storage.close();
	});
	await storage.initialize();
	// 同一部署的主密钥是稳定配置；重启只换进程，不换 key。
	const cipher = createModelCredentialCipher({
		MODEL_CREDENTIAL_KEYRING: `test:${crypto.randomBytes(32).toString("base64")}`,
	});
	assert.ok(cipher);
	const created = await new ModelConnectionService(storage, cipher).create(ownerId, inputFor(ownerId));

	const raw = await storage.transaction(async (tx) => [
		await tx.userModelConnections.get(created.id),
		await tx.userModelCredentials.get(created.id),
	]);
	const serialized = JSON.stringify(raw);
	assert.doesNotMatch(serialized, new RegExp(inputFor(ownerId).apiKey));
	assert.match(serialized, /"ciphertext"/);
	assert.match(serialized, /"authTag"/);

	// 新的存储实例（模拟 API 重启）配合同一主密钥仍可解密使用。
	const reopened = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	t.after(() => reopened.close());
	await reopened.initialize();
	const resolved = await new ModelConnectionService(reopened, cipher)
		.resolveCredential(ownerId, created.id, "mimo-v2.6-flash");
	assert.equal(resolved.apiKey, inputFor(ownerId).apiKey);
	assert.equal(resolved.baseUrl, "https://api.xiaomimimo.com/v1");
});

test("PostgreSQL: concurrent updates keep the version monotonic", { skip }, async (t) => {
	const ownerId = `owner-${crypto.randomUUID()}`;
	const first = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	const second = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	t.after(async () => {
		await cleanup(first, ownerId);
		await first.close();
		await second.close();
	});
	await first.initialize();
	await second.initialize();
	const created = await service(first).create(ownerId, inputFor(ownerId));

	const results = await Promise.allSettled([
		service(first).update(ownerId, created.id, { expectedVersion: 1, displayName: "A" }),
		service(second).update(ownerId, created.id, { expectedVersion: 1, displayName: "B" }),
	]);
	assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
	const failure = (results.find((item) => item.status === "rejected") as PromiseRejectedResult).reason;
	assert.ok(failure instanceof ModelConnectionError);
	assert.equal(failure.reason, "connection_conflict");
	const view = await service(first).view(ownerId);
	assert.equal(view.connections[0]?.version, 2);
});

test("PostgreSQL: deleting a connection clears rows and the default selection", { skip }, async (t) => {
	const ownerId = `owner-${crypto.randomUUID()}`;
	const storage = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	t.after(async () => {
		await cleanup(storage, ownerId);
		await storage.close();
	});
	await storage.initialize();
	const connections = service(storage);
	const created = await connections.create(ownerId, inputFor(ownerId));
	await connections.setPreference(ownerId, { expectedVersion: 0, connectionId: created.id, modelId: "mimo-v2.6-flash" });

	const remaining = await connections.delete(ownerId, created.id, created.version);
	assert.deepEqual(remaining.connections, []);
	assert.deepEqual(remaining.preference, { connectionId: null, modelId: null, version: 2 });
	const rows = await storage.transaction(async (tx) => ({
		connection: await tx.userModelConnections.get(created.id),
		credential: await tx.userModelCredentials.get(created.id),
		preference: await tx.userModelPreferences.get(ownerId),
	}));
	assert.equal(rows.connection, null);
	assert.equal(rows.credential, null);
	assert.equal(rows.preference?.connectionId, null);
});
