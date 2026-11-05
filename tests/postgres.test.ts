import assert from "node:assert/strict";
import test from "node:test";
import type { ChoiceCommand } from "../packages/core/dist/index.js";
import { PostgresStorage } from "../packages/storage/dist/index.js";
import { fixture } from "./helpers.ts";

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
