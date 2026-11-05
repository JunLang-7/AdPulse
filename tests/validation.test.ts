import assert from "node:assert/strict";
import test from "node:test";
import {
	applyChanges,
	Orchestrator,
	Worker,
} from "../packages/core/dist/index.js";
import type {
	ChoiceCommand,
	Limits,
	OutboundChannel,
	Strategy,
	StrategyChange,
} from "../packages/core/dist/index.js";
import { fixture, proposal } from "./helpers.ts";

const strategy: Strategy = {
	objective: "leads",
	audience: [],
	channels: { ads: { budget: 100, bidCpc: 2 } },
	sellingPoints: [],
};
const limits: Limits = { maxBudgetChangeRatio: 0.2, maxBidChangeRatio: 0.2 };

test("model changes cannot bypass limits through repeated fields or unsupported kinds", () => {
	assert.throws(
		() =>
			applyChanges(
				strategy,
				[
					{ kind: "budget", channelId: "ads", from: 100, to: 120 },
					{ kind: "budget", channelId: "ads", from: 120, to: 144 },
				],
				limits,
			),
		/duplicate/,
	);
	for (const change of [
		{ kind: "arbitrary", channelId: "ads", to: 100 },
		{ kind: "budget", channelId: "missing", from: 100, to: 100 },
		{ kind: "budget", channelId: "ads", from: 90, to: 100 },
		{ kind: "bidCpc", channelId: "ads", from: 2, to: NaN },
		{ kind: "enabled", channelId: "ads", to: "true" },
		null,
	] as unknown[])
		assert.throws(() =>
			applyChanges(strategy, [change as StrategyChange], limits),
		);
	assert.equal(strategy.channels.ads.budget, 100);
});

test("inbox event identity is scoped to each connection", async () => {
	const f = fixture();
	const command: ChoiceCommand = {
		sourceId: "account-a",
		eventId: "same-event",
		actionRef: "opaque",
		actor: { kind: "platform", accountId: "account-a", externalId: "u" },
	};
	const first = await f.decisions.receiveChoice(command);
	const second = await f.decisions.receiveChoice({
		...command,
		sourceId: "account-b",
		actor: { kind: "platform", accountId: "account-b", externalId: "u" },
	});
	assert.notEqual(first.id, second.id);
});

test("slow proposal is discarded if the session changes while the policy runs", async () => {
	const f = fixture();
	const session = await f.start();
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const decisions = new Orchestrator(
		f.storage,
		{
			async propose() {
				entered();
				await blocked;
				return structuredClone(proposal);
			},
		},
		f.now,
	);
	const planning = decisions.prepareRound(session.id, 0);
	await started;
	await f.storage.transaction(async (tx) => {
		const current = await tx.sessions.get(session.id);
		assert.ok(current);
		await tx.sessions.put({ ...current, status: "cancelled" });
	});
	release();
	await planning;
	assert.equal(
		(await f.storage.transaction((tx) => tx.rounds.all())).length,
		0,
	);
	assert.equal(
		(await f.storage.transaction((tx) => tx.deliveries.all())).length,
		0,
	);
});

test("non-terminal decision produces next round using the updated strategy", async () => {
	const f = fixture();
	const session = await f.start();
	const seen: Strategy[] = [];
	const decisions = new Orchestrator(
		f.storage,
		{
			async propose(context) {
				seen.push(structuredClone(context.strategy));
				if (context.roundNo === 1)
					return {
						...structuredClone(proposal),
						candidates: [
							{ ...structuredClone(proposal.candidates[0]), complete: false },
						],
					};
				return {
					...structuredClone(proposal),
					candidates: [
						{ id: "done", label: "完成", changes: [], complete: true },
					],
				};
			},
		},
		f.now,
	);
	await decisions.prepareRound(session.id, 0);
	const action = (await f.storage.transaction((tx) => tx.actions.all()))[0];
	const inbox = await decisions.receiveChoice({
		sourceId: "console:owner",
		eventId: "decision",
		actionRef: action.id,
		actor: { kind: "console", userId: "owner" },
	});
	await decisions.processInbox(inbox.id);
	await decisions.prepareRound(session.id, 1);
	assert.equal(seen[1].channels.ads.bidCpc, 1.8);
	assert.deepEqual(
		(await f.storage.transaction((tx) => tx.rounds.all())).map(
			(r) => r.roundNo,
		),
		[1, 2],
	);
});

test("an expired worker cannot overwrite the receipt committed by the new lease holder", async () => {
	const f = fixture();
	await f.start();
	await f.worker.runOnce();
	let release!: () => void;
	let entered!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const oldWorker = new Worker(
		f.storage,
		f.decisions,
		new Map<string, OutboundChannel>([
			[
				"account-a",
				{
					async send() {
						entered();
						await blocked;
						return { externalMessageId: "stale-receipt" };
					},
				},
			],
		]),
		f.now,
	);
	const first = oldWorker.runOnce();
	await started;
	f.advance();
	const newWorker = new Worker(
		f.storage,
		f.decisions,
		new Map<string, OutboundChannel>([
			[
				"account-a",
				{
					async send() {
						return { externalMessageId: "current-receipt" };
					},
				},
			],
		]),
		f.now,
	);
	await newWorker.runOnce();
	release();
	await first;
	const delivery = (
		await f.storage.transaction((tx) => tx.deliveries.all())
	)[0];
	assert.equal(delivery.externalMessageId, "current-receipt");
	const sendJob = (await f.storage.transaction((tx) => tx.jobs.all())).find(
		(j) => j.task.kind === "send_delivery",
	);
	assert.ok(sendJob);
	assert.equal(sendJob.status, "done");
	assert.equal(sendJob.attempts, 2);
});
