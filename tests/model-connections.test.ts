// 个人模型连接持久化基础（#86 PR1）：加解密、AAD 绑定、版本/归属、删除与失败关闭。
// 这里只验证核心规则；真实 PostgreSQL 行为在 postgres-model-connections.test.ts。

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
	ModelConnectionError,
	ModelConnectionService,
	modelCredentialAad,
	type ModelCredentialCipher,
} from "../packages/core/dist/index.js";
import {
	createModelCredentialCipher,
	parseModelCredentialKeyring,
} from "../packages/runtime/dist/model-credential-cipher.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const key = () => crypto.randomBytes(32).toString("base64");
const keyringOf = (...ids: string[]) => ids.map((id) => `${id}:${key()}`).join(",");
const envOf = (keyring: string, active?: string) => ({
	MODEL_CREDENTIAL_KEYRING: keyring,
	...(active ? { MODEL_CREDENTIAL_ACTIVE_KEY: active } : {}),
});

function cipherOf(keyring = keyringOf("v1"), active?: string): ModelCredentialCipher {
	const cipher = createModelCredentialCipher(envOf(keyring, active));
	assert.ok(cipher);
	return cipher;
}

const connectionInput = (overrides: Record<string, unknown> = {}) => ({
	providerId: "mimo",
	kind: "custom" as const,
	displayName: "MiMo 个人连接",
	baseUrl: "https://api.xiaomimimo.com/v1",
	protocol: "openai-completions" as const,
	models: [{ id: "mimo-v2.6-flash", label: "MiMo Flash" }],
	apiKey: "synthetic-personal-key",
	...overrides,
});

function reason(error: unknown): string {
	assert.ok(error instanceof ModelConnectionError, `expected ModelConnectionError, got ${String(error)}`);
	return error.reason;
}

test("keyring: missing, malformed or half-configured master keys fail closed", () => {
	assert.equal(createModelCredentialCipher({}), undefined);
	assert.equal(createModelCredentialCipher({ MODEL_CREDENTIAL_KEYRING: "" }), undefined);
	assert.equal(createModelCredentialCipher({ MODEL_CREDENTIAL_KEYRING: "v1" }), undefined);
	assert.equal(createModelCredentialCipher({ MODEL_CREDENTIAL_KEYRING: `v1:${crypto.randomBytes(16).toString("base64")}` }), undefined);
	assert.equal(createModelCredentialCipher({ MODEL_CREDENTIAL_KEYRING: keyringOf("v1", "v1") }), undefined);
	assert.equal(createModelCredentialCipher(envOf(keyringOf("v1"), "v9")), undefined);
	const padded = keyringOf("v1");
	assert.ok(parseModelCredentialKeyring(padded.slice(0, -1)));
	for (const invalid of [padded + "!", padded + "=", padded.replace(":", ": ")])
		assert.equal(parseModelCredentialKeyring(invalid), undefined);
	assert.ok(parseModelCredentialKeyring(keyringOf("old", "new")));
	assert.equal(parseModelCredentialKeyring(keyringOf("old", "new"))?.activeKeyId, "new");
	assert.equal(parseModelCredentialKeyring(keyringOf("old", "new"), "old")?.activeKeyId, "old");
});

test("cipher: unique nonces, AAD binding, tamper detection and rotation keyring", () => {
	const v1 = keyringOf("v1");
	const cipher = cipherOf(v1);
	const first = cipher.encrypt({ plaintext: "synthetic-personal-key", aad: "aad-a" });
	const second = cipher.encrypt({ plaintext: "synthetic-personal-key", aad: "aad-a" });
	assert.notEqual(first.nonce, second.nonce);
	assert.equal(cipher.decrypt({ ciphertext: first, aad: "aad-a" }), "synthetic-personal-key");
	assert.equal(cipher.decrypt({ ciphertext: first, aad: "aad-b" }), null, "AAD mismatch must fail");
	assert.equal(cipher.decrypt({ ciphertext: { ...first, keyId: "v2" }, aad: "aad-a" }), null);
	assert.equal(
		cipher.decrypt({ ciphertext: { ...first, ciphertext: second.ciphertext }, aad: "aad-a" }),
		null,
		"tampered ciphertext must fail",
	);
	assert.equal(
		cipher.decrypt({ ciphertext: { ...first, authTag: second.authTag }, aad: "aad-a" }),
		null,
		"tampered tag must fail",
	);

	// 轮换期间旧 key 仍可解密；轮换结束只留新 key 时旧密文必须失效。
	const rotateKey = key();
	const rotating = cipherOf(`${v1},v2:${rotateKey}`, "v2");
	assert.equal(rotating.decrypt({ ciphertext: first, aad: "aad-a" }), "synthetic-personal-key");
	const retired = cipherOf(`v2:${rotateKey}`, "v2");
	assert.equal(retired.decrypt({ ciphertext: first, aad: "aad-a" }), null);
});

test("service: secrets never appear in stored rows or projections", async () => {
	const storage = new MemoryStorage();
	const service = new ModelConnectionService(storage, cipherOf());
	const created = await service.create("owner", connectionInput());
	assert.equal(created.hasCredential, true);
	assert.equal(created.status, "active");
	assert.equal(created.version, 1);
	assert.doesNotMatch(JSON.stringify(created), /synthetic-personal-key/);

	const rows = await storage.transaction(async (tx) => ({
		connection: await tx.userModelConnections.get(created.id),
		credential: await tx.userModelCredentials.get(created.id),
	}));
	assert.doesNotMatch(JSON.stringify(rows), /synthetic-personal-key/);
	const credential = rows.credential;
	assert.ok(credential);
	assert.equal(credential?.algorithm, "aes-256-gcm");
	assert.ok(credential.nonce.length > 0 && credential.authTag.length > 0);

	const resolved = await service.resolveCredential("owner", created.id, "mimo-v2.6-flash");
	assert.equal(resolved.apiKey, "synthetic-personal-key");
	assert.equal(resolved.baseUrl, "https://api.xiaomimimo.com/v1");
	assert.equal(resolved.protocol, "openai-completions");
	assert.equal(resolved.modelId, "mimo-v2.6-flash");
});

test("service: validation rejects unsafe targets and provider ids", async () => {
	const service = new ModelConnectionService(new MemoryStorage(), cipherOf());
	const cases: Array<Record<string, unknown>> = [
		{ providerId: "__proto__" },
		{ providerId: "MiMo" },
		{ providerId: "a".repeat(49) },
		{ baseUrl: "http://api.example.com/v1" },
		{ baseUrl: "https://user:pass@api.example.com/v1" },
		{ baseUrl: "https://api.example.com/v1?key=1" },
		{ baseUrl: "https://api.example.com/v1#frag" },
		{ protocol: "openai-compatible" },
		{ models: [] },
		{ models: [{ id: "a" }, { id: "a" }] },
		{ apiKey: "short" },
		{ kind: "catalog" },
		{ kind: "custom", catalogId: "deepseek" },
	];
	for (const overrides of cases) {
		const input = connectionInput(overrides);
		await assert.rejects(
			() => service.create("owner", input as never),
			(error) => reason(error) === "invalid_connection",
			JSON.stringify(overrides),
		);
	}
	assert.deepEqual((await service.view("owner")).connections, []);
});

test("service: provider ids are unique per owner, not across owners", async () => {
	const service = new ModelConnectionService(new MemoryStorage(), cipherOf());
	await service.create("owner-a", connectionInput());
	await assert.rejects(
		() => service.create("owner-a", connectionInput({ displayName: "重复" })),
		(error) => reason(error) === "connection_conflict",
	);
	const other = await service.create("owner-b", connectionInput());
	// 他人连接按不存在处理，不泄露存在性。
	for (const attempt of [
		() => service.view("owner-a").then((view) => view.connections.find((item) => item.id === other.id)),
		() => service.update("owner-a", other.id, { expectedVersion: 1, displayName: "偷换" }),
		() => service.delete("owner-a", other.id, 1),
		() => service.resolveCredential("owner-a", other.id),
	]) {
		if (attempt.toString().includes("view")) continue;
		await assert.rejects(attempt as () => Promise<unknown>, (error) => reason(error) === "connection_not_found");
	}
	assert.deepEqual((await service.view("owner-a")).connections.map((item) => item.providerId), ["mimo"]);
});

test("service: version conflicts and target changes require a new key", async () => {
	const service = new ModelConnectionService(new MemoryStorage(), cipherOf());
	const created = await service.create("owner", connectionInput());
	await assert.rejects(
		() => service.update("owner", created.id, { expectedVersion: 99, displayName: "x" }),
		(error) => reason(error) === "connection_conflict",
	);

	const renamed = await service.update("owner", created.id, { expectedVersion: 1, displayName: "改名" });
	assert.equal(renamed.version, 2);
	assert.equal(renamed.displayName, "改名");

	// 换目标地址必须同时给新密钥，不能拿旧密钥探测未确认的主机。
	await assert.rejects(
		() => service.update("owner", created.id, {
			expectedVersion: 2,
			baseUrl: "https://other.example/v1",
		}),
		(error) => reason(error) === "invalid_connection",
	);
	const moved = await service.update("owner", created.id, {
		expectedVersion: 2,
		baseUrl: "https://other.example/v1",
		credential: { action: "replace", apiKey: "synthetic-other-key" },
	});
	assert.equal(moved.baseUrl, "https://other.example/v1");
	assert.equal(moved.version, 3);
	const resolved = await service.resolveCredential("owner", created.id);
	assert.equal(resolved.apiKey, "synthetic-other-key");
	assert.equal(resolved.baseUrl, "https://other.example/v1");
});

test("service: credential removal disables the connection and clears the default", async () => {
	const storage = new MemoryStorage();
	const service = new ModelConnectionService(storage, cipherOf());
	const created = await service.create("owner", connectionInput());
	await service.setPreference("owner", { expectedVersion: 0, connectionId: created.id, modelId: "mimo-v2.6-flash" });

	const disabled = await service.removeCredential("owner", created.id, created.version);
	assert.equal(disabled.status, "disabled");
	assert.equal(disabled.hasCredential, false);
	assert.deepEqual((await service.view("owner")).preference, {
		connectionId: null,
		modelId: null,
		version: 2,
	});
	assert.equal(await storage.transaction((tx) => tx.userModelCredentials.get(created.id)), null);
	await assert.rejects(
		() => service.resolveCredential("owner", created.id),
		(error) => reason(error) === "credential_missing",
	);
	await assert.rejects(
		() => service.update("owner", created.id, { expectedVersion: disabled.version, status: "active" }),
		(error) => reason(error) === "invalid_connection",
	);

	const restored = await service.update("owner", created.id, {
		expectedVersion: disabled.version,
		credential: { action: "replace", apiKey: "synthetic-restored-key" },
	});
	assert.equal(restored.status, "active");
	assert.equal((await service.resolveCredential("owner", created.id)).apiKey, "synthetic-restored-key");
});

test("service: preferences only point at owned, active, credentialed connections", async () => {
	const service = new ModelConnectionService(new MemoryStorage(), cipherOf());
	const created = await service.create("owner", connectionInput());
	await assert.rejects(
		() => service.setPreference("owner", { expectedVersion: 0, connectionId: created.id, modelId: "unknown" }),
		(error) => reason(error) === "invalid_connection",
	);
	await assert.rejects(
		() => service.setPreference("other", { expectedVersion: 0, connectionId: created.id, modelId: "mimo-v2.6-flash" }),
		(error) => reason(error) === "connection_not_found",
	);
	const set = await service.setPreference("owner", {
		expectedVersion: 0,
		connectionId: created.id,
		modelId: "mimo-v2.6-flash",
	});
	assert.deepEqual(set, { connectionId: created.id, modelId: "mimo-v2.6-flash", version: 1 });
	await assert.rejects(
		() => service.setPreference("owner", { expectedVersion: 0, connectionId: null }),
		(error) => reason(error) === "connection_conflict",
	);
	const cleared = await service.setPreference("owner", { expectedVersion: 1, connectionId: null });
	assert.deepEqual(cleared, { connectionId: null, modelId: null, version: 2 });

	await service.removeCredential("owner", created.id, created.version);
	await assert.rejects(
		() => service.setPreference("owner", { expectedVersion: 2, connectionId: created.id, modelId: "mimo-v2.6-flash" }),
		(error) => reason(error) === "credential_missing",
	);
});

test("service: changing the model or disabling its connection clears the former default", async () => {
	const service = new ModelConnectionService(new MemoryStorage(), cipherOf());
	const created = await service.create("owner", connectionInput());
	await service.setPreference("owner", {
		expectedVersion: 0, connectionId: created.id, modelId: "mimo-v2.6-flash",
	});
	const edited = await service.update("owner", created.id, { expectedVersion: 1, models: [{ id: "replacement" }] });
	assert.deepEqual((await service.view("owner")).preference, { connectionId: null, modelId: null, version: 2 });
	await service.setPreference("owner", { expectedVersion: 2, connectionId: created.id, modelId: "replacement" });
	await service.update("owner", created.id, { expectedVersion: edited.version, status: "disabled" });
	assert.deepEqual((await service.view("owner")).preference, { connectionId: null, modelId: null, version: 4 });
});

test("service: deleting a connection removes metadata, credential and default together", async () => {
	const storage = new MemoryStorage();
	const service = new ModelConnectionService(storage, cipherOf());
	const created = await service.create("owner", connectionInput());
	await service.setPreference("owner", { expectedVersion: 0, connectionId: created.id, modelId: "mimo-v2.6-flash" });
	const remaining = await service.delete("owner", created.id, created.version);
	assert.deepEqual(remaining.connections, []);
	assert.deepEqual(remaining.preference, { connectionId: null, modelId: null, version: 2 });
	const rows = await storage.transaction(async (tx) => [
		await tx.userModelConnections.get(created.id),
		await tx.userModelCredentials.get(created.id),
	]);
	assert.deepEqual(rows, [null, null]);
});

test("service: AAD stops a credential from being transplanted to another connection", async () => {
	const storage = new MemoryStorage();
	const service = new ModelConnectionService(storage, cipherOf());
	const first = await service.create("owner", connectionInput());
	const second = await service.create("owner", connectionInput({ providerId: "deepseek", baseUrl: "https://api.deepseek.com" }));
	const stolen = await storage.transaction(async (tx) => {
		const credential = await tx.userModelCredentials.get(first.id);
		assert.ok(credential);
		// 手工把 A 的密文搬到 B（同样归属、同样版本策略），AAD 必须让它失效。
		await tx.userModelCredentials.put({ ...credential, id: second.id, connectionId: second.id });
		return credential;
	});
	assert.ok(stolen);
	await assert.rejects(
		() => service.resolveCredential("owner", second.id),
		(error) => reason(error) === "credential_unreadable",
	);
	// 未受影响的连接仍可用，也不会因为别处解密失败而回退。
	assert.equal((await service.resolveCredential("owner", first.id)).apiKey, "synthetic-personal-key");
});

test("service: verification binds to the current version and is invalidated by edits", async () => {
	const service = new ModelConnectionService(new MemoryStorage(), cipherOf());
	const created = await service.create("owner", connectionInput());
	const verified = await service.recordVerification("owner", created.id, created.version, "2026-11-12T00:00:00.000Z");
	assert.equal(verified.verifiedVersion, 1);
	const updated = await service.update("owner", created.id, { expectedVersion: 1, displayName: "改名" });
	assert.equal(updated.verifiedAt, undefined);
	assert.equal(updated.verifiedVersion, undefined);
});

test("service: master key rotation re-encrypts only retired records", async () => {
	const storage = new MemoryStorage();
	const v1 = keyringOf("v1");
	const first = new ModelConnectionService(storage, cipherOf(v1, "v1"));
	const connectionA = await first.create("owner", connectionInput());
	const connectionB = await first.create("owner", connectionInput({ providerId: "deepseek", baseUrl: "https://api.deepseek.com" }));

	// 追加新 key 并把 active 切到 v2；旧 key 仍保留用于解密。
	const v2 = key();
	const rotating = new ModelConnectionService(storage, cipherOf(`${v1},v2:${v2}`, "v2"));
	const result = await rotating.rotateCredentials();
	assert.deepEqual(result, { rotated: 2, failed: 0 });
	for (const id of [connectionA.id, connectionB.id]) {
		const credential = await storage.transaction((tx) => tx.userModelCredentials.get(id));
		assert.equal(credential?.keyId, "v2");
	}
	assert.equal((await rotating.resolveCredential("owner", connectionA.id)).apiKey, "synthetic-personal-key");

	// 只保留新 key 后，旧密文已不存在，轮换不再有遗留。
	const onlyV2 = new ModelConnectionService(storage, cipherOf(`v2:${v2}`, "v2"));
	assert.deepEqual(await onlyV2.rotateCredentials(), { rotated: 0, failed: 0 });

	// 只留旧 key 的部署必须失败关闭：不能读到新密文。
	const stale = new ModelConnectionService(storage, cipherOf(v1, "v1"));
	await assert.rejects(
		() => stale.resolveCredential("owner", connectionA.id),
		(error) => reason(error) === "credential_unreadable",
	);
});

test("AAD includes owner, connection, version, base url and protocol", () => {
	const base = {
		ownerId: "owner",
		connectionId: "connection",
		credentialVersion: 1,
		baseUrl: "https://api.example.com/v1",
		protocol: "openai-completions" as const,
	};
	const canonical = modelCredentialAad(base);
	const variants = [
		{ ...base, ownerId: "other" },
		{ ...base, connectionId: "other" },
		{ ...base, credentialVersion: 2 },
		{ ...base, baseUrl: "https://api.example.com/v2" },
		{ ...base, protocol: "anthropic-messages" as const },
	];
	assert.equal(new Set([canonical, ...variants.map(modelCredentialAad)]).size, variants.length + 1);
	// 长度前缀让拼接无歧义：不同字段切分不会生成同一个 AAD。
	assert.notEqual(
		modelCredentialAad({ ...base, ownerId: "a", connectionId: "bc" }),
		modelCredentialAad({ ...base, ownerId: "ab", connectionId: "c" }),
	);
});
