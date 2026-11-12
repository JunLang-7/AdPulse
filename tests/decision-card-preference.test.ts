import assert from "node:assert/strict";
import test from "node:test";
import {
	SubscriptionError,
	SubscriptionService,
} from "../packages/core/dist/index.js";
import {
	MemoryStorage,
	PostgresStorage,
} from "../packages/storage/dist/index.js";

const START = "2026-11-12T01:00:00.000Z";
const LATER = "2026-11-12T02:00:00.000Z";

test("decision preference: legacy subscription does not imply confirmation or create work", async () => {
	const storage = new MemoryStorage();
	const service = new SubscriptionService(storage, () => START);
	// An existing JSONB record written before the independent preference existed.
	await storage.transaction((tx) =>
		tx.subscriptionSettings.put({
			id: "owner",
			userId: "owner",
			version: 2,
			proactiveEnabled: true,
			schedule: {
				timezone: "Asia/Shanghai",
				digestAt: "09:30",
				quietStart: "22:00",
				quietEnd: "08:00",
			},
			enabledAt: START,
			updatedAt: START,
		}),
	);
	assert.deepEqual((await service.view("owner")).settings.decisionCards, {
		enabled: false,
	});
	await service.updateSettings("owner", {
		expectedVersion: 2,
		proactiveEnabled: true,
	});
	assert.deepEqual((await service.view("owner")).settings.decisionCards, {
		enabled: false,
	});
	const confirmed = await service.updateSettings("owner", {
		expectedVersion: 3,
		decisionCardsEnabled: true,
	});
	assert.deepEqual(confirmed.settings.decisionCards, {
		enabled: true,
		enabledAt: START,
		confirmedVersion: 4,
	});
	await storage.transaction(async (tx) => {
		assert.deepEqual(await tx.jobs.all(), []);
		assert.deepEqual(await tx.sessions.all(), []);
		assert.deepEqual(await tx.deliveries.all(), []);
		assert.deepEqual(await tx.notificationBatches.all(), []);
		assert.deepEqual(await tx.notificationItems.all(), []);
	});
});

test("decision preference: opt-in is independent, versioned and only reopening moves its watermark", async () => {
	const storage = new MemoryStorage();
	let clock = START;
	const service = new SubscriptionService(storage, () => clock);
	assert.deepEqual((await service.view("owner")).settings.decisionCards, {
		enabled: false,
	});
	assert.equal(
		await storage.transaction((tx) => tx.subscriptionSettings.get("owner")),
		null,
	);
	const first = await service.updateSettings("owner", {
		expectedVersion: 0,
		decisionCardsEnabled: true,
	});
	assert.equal(first.settings.proactiveEnabled, false);
	assert.deepEqual(first.settings.decisionCards, {
		enabled: true,
		enabledAt: START,
		confirmedVersion: 1,
	});
	clock = LATER;
	const repeat = await service.updateSettings("owner", {
		expectedVersion: 1,
		decisionCardsEnabled: true,
	});
	assert.deepEqual(repeat.settings.decisionCards, first.settings.decisionCards);
	await assert.rejects(
		service.updateSettings("owner", {
			expectedVersion: 1,
			decisionCardsEnabled: false,
		}),
		(error: unknown) =>
			error instanceof SubscriptionError &&
			error.reason === "subscription_conflict",
	);
	const added = await service.addTarget("owner", {
		expectedVersion: 2,
		kind: "brand",
		label: "合成品牌",
		categories: ["event"],
		scope: "include_general",
	});
	assert.deepEqual(added.settings.decisionCards, first.settings.decisionCards);
	const saved = await service.updateSettings("owner", {
		expectedVersion: 3,
		proactiveEnabled: true,
	});
	assert.deepEqual(saved.settings.decisionCards, first.settings.decisionCards);
	const off = await service.updateSettings("owner", {
		expectedVersion: 4,
		decisionCardsEnabled: false,
	});
	assert.equal(off.settings.proactiveEnabled, true);
	assert.deepEqual(off.settings.decisionCards, {
		enabled: false,
		enabledAt: START,
		confirmedVersion: 1,
		disabledAt: LATER,
	});
	const reopened = await service.updateSettings("owner", {
		expectedVersion: 5,
		decisionCardsEnabled: true,
	});
	assert.deepEqual(reopened.settings.decisionCards, {
		enabled: true,
		enabledAt: LATER,
		confirmedVersion: 6,
		disabledAt: LATER,
	});
	const restarted = new SubscriptionService(storage);
	assert.deepEqual(
		(await restarted.view("owner")).settings.decisionCards,
		reopened.settings.decisionCards,
	);
	assert.deepEqual(
		(await restarted.view("someone-else")).settings.decisionCards,
		{ enabled: false },
	);
	assert.equal((await restarted.view("someone-else")).settings.version, 0);
});

test("decision preference: runtime validation is atomic even when other changes are valid", async () => {
	const storage = new MemoryStorage();
	const service = new SubscriptionService(storage, () => START);
	const valid = await service.updateSettings("owner", {
		expectedVersion: 0,
		decisionCardsEnabled: true,
	});
	// JSON.parse reproduces untyped external input without weakening the service's declared type.
	for (const value of ["true", 1, null, {}]) {
		await assert.rejects(
			service.updateSettings(
				"owner",
				JSON.parse(
					JSON.stringify({
						expectedVersion: 1,
						proactiveEnabled: true,
						decisionCardsEnabled: value,
					}),
				),
			),
			(error: unknown) =>
				error instanceof SubscriptionError && error.reason === "invalid_target",
		);
		assert.deepEqual(await service.view("owner"), valid);
	}
});

test("PostgreSQL: decision preference survives reconnect and concurrent stale confirmation is rejected", {
	skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
	const url = process.env.TEST_DATABASE_URL;
	assert.ok(url);
	const storage = PostgresStorage.connect(url);
	t.after(() => storage.close());
	await storage.initialize();
	const owner = `decision-pref-${crypto.randomUUID()}`;
	let clock = START;
	const first = new SubscriptionService(storage, () => clock);
	const results = await Promise.allSettled([
		first.updateSettings(owner, {
			expectedVersion: 0,
			decisionCardsEnabled: true,
		}),
		first.updateSettings(owner, {
			expectedVersion: 0,
			decisionCardsEnabled: false,
		}),
	]);
	assert.equal(
		results.filter((result) => result.status === "fulfilled").length,
		1,
	);
	const rejected = results.find((result) => result.status === "rejected");
	assert.ok(rejected?.status === "rejected");
	assert.ok(rejected.reason instanceof SubscriptionError);
	assert.equal(rejected.reason.reason, "subscription_conflict");
	const view = await first.view(owner);
	assert.equal(view.settings.version, 1);
	const other = PostgresStorage.connect(url);
	t.after(() => other.close());
	await other.initialize();
	const second = new SubscriptionService(other, () => LATER);
	assert.deepEqual(await second.view(owner), view);
	const disabled = await second.updateSettings(owner, {
		expectedVersion: 1,
		decisionCardsEnabled: false,
	});
	assert.equal(disabled.settings.decisionCards.enabled, false);
	clock = "2026-11-12T03:00:00.000Z";
	const enabled = await first.updateSettings(owner, {
		expectedVersion: 2,
		decisionCardsEnabled: true,
	});
	assert.deepEqual(enabled.settings.decisionCards, {
		enabled: true,
		enabledAt: clock,
		confirmedVersion: 3,
		...(view.settings.decisionCards.enabled ? { disabledAt: LATER } : {}),
	});
	// A downgrade that drops the optional JSON field must fail closed on upgrade.
	await storage.transaction(async (tx) => {
		const legacy = await tx.subscriptionSettings.get(owner);
		assert.ok(legacy);
		const { decisionCards: _preference, ...record } = legacy;
		await tx.subscriptionSettings.put(record);
	});
	assert.deepEqual((await second.view(owner)).settings.decisionCards, {
		enabled: false,
	});
});
