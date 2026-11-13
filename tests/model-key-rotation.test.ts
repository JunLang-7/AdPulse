// 主密钥轮换/恢复演练脚本的只读逻辑：密文可读性核对与安全的摘要输出。
// 真实轮换需要 PostgreSQL，覆盖在手工演练里；这里保证不会误报、不会泄露。

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { modelCredentialAad } from "../packages/core/dist/index.js";
import { createModelCredentialCipher } from "../packages/runtime/dist/index.js";
import { formatSummary, inspectRotation, main } from "../scripts/model-key-rotation.mjs";

const key = () => crypto.randomBytes(32).toString("base64");
const cipherOf = (keyring: string, active?: string) => {
	const cipher = createModelCredentialCipher({
		MODEL_CREDENTIAL_KEYRING: keyring,
		...(active ? { MODEL_CREDENTIAL_ACTIVE_KEY: active } : {}),
	});
	assert.ok(cipher);
	return cipher;
};

function fixture(oldKeyring: string) {
	const oldCipher = cipherOf(oldKeyring, "v1");
	const ownerId = "owner";
	const connectionId = "connection";
	const baseUrl = "https://api.example.com/v1";
	const protocol = "openai-completions";
	const encrypted = oldCipher.encrypt({
		plaintext: "synthetic-personal-key",
		aad: modelCredentialAad({ ownerId, connectionId, credentialVersion: 1, baseUrl, protocol }),
	});
	return {
		connections: new Map([[connectionId, { id: connectionId, ownerId, baseUrl, protocol }]]),
		credentials: [{
			id: connectionId,
			ownerId,
			connectionId,
			credentialVersion: 1,
			...encrypted,
			createdAt: "2026-11-12T00:00:00.000Z",
			updatedAt: "2026-11-12T00:00:00.000Z",
		}],
	};
}

test("rotation check: readable with the retained old key and counted as pending rotation", () => {
	const oldKey = `v1:${key()}`;
	const newKey = key();
	const snapshot = fixture(oldKey);
	const result = inspectRotation({
		...snapshot,
		cipher: cipherOf(`${oldKey},v2:${newKey}`, "v2"),
	});
	assert.deepEqual(result, { ok: 1, failed: 0, retired: 1 });
});

test("rotation check: missing old key, foreign connection or tamper all count as failures", () => {
	const oldKey = `v1:${key()}`;
	const snapshot = fixture(oldKey);
	const retiredElsewhere = inspectRotation({
		...snapshot,
		cipher: cipherOf(`v2:${key()}`, "v2"),
	});
	assert.deepEqual(retiredElsewhere, { ok: 0, failed: 1, retired: 1 });

	const orphan = inspectRotation({
		...snapshot,
		connections: new Map(),
		cipher: cipherOf(oldKey, "v1"),
	});
	assert.equal(orphan.failed, 1);

	const tampered = inspectRotation({
		credentials: [{ ...snapshot.credentials[0], authTag: crypto.randomBytes(16).toString("base64") }],
		connections: snapshot.connections,
		cipher: cipherOf(oldKey, "v1"),
	});
	assert.equal(tampered.failed, 1);
});

test("rotation summary carries counts only, never key material or ids", () => {
	const text = formatSummary({ activeKeyId: "v2", ok: 3, failed: 0, retired: 2, rotated: 2 }, "rotate");
	assert.deepEqual(JSON.parse(text), {
		mode: "rotate",
		activeKeyId: "v2",
		readable: 3,
		failed: 0,
		awaitingRotation: 2,
		rotated: 2,
	});
	assert.doesNotMatch(text, /synthetic|owner|connection|nonce|ciphertext|authTag/);
});

test("rotation CLI refuses ambiguous, unconfirmed or unconfigured runs", async () => {
	assert.equal(await main([], {}), 2);
	assert.equal(await main(["--check", "--rotate"], {}), 2);
	assert.equal(await main(["--rotate"], { DATABASE_URL: "postgres://x/y" }), 2);
	assert.equal(
		await main(["--check"], { DATABASE_URL: "postgres://x/y", MODEL_CREDENTIAL_KEYRING: "v1:short" }),
		2,
		"an invalid keyring must fail closed before connecting",
	);
});
