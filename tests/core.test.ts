import assert from "node:assert/strict";
import test from "node:test";
import { Orchestrator, Worker } from "../packages/core/dist/index.js";
import type {
	ActionRef,
	ChoiceCommand,
	Entities,
	OutboundChannel,
	Storage,
	StrategySnapshot,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

import { fixture, proposal } from "./helpers.ts";
import type { Fixture } from "./helpers.ts";

async function rows<K extends keyof Entities>(
	f: Fixture,
	name: K,
): Promise<Entities[K][]> {
	return f.storage.transaction((tx) => tx[name].all());
}
async function open(f: Fixture) {
	const session = await f.start();
	await f.worker.runOnce(); // propose -> round + actions + delivery + job
	await f.worker.runOnce(); // deliver
	const actions = await rows(f, "actions");
	return { session, actions };
}
const choice = (
	action: ActionRef,
	overrides: Partial<ChoiceCommand> = {},
): ChoiceCommand => ({
	sourceId: "account-a",
	eventId: crypto.randomUUID(),
	actionRef: action.id,
	actor: {
		kind: "platform",
		accountId: "account-a",
		externalId: "user-a",
		userId: "owner",
	},
	...overrides,
});

test("first round is persisted; terminal choice applies patch and creates confirmation atomically", async () => {
	const f = fixture();
	const { session, actions } = await open(f);
	assert.equal((await rows(f, "sessions"))[0].roundNo, 1);
	const inbox = await f.decisions.receiveChoice(
		choice(actions.find((a) => a.optionId === "adjust")!),
	);
	await f.decisions.processInbox(inbox.id);
	const saved = (await rows(f, "sessions"))[0];
	assert.equal(saved.id, session.id);
	assert.equal(saved.status, "completed");
	assert.equal(saved.strategy.channels.ads.bidCpc, 1.8);
	assert.equal((await rows(f, "snapshots")).length, 2);
	assert.equal((await rows(f, "rounds"))[0].status, "answered");
	assert.equal((await rows(f, "deliveries")).length, 2);
});

test("duplicate events and concurrent different choices advance a round only once", async () => {
	const f = fixture();
	const { actions } = await open(f);
	const command = choice(actions.find((a) => a.optionId === "observe")!);
	const same = await Promise.all(
		Array.from({ length: 20 }, () => f.decisions.receiveChoice(command)),
	);
	assert.equal(new Set(same.map((x) => x.id)).size, 1);
	const other = await f.decisions.receiveChoice(
		choice(actions.find((a) => a.optionId === "adjust")!),
	);
	await Promise.all([
		f.decisions.processInbox(same[0].id),
		f.decisions.processInbox(other.id),
	]);
	assert.equal((await rows(f, "sessions"))[0].version, 1);
	assert.deepEqual((await rows(f, "inbox")).map((x) => x.status).sort(), [
		"processed",
		"rejected",
	]);
	await f.decisions.prepareRound((await rows(f, "sessions"))[0].id, 1);
	await f.decisions.prepareRound((await rows(f, "sessions"))[0].id, 1);
	assert.deepEqual(
		(await rows(f, "rounds")).map((x) => x.roundNo),
		[1, 2],
	);
});

test("expired, wrong-account, unauthorized, unknown and cancelled actions are rejected", async () => {
	const f = fixture();
	const { session, actions } = await open(f);
	const action = actions[0];
	for (const overrides of [
		{
			actor: {
				kind: "platform",
				accountId: "other",
				externalId: "user-a",
				userId: "owner",
			},
		},
		{
			actor: {
				kind: "platform",
				accountId: "account-a",
				externalId: "stranger",
				userId: "owner",
			},
		},
		{
			actor: {
				kind: "platform",
				accountId: "account-a",
				externalId: "user-a",
			},
		},
		{
			actor: {
				kind: "platform",
				accountId: "account-a",
				externalId: "user-a",
				userId: "stranger",
			},
		},
		{ actor: { kind: "console", userId: "stranger" } },
		{ actionRef: "nonexistent" },
	] as Partial<ChoiceCommand>[]) {
		const inbox = await f.decisions.receiveChoice(choice(action, overrides));
		await f.decisions.processInbox(inbox.id);
	}
	await f.storage.transaction(async (tx) => {
		const s = await tx.sessions.get(session.id);
		assert.ok(s);
		await tx.sessions.put({ ...s, status: "cancelled" });
	});
	const cancelled = await f.decisions.receiveChoice(choice(action));
	await f.decisions.processInbox(cancelled.id);
	await f.storage.transaction(async (tx) => {
		const s = await tx.sessions.get(session.id);
		assert.ok(s);
		await tx.sessions.put({ ...s, status: "awaiting_input" });
	});
	f.advance(); // not yet expired
	for (let i = 0; i < 150; i++) f.advance();
	const expired = await f.decisions.receiveChoice(choice(action));
	await f.decisions.processInbox(expired.id);
	assert.equal((await rows(f, "sessions"))[0].version, 0);
	assert.ok((await rows(f, "inbox")).every((x) => x.status === "rejected"));
	assert.equal(
		(await rows(f, "inbox")).find((x) => x.id === expired.id)!.reason,
		"expired",
	);
});

test("failure mid-transaction rolls back event consumption and patch; retry succeeds", async () => {
	const base = new MemoryStorage();
	let fail = false;
	const storage: Storage = {
		claimJob: (now, leaseMs) => base.claimJob(now, leaseMs),
		runExclusive: (key, work) => base.runExclusive(key, work),
		transaction: (work) =>
			base.transaction((tx) =>
				work({
					...tx,
					snapshots: {
						...tx.snapshots,
						async put(snapshot: StrategySnapshot) {
							if (fail && snapshot.version === 1)
								throw new Error("database failure");
							await tx.snapshots.put(snapshot);
						},
					},
				}),
			),
	};
	const f = fixture(storage);
	const { actions } = await open(f);
	const inbox = await f.decisions.receiveChoice(choice(actions[0]));
	fail = true;
	await assert.rejects(f.decisions.processInbox(inbox.id), /database failure/);
	assert.equal((await rows(f, "inbox"))[0].status, "pending");
	assert.equal((await rows(f, "rounds"))[0].status, "open");
	assert.equal((await rows(f, "sessions"))[0].version, 0);
	fail = false;
	await f.decisions.processInbox(inbox.id);
	assert.equal((await rows(f, "inbox"))[0].status, "processed");
});

test("inbox survives recreation of service; console shares the same decision path", async () => {
	const f = fixture();
	const { actions } = await open(f);
	const inbox = await f.decisions.receiveChoice(
		choice(actions[0], {
			sourceId: "console:owner",
			actor: { kind: "console", userId: "owner" },
		}),
	);
	const restarted = fixture(f.storage);
	await restarted.decisions.processInbox(inbox.id);
	assert.equal((await rows(f, "sessions"))[0].version, 1);
});

test("worker retries with a stable delivery ID and exposes exhausted jobs", async () => {
	const f = fixture();
	await f.start();
	await f.worker.runOnce();
	const attemptedIds: string[] = [];
	let fail = true;
	const worker = new Worker(
		f.storage,
		f.decisions,
		new Map<string, OutboundChannel>([
			[
				"account-a",
				{
					async send(delivery) {
						attemptedIds.push(delivery.id);
						if (fail) throw new Error("timeout");
						return { externalMessageId: "remote" };
					},
				},
			],
		]),
		f.now,
		2,
	);
	await worker.runOnce();
	assert.equal((await rows(f, "deliveries"))[0].status, "pending");
	f.advance();
	fail = false;
	await worker.runOnce();
	assert.equal(attemptedIds[0], attemptedIds[1]);
	assert.equal((await rows(f, "deliveries"))[0].status, "sent");
	const g = fixture();
	await g.start();
	await g.worker.runOnce();
	const broken = new Worker(
		g.storage,
		g.decisions,
		new Map<string, OutboundChannel>(),
		g.now,
		1,
	);
	await broken.runOnce();
	assert.equal((await rows(g, "deliveries"))[0].status, "failed");
	assert.ok((await rows(g, "jobs")).some((j) => j.status === "failed"));
});

test("expired worker leases are reclaimed with a new fencing token", async () => {
	const f = fixture();
	await f.start();
	const first = await f.storage.claimJob(f.now(), 1000);
	assert.equal(await f.storage.claimJob(f.now(), 1000), null);
	f.advance();
	const second = await f.storage.claimJob(f.now(), 1000);
	assert.ok(first && second);
	assert.equal(first.id, second.id);
	assert.notEqual(first.leaseToken, second.leaseToken);
	assert.equal(second.attempts, 2);
});

test("policy output is checked against limits before any round is stored", async () => {
	const f = fixture();
	const session = await f.start();
	const decisions = new Orchestrator(
		f.storage,
		{
			propose: async () => ({
				...proposal,
				candidates: [
					{
						...proposal.candidates[0],
						changes: [
							{ kind: "budget", channelId: "ads", from: 100, to: 1000 },
						],
					},
				],
			}),
		},
		f.now,
	);
	await assert.rejects(decisions.prepareRound(session.id, 0), /exceeds limits/);
	assert.equal((await rows(f, "rounds")).length, 0);
});

test("delivery cards carry the console detail link when the assembly layer provides one", async () => {
	const linked = fixture(undefined, {
		detailUrlFor: (sessionId) => `https://console.example.com/sessions/${sessionId}`,
	});
	const session = await linked.start();
	await linked.worker.runOnce();
	await linked.worker.runOnce();
	const sent = [...linked.sent.values()];
	assert.ok(sent.length > 0, "决策卡应已投递");
	assert.equal(sent[0]?.card.detailUrl, `https://console.example.com/sessions/${session.id}`);

	// 未注入时不带链接：卡片渲染强制 https，本地/未配置环境保持原行为。
	const plain = fixture();
	const plainSession = await plain.start();
	await plain.worker.runOnce();
	await plain.worker.runOnce();
	const plainSent = [...plain.sent.values()];
	assert.ok(plainSent.length > 0);
	assert.equal(plainSent[0]?.card.detailUrl, undefined);
	assert.ok(plainSession.id);
});
