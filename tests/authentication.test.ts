import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AuthenticationService } from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const identity = {
	platform: "feishu",
	applicationId: "cli_test_app",
	tenantId: "tenant-a",
	idType: "open_id",
	externalId: "ou-user-a",
};
const now = "2026-03-01T10:00:00.000Z";
const codeVerifier = "v".repeat(43);

test("OAuth login transaction is browser-bound, one-time, and clears PKCE verifier", async () => {
	const storage = new MemoryStorage();
	const auth = new AuthenticationService(storage);
	await assert.rejects(
		auth.beginLogin({
			id: hash("oversized-state"),
			browserBindingHash: hash("oversized-nonce"),
			codeVerifier,
			returnTo: `/${"a".repeat(2048)}`,
			createdAt: now,
			expiresAt: "2026-03-01T10:10:00.000Z",
		}),
		/invalid login transaction/,
	);
	await auth.beginLogin({
		id: hash("state"),
		browserBindingHash: hash("nonce"),
		codeVerifier,
		returnTo: "/tasks?tab=active",
		createdAt: now,
		expiresAt: "2026-03-01T10:10:00.000Z",
	});
	assert.equal(await auth.consumeLogin(hash("state"), hash("other"), now), null);
	const afterWrongBrowser = await storage.transaction((tx) => tx.loginTransactions.all());
	assert.equal(afterWrongBrowser[0]?.status, "pending");
	const consumed = await auth.consumeLogin(hash("state"), hash("nonce"), now);
	assert.equal(consumed?.codeVerifier, codeVerifier);
	assert.equal(consumed?.returnTo, "/tasks?tab=active");
	assert.equal(await auth.consumeLogin(hash("state"), hash("nonce"), now), null);
	const records = await storage.transaction((tx) => tx.loginTransactions.all());
	assert.equal(records[0]?.status, "consumed");
	assert.equal(records[0]?.codeVerifier, "");
});

test("expired OAuth transactions are invalidated and their verifier is erased", async () => {
	const storage = new MemoryStorage();
	const auth = new AuthenticationService(storage);
	await auth.beginLogin({
		id: hash("expired-state"),
		browserBindingHash: hash("expired-nonce"),
		codeVerifier,
		returnTo: "/",
		createdAt: now,
		expiresAt: "2026-03-01T10:10:00.000Z",
	});
	assert.equal(
		await auth.consumeLogin(
			hash("expired-state"),
			hash("expired-nonce"),
			"2026-03-01T10:10:00.000Z",
		),
		null,
	);
	const records = await storage.transaction((tx) => tx.loginTransactions.all());
	assert.equal(records[0]?.status, "expired");
	assert.equal(records[0]?.codeVerifier, "");
});

test("personal users are stable only within the full scoped external identity", async () => {
	const storage = new MemoryStorage();
	const auth = new AuthenticationService(storage);
	const first = await auth.createWebSession(identity, hash("session-one"), now);
	const sameIdentity = await auth.createWebSession(
		identity,
		hash("session-two"),
		"2026-03-01T11:00:00.000Z",
	);
	assert.equal(first.userId, sameIdentity.userId);
	assert.equal(first.expiresAt, "2026-03-01T18:00:00.000Z");
	assert.equal(sameIdentity.expiresAt, "2026-03-01T19:00:00.000Z");

	const otherApplication = await auth.createWebSession(
		{ ...identity, applicationId: "cli_other_app" },
		hash("session-three"),
		now,
	);
	const otherTenant = await auth.createWebSession(
		{ ...identity, tenantId: "tenant-b" },
		hash("session-four"),
		now,
	);
	const otherIdType = await auth.createWebSession(
		{ ...identity, idType: "user_id" },
		hash("session-five"),
		now,
	);
	assert.notEqual(first.userId, otherApplication.userId);
	assert.notEqual(first.userId, otherTenant.userId);
	assert.notEqual(first.userId, otherIdType.userId);

	const bindings = await storage.transaction((tx) => tx.identityBindings.all());
	assert.equal(bindings.length, 4);
	assert.equal(
		(await auth.authenticateSession(hash("session-one"), "2026-03-01T17:59:59.000Z"))
			?.expiresAt,
		first.expiresAt,
		"authentication does not slide the absolute expiry",
	);
	assert.equal(
		await auth.authenticateSession(hash("session-one"), first.expiresAt),
		null,
	);
});

test("revoking an identity invalidates every associated web session", async () => {
	const storage = new MemoryStorage();
	const auth = new AuthenticationService(storage);
	await auth.createWebSession(identity, hash("session-a"), now);
	await auth.createWebSession(identity, hash("session-b"), now);
	const bindings = await storage.transaction((tx) => tx.identityBindings.all());
	assert.equal(bindings.length, 1);
	await auth.revokeIdentity(bindings[0]!.id, "2026-03-01T11:00:00.000Z");
	assert.equal(await auth.authenticateSession(hash("session-a"), now), null);
	assert.equal(await auth.authenticateSession(hash("session-b"), now), null);
	const afterRevocation = await storage.transaction((tx) => tx.identityBindings.all());
	assert.equal(afterRevocation[0]?.status, "revoked");
});
