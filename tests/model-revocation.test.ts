// 撤销墓碑与恢复重放（#86 §6.3 / #40）：删除后不能被备份恢复“复活”。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { ModelConnectionService, type ModelCredentialCipher } from "../packages/core/dist/index.js";
import { createModelCredentialCipher } from "../packages/runtime/dist/model-credential-cipher.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { parseRevocations } from "../scripts/model-credential-revocation.mjs";

const env = () => ({
	MODEL_CREDENTIAL_KEYRING: `v1:${randomBytes(32).toString("base64")}`,
	MODEL_CREDENTIAL_ACTIVE_KEY: "v1",
});

function setup() {
	const storage = new MemoryStorage();
	const cipher = createModelCredentialCipher(env()) as ModelCredentialCipher;
	return { storage, cipher, service: new ModelConnectionService(storage, cipher) };
}

const input = (overrides: Record<string, unknown> = {}) => ({
	providerId: "mimo",
	kind: "custom" as const,
	displayName: "MiMo",
	baseUrl: "https://api.mimotest.example/v1",
	protocol: "openai-completions" as const,
	models: [{ id: "mimo-v2-flash" }],
	apiKey: "synthetic-personal-key",
	...overrides,
});

const at = "2026-01-01T00:00:00.000Z";

/** 模拟恢复备份：把删除前的连接、密文与默认选择写回，并清掉墓碑表。 */
async function restorePreDeletionState<T extends { id: string; version: number }>(
	storage: MemoryStorage,
	connection: T,
	ownerId = "owner-a",
) {
	await storage.transaction(async (tx) => {
		await tx.userModelConnections.put({
			...connection, ownerId, status: "active",
			verifiedAt: at, verifiedVersion: connection.version,
		} as never);
		await tx.userModelCredentials.put({
			id: connection.id, ownerId, connectionId: connection.id, credentialVersion: 1,
			keyId: "v1", algorithm: "aes-256-gcm", nonce: "restored-nonce",
			ciphertext: "restored-ciphertext", authTag: "restored-tag",
			createdAt: at, updatedAt: at,
		});
		await tx.userModelPreferences.put({
			id: ownerId, ownerId, connectionId: connection.id,
			modelId: "mimo-v2-flash", version: 2, updatedAt: at,
		});
		await tx.userModelRevocations.delete(connection.id);
	});
}

test("revocation: a tombstone at the current credential version blocks decryption", async () => {
	const { storage, service } = setup();
	const created = await service.create("owner-a", input(), { verified: true });
	// 凭据本身仍然可解，但墓碑说该版本已撤销。
	assert.equal((await service.resolveCredential("owner-a", created.id)).apiKey, "synthetic-personal-key");
	await storage.transaction(async (tx) => {
		await tx.userModelRevocations.put({
			id: created.id, ownerId: "owner-a", connectionId: created.id, credentialVersion: 1,
			reason: "credential_removed", revokedAt: at,
		});
	});
	await assert.rejects(service.resolveCredential("owner-a", created.id), /revoked/u);
	const view = await service.view("owner-a");
	assert.equal(view.connections[0]?.hasCredential, false);
	assert.equal(view.connections[0]?.status, "disabled");
});

test("revocation: a restore that wipes tombstones fails closed until replay is applied", async () => {
	const { storage, service } = setup();
	const created = await service.create("owner-a", input(), { verified: true });
	await service.removeCredential("owner-a", created.id, created.version);
	const [revocation] = await service.listRevocations();
	assert.equal(revocation?.credentialVersion, 1);
	assert.doesNotMatch(JSON.stringify(revocation), /synthetic-personal-key|ciphertext|authTag|nonce/);

	// 恢复备份会把墓碑表一起回滚，因此不能只靠守卫，必须重放。
	await restorePreDeletionState(storage, created);
	assert.equal((await service.listRevocations()).length, 0);
	// 无论是因为墓碑还是旧密文，旧凭据都不能被当成可用；这里不宣称哪种错误。
	await assert.rejects(service.resolveCredential("owner-a", created.id));

	assert.deepEqual(await service.replayRevocations([revocation!], { apply: true }),
		{ skipped: 0, disabled: 1, tombstoned: 0 });
	// 重放后连接已停用（可能先报 disabled，也可能先命中墓碑）。
	await assert.rejects(service.resolveCredential("owner-a", created.id), /disabled|revoked/u);
	const view = await service.view("owner-a");
	assert.equal(view.connections[0]?.hasCredential, false);
	assert.equal(view.connections[0]?.status, "disabled");
});

test("revocation: a replacement key after removal gets a version above the tombstone", async () => {
	const { service } = setup();
	const created = await service.create("owner-a", input(), { verified: true });
	const removed = await service.removeCredential("owner-a", created.id, created.version);
	const replaced = await service.update("owner-a", created.id, {
		expectedVersion: removed.version,
		credential: { action: "replace", apiKey: "synthetic-replacement-key" },
	}, { verified: true });
	assert.equal(replaced.hasCredential, true);
	assert.equal((await service.resolveCredential("owner-a", created.id)).apiKey, "synthetic-replacement-key");
	// 墓碑保留但版本更低：不阻断新密钥。
	assert.equal((await service.listRevocations())[0]?.credentialVersion, 1);
});

test("revocation: connection deletion also leaves a tombstone and clears the default", async () => {
	const { service } = setup();
	const created = await service.create("owner-a", input(), { verified: true });
	await service.setPreference("owner-a", { expectedVersion: 0, connectionId: created.id, modelId: "mimo-v2-flash" });
	await service.delete("owner-a", created.id, created.version);
	const [revocation] = await service.listRevocations();
	assert.equal(revocation?.reason, "connection_deleted");
	assert.deepEqual((await service.view("owner-a")).preference.connectionId, null);
});

test("replay: dry run reports without writing, apply re-deletes what a restore resurrected", async () => {
	const { storage, service } = setup();
	const created = await service.create("owner-a", input(), { verified: true });
	await service.setPreference("owner-a", { expectedVersion: 0, connectionId: created.id, modelId: "mimo-v2-flash" });
	await service.removeCredential("owner-a", created.id, created.version);
	const exported = await service.listRevocations();
	assert.equal(exported.length, 1);

	await restorePreDeletionState(storage, created);
	assert.equal((await service.listRevocations()).length, 0, "恢复后的墓碑表是空的");

	const dryRun = await service.replayRevocations(exported);
	assert.deepEqual(dryRun, { skipped: 0, disabled: 1, tombstoned: 0 });
	assert.equal((await service.listRevocations()).length, 0, "dry run 不写库");
	assert.equal((await service.view("owner-a")).preference.connectionId, created.id);

	const applied = await service.replayRevocations(exported, { apply: true });
	assert.deepEqual(applied, { skipped: 0, disabled: 1, tombstoned: 0 });
	assert.equal((await service.listRevocations())[0]?.reason, "credential_removed");
	const view = await service.view("owner-a");
	assert.equal(view.connections[0]?.status, "disabled");
	assert.equal(view.connections[0]?.hasCredential, false);
	assert.equal(view.preference.connectionId, null, "恢复后必须清空旧默认选择");
	assert.equal((await storage.transaction((tx) => tx.userModelCredentials.all())).length, 0);
});

test("replay: newer credentials are skipped, missing connections are only tombstoned", async () => {
	const { service } = setup();
	const created = await service.create("owner-a", input(), { verified: true });
	const replaced = await service.update("owner-a", created.id, {
		expectedVersion: created.version,
		credential: { action: "replace", apiKey: "synthetic-rotated-key" },
	}, { verified: true });
	assert.equal(replaced.version, created.version + 1);

	// 撤销版本 1，但现有凭据已是版本 2 → 跳过，不误删轮换后的新密钥。
	const stale = [{
		id: created.id, ownerId: "owner-a", connectionId: created.id,
		credentialVersion: 1, reason: "credential_removed" as const, revokedAt: at,
	}];
	assert.deepEqual(await service.replayRevocations(stale, { apply: true }), { skipped: 1, disabled: 0, tombstoned: 0 });
	assert.equal((await service.resolveCredential("owner-a", created.id)).apiKey, "synthetic-rotated-key");

	// 连接已不存在：只补记墓碑，便于后续恢复继续生效。
	const orphan = [{
		...stale[0]!, id: "3f1a3a54-0000-4000-8000-000000000000",
		connectionId: "3f1a3a54-0000-4000-8000-000000000000",
	}];
	assert.deepEqual(await service.replayRevocations(orphan, { apply: true }), { skipped: 0, disabled: 0, tombstoned: 1 });
	assert.equal((await service.listRevocations()).length, 1);
});

test("revocation file parser rejects anything but the minimal fields", () => {
	const valid = parseRevocations([{
		ownerId: "owner-a", connectionId: "c1", credentialVersion: 2,
		reason: "credential_removed", revokedAt: at,
	}]);
	assert.equal(valid[0]?.id, "c1");
	for (const invalid of [
		{},
		[{ ownerId: "owner-a", connectionId: "c1", credentialVersion: 0, reason: "credential_removed", revokedAt: at }],
		[{ ownerId: "owner-a", connectionId: "c1", credentialVersion: 1, reason: "made_up", revokedAt: at }],
		[{ ownerId: "", connectionId: "c1", credentialVersion: 1, reason: "credential_removed", revokedAt: at }],
		[{ ownerId: "owner-a", connectionId: "c1", credentialVersion: 1.5, reason: "credential_removed", revokedAt: at }],
	]) {
		assert.throws(() => parseRevocations(invalid), /invalid|must contain/u);
	}
});
