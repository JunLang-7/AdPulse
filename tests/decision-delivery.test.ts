import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { ChannelAccount } from "../packages/channels/dist/index.js";
import {
	AuthenticationService,
	type CardDelivery,
	ComparisonService,
	type DecisionAccountResolver,
	type EvidenceImportRecord,
	EvidenceService,
	InvestigationAlertService,
	NotificationService,
	Orchestrator,
	RecipientUnreachableError,
	resolveActiveIdentity,
	type Storage,
	SubscriptionService,
	type TaskInput,
	TaskService,
	Worker,
} from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import {
	MemoryStorage,
	PostgresStorage,
} from "../packages/storage/dist/index.js";

const START = "2026-11-12T00:00:00.000Z";
const FREEZE = "2026-11-12T01:00:00.000Z";

const taskInput = (endsAt?: string): TaskInput => ({
	product: "合成测试产品",
	strategy: {
		objective: "人工核查咨询成本",
		audience: ["合成受众"],
		channels: { test: {} },
		sellingPoints: [],
	},
	observation: endsAt ? { endsAt } : {},
	rules: {
		metricKey: "cost_per_consultation",
		metricDefinition: "咨询成本",
		currency: "CNY",
		unit: "分",
		statWindowDays: 1,
		alertThresholdMinor: 100,
		minimumSpendMinor: 0,
		minimumConsultations: 0,
	},
});
const record = (spendMinor = 2000): EvidenceImportRecord => ({
	source: {
		platform: "synthetic-report",
		accountRef: "synthetic-account",
		reportRef: "report",
	},
	scope: { planRef: "synthetic-plan", campaignRefs: [] },
	period: {
		startsAt: "2026-11-10T00:00:00+08:00",
		endsAt: "2026-11-11T00:00:00+08:00",
		timeZone: "Asia/Shanghai",
		completeness: "complete",
	},
	metricsContract: {
		spendMinor: {
			definition: "消耗",
			formula: "报表金额换算为分",
			sourceField: "spend",
		},
		consultations: {
			definition: "咨询数",
			formula: "报表咨询数",
			sourceField: "consultations",
		},
	},
	currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
	attribution: { model: "click", windowDays: 7 },
	callbackStatus: "complete",
	rawValues: { spend: String(spendMinor), consultations: 10 },
	values: { spendMinor, consultations: 10 },
});

async function setup(
	options: { storage?: Storage; enabled?: boolean; endsAt?: string } = {},
) {
	const storage = options.storage ?? new MemoryStorage();
	let now = START;
	const clock = () => now;
	const identity = {
		platform: "feishu",
		applicationId: "cli-synthetic",
		tenantId: "tenant-synthetic",
		idType: "open_id",
		externalId: `ou-${crypto.randomUUID()}`,
	};
	const auth = new AuthenticationService(storage);
	const web = await auth.createWebSession(
		identity,
		crypto.randomUUID().replaceAll("-", "").repeat(2),
		START,
	);
	const owner = web.userId;
	const tasks = new TaskService(storage, clock);
	const task = await tasks.create(
		owner,
		crypto.randomUUID(),
		taskInput(options.endsAt),
	);
	const evidence = new EvidenceService(storage, clock);
	const imported = await evidence.import(owner, crypto.randomUUID(), {
		schemaVersion: 1,
		taskRef: { taskId: task.taskId, taskVersion: 1 },
		records: [record()],
	});
	const ref = imported[0];
	assert.ok(ref);
	const comparisons = new ComparisonService(storage, clock);
	const comparison = await comparisons.evaluate(owner, crypto.randomUUID(), {
		current: { evidenceId: ref.evidenceId, version: 1 },
	});
	const alerts = new InvestigationAlertService(storage, clock);
	const subscriptions = new SubscriptionService(storage, clock);
	const notifications = new NotificationService(storage, clock);
	const destination = await notifications.verifyDestination(owner, identity);
	await notifications.grantConsent(owner, destination.id, 0);
	await subscriptions.addTarget(owner, {
		expectedVersion: 0,
		kind: "task",
		refId: task.taskId,
		categories: ["effect"],
		scope: "task_only",
	});
	await subscriptions.updateSettings(owner, {
		expectedVersion: 1,
		proactiveEnabled: true,
		decisionCardsEnabled: true,
	});
	const accountFor: DecisionAccountResolver | undefined =
		options.enabled === false
			? undefined
			: (target) =>
					target.platform === identity.platform &&
					target.applicationId === identity.applicationId &&
					target.tenantId === identity.tenantId &&
					target.idType === "open_id"
						? "synthetic-feishu"
						: undefined;
	const sent: CardDelivery[] = [];
	let onSend: (() => Promise<void>) | undefined;
	const decisions = new Orchestrator(
		storage,
		{
			async propose() {
				throw new Error(
					"alert must use its frozen domain candidate, not a model",
				);
			},
		},
		clock,
		undefined,
		async (tx, actor) =>
			(await resolveActiveIdentity(tx, {
				...identity,
				externalId: actor.externalId,
			})) === actor.userId,
		(id) => `https://example.test/sessions/${id}`,
		accountFor,
	);
	const channels = new Map([
		[
			"synthetic-feishu",
			{
				async send(delivery: CardDelivery) {
					sent.push(delivery);
					await onSend?.();
					return { externalMessageId: `synthetic:${delivery.id}` };
				},
			},
		],
	]);
	const worker = new Worker(
		storage,
		decisions,
		channels,
		clock,
		2,
		alerts,
		notifications,
		undefined,
		30_000,
		accountFor,
	);
	now = FREEZE;
	const freeze = async (sessionExpiresAt?: string) => {
		const alert = await alerts.evaluateComparison(owner, comparison.id);
		assert.ok(alert);
		await alerts.prepareSession(alert.id);
		if (sessionExpiresAt)
			await storage.transaction(async (tx) => {
				const session = await tx.sessions.get(alert.sessionId);
				assert.ok(session);
				await tx.sessions.put({ ...session, expiresAt: sessionExpiresAt });
			});
		await decisions.prepareRound(alert.sessionId, 0);
		// Direct preparation above succeeded; model the corresponding worker job completions.
		await storage.transaction(async (tx) => {
			for (const job of await tx.jobs.all())
				if (
					(job.task.kind === "prepare_round" &&
						job.task.sessionId === alert.sessionId) ||
					(job.task.kind === "prepare_investigation_alert_session" &&
						job.task.alertId === alert.id)
				)
					await tx.jobs.put({ ...job, status: "done" });
		});
		const session = await storage.transaction((tx) =>
			tx.sessions.get(alert.sessionId),
		);
		const round = await storage.transaction((tx) =>
			tx.rounds.get(`${alert.sessionId}:1`),
		);
		assert.ok(session);
		assert.ok(round);
		return { alert, session, round };
	};
	const drain = async (otherWorker = worker) => {
		for (let index = 0; index < 30; index++)
			if (!(await otherWorker.runOnce())) return;
		throw new Error("worker did not become idle");
	};
	const settings = async (input: {
		proactiveEnabled?: boolean;
		decisionCardsEnabled?: boolean;
	}) => {
		const view = await subscriptions.view(owner);
		return subscriptions.updateSettings(owner, {
			...input,
			expectedVersion: view.settings.version,
		});
	};
	const deliveries = () =>
		storage.transaction(async (tx) => {
			const sessions = new Set(
				(await tx.sessions.all())
					.filter((session) => session.ownerId === owner)
					.map((session) => session.id),
			);
			return (await tx.deliveries.all()).filter(
				(item) =>
					item.sessionId &&
					sessions.has(item.sessionId) &&
					item.proactiveDecision,
			);
		});
	return {
		storage,
		owner,
		web,
		identity,
		tasks,
		task,
		evidence,
		ref,
		comparisons,
		comparison,
		alerts,
		auth,
		subscriptions,
		notifications,
		destination,
		decisions,
		worker,
		channels,
		accountFor,
		freeze,
		drain,
		settings,
		deliveries,
		sent,
		setTime(at: string) {
			now = at;
		},
		clock,
		onSend(hook: () => Promise<void>) {
			onSend = hook;
		},
	};
}

test("decision delivery: freezes real task and evidence once, sends the same actions and preserves business results", async () => {
	const f = await setup();
	const { alert, session, round } = await f.freeze();
	assert.equal(session.deliveryMode, "channel");
	assert.equal(session.investigationAlertId, alert.id);
	assert.deepEqual(session.strategy, taskInput().strategy);
	assert.equal(round.expiresAt, "2026-11-13T01:00:00.000Z");
	assert.ok(
		session.signal.evidence.some((item) =>
			item.value.includes(f.ref.evidenceId),
		),
	);
	await Promise.all([
		f.decisions.prepareRound(session.id, 0),
		f.alerts.prepareSession(alert.id),
		f.decisions.prepareRound(session.id, 0),
	]);
	const queued = await f.deliveries();
	assert.equal(queued.length, 1);
	assert.equal(queued[0]?.roundId, round.id);
	assert.equal(queued[0]?.expiresAt, round.expiresAt);
	const delivery = queued[0];
	assert.ok(delivery);
	assert.ok(
		"summary" in delivery.card && delivery.card.summary.includes("北京时间"),
	);
	await f.drain();
	assert.equal(f.sent.length, 1);
	assert.deepEqual(f.sent[0]?.actions, queued[0]?.actions);
	assert.equal((await f.deliveries())[0]?.status, "sent");
	assert.equal((await f.deliveries())[0]?.proactiveCheckedAt, FREEZE);
	const action = queued[0]?.actions[0];
	assert.ok(action);
	const wrong = await f.decisions.receiveChoice({
		sourceId: "synthetic-feishu",
		eventId: "wrong-owner",
		actionRef: action.actionRef,
		actor: {
			kind: "platform",
			accountId: "synthetic-feishu",
			externalId: f.identity.externalId,
			userId: "someone-else",
		},
	});
	await f.decisions.processInbox(wrong.id);
	assert.equal(
		(await f.storage.transaction((tx) => tx.inbox.get(wrong.id)))?.status,
		"rejected",
	);
	await f.settings({ proactiveEnabled: false });
	const choice = await f.decisions.receiveChoice({
		sourceId: "synthetic-feishu",
		eventId: "owner-choice",
		actionRef: action.actionRef,
		actor: {
			kind: "platform",
			accountId: "synthetic-feishu",
			externalId: f.identity.externalId,
			userId: f.owner,
		},
	});
	await f.decisions.processInbox(choice.id);
	await f.drain();
	assert.equal(
		f.sent.length,
		2,
		"the owner's operation receipt is not a subscription push",
	);
	const saved = await f.storage.transaction((tx) =>
		tx.sessions.get(session.id),
	);
	assert.equal(saved?.status, "completed");
	assert.deepEqual(saved?.strategy, session.strategy);
	await f.decisions.processInbox(choice.id);
	assert.equal(
		(await f.storage.transaction((tx) => tx.snapshots.all())).filter(
			(item) => item.sessionId === session.id,
		).length,
		2,
	);
});

for (const condition of [
	"runtime_off",
	"separate_opt_out",
	"all_push_off",
	"no_effect_target",
	"unverified",
	"at_confirmation_time",
	"at_global_enable_time",
] as const) {
	test(`decision delivery: ${condition} does not enqueue or backfill a historical Web candidate`, async () => {
		const f = await setup({ enabled: condition !== "runtime_off" });
		if (condition === "separate_opt_out")
			await f.settings({ decisionCardsEnabled: false });
		if (condition === "all_push_off")
			await f.settings({ proactiveEnabled: false });
		if (condition === "no_effect_target") {
			const view = await f.subscriptions.view(f.owner);
			assert.ok(view.targets[0]);
			await f.subscriptions.updateTarget(f.owner, view.targets[0].id, {
				expectedVersion: view.settings.version,
				status: "muted",
			});
		}
		if (condition === "unverified")
			await f.notifications.revokeConsent(f.owner, f.destination.id, 1);
		if (condition === "at_confirmation_time") {
			await f.settings({ decisionCardsEnabled: false });
			await f.settings({ decisionCardsEnabled: true });
		}
		if (condition === "at_global_enable_time") {
			await f.settings({ proactiveEnabled: false });
			await f.settings({ proactiveEnabled: true });
		}
		const { session } = await f.freeze();
		assert.equal(session.deliveryMode, "web");
		assert.deepEqual(await f.deliveries(), []);
		f.setTime("2026-11-12T02:00:00.000Z");
		await f.settings({ proactiveEnabled: true, decisionCardsEnabled: true });
		await f.decisions.prepareRound(session.id, 0);
		await f.drain();
		assert.deepEqual(f.sent, []);
	});
}

test("decision delivery: quiet hours defer the same job without consuming retry budget or extending the freeze", async () => {
	const f = await setup();
	f.setTime("2026-11-12T14:00:00.000Z"); // 22:00 Beijing
	await f.freeze();
	await f.drain();
	assert.equal(f.sent.length, 0);
	const job = (await f.storage.transaction((tx) => tx.jobs.all())).find(
		(item) => item.task.kind === "send_investigation_decision",
	);
	assert.equal(job?.runAt, "2026-11-13T00:00:00.000Z");
	assert.equal(job?.attempts, 0);
	const before = (await f.deliveries())[0];
	f.setTime("2026-11-13T00:00:00.000Z");
	await f.drain();
	assert.equal(f.sent.length, 1);
	assert.equal(f.sent[0]?.id, before?.id);
	assert.equal((await f.deliveries())[0]?.expiresAt, before?.expiresAt);
});

test("decision delivery: task/session cutoffs and quiet-hour expiry are strict", async () => {
	for (const type of ["task", "session", "quiet"] as const) {
		const cutoff =
			type === "quiet"
				? "2026-11-12T23:00:00.000Z"
				: "2026-11-12T03:00:00.000Z";
		const f = await setup({
			...(type !== "session" ? { endsAt: cutoff } : {}),
		});
		if (type === "quiet") f.setTime("2026-11-12T14:00:00.000Z");
		const { round } = await f.freeze(type === "session" ? cutoff : undefined);
		assert.equal(round.expiresAt, cutoff);
		if (type !== "quiet") f.setTime(cutoff);
		await f.drain();
		assert.equal(f.sent.length, 0);
		assert.ok(
			["cancelled", "suppressed"].includes(
				(await f.deliveries())[0]?.status ?? "",
			),
		);
	}
});

for (const change of [
	"settings",
	"consent",
	"identity",
	"evidence",
	"task",
	"destination",
	"channel",
] as const) {
	test(`decision delivery: queued ${change} changes prevent sending and cannot restore the old queue`, async () => {
		const f = await setup();
		await f.freeze();
		if (change === "settings") {
			await f.settings({ proactiveEnabled: false });
			assert.equal((await f.deliveries())[0]?.status, "suppressed");
			await f.settings({ proactiveEnabled: true });
		}
		if (change === "consent") {
			await f.notifications.revokeConsent(f.owner, f.destination.id, 1);
			await f.notifications.grantConsent(f.owner, f.destination.id, 2);
		}
		if (change === "identity") {
			const binding = (
				await f.storage.transaction((tx) => tx.identityBindings.all())
			).find((item) => item.userId === f.owner);
			assert.ok(binding);
			await f.auth.revokeIdentity(binding.id, f.clock());
		}
		if (change === "evidence")
			await f.evidence.revise(f.owner, f.ref.evidenceId, "revision", {
				expectedEvidenceVersion: 1,
				reason: "合成修订",
				record: record(2100),
			});
		if (change === "task")
			await f.tasks.revise(f.owner, f.task.taskId, 1, "revision", taskInput());
		if (change === "destination") {
			await f.notifications.noteUnreachable(f.owner);
			await f.notifications.verifyDestination(f.owner, f.identity);
		}
		const disabledWorker = new Worker(
			f.storage,
			f.decisions,
			f.channels,
			f.clock,
			2,
			f.alerts,
			f.notifications,
		);
		await f.drain(change === "channel" ? disabledWorker : f.worker);
		assert.equal(f.sent.length, 0);
		assert.ok(
			["cancelled", "suppressed"].includes(
				(await f.deliveries())[0]?.status ?? "",
			),
		);
	});
}

for (const change of [
	"settings_version",
	"consent_version",
	"evidence_head",
	"task_head",
	"confirmation_time",
	"evidence_deleted",
	"source_deleted",
	"freeze_time",
] as const) {
	test(`decision delivery: worker independently rechecks ${change}, even if an older writer did not cancel`, async () => {
		const f = await setup();
		await f.freeze();
		await f.storage.transaction(async (tx) => {
			if (change === "evidence_deleted")
				await tx.evidenceVersions.delete(`${f.ref.evidenceId}:1`);
			if (change === "source_deleted") {
				for (const source of await tx.evidenceSources.all())
					if (source.ownerId === f.owner)
						await tx.evidenceSources.delete(source.id);
			}
			if (change === "freeze_time") {
				const delivery = (await tx.deliveries.all()).find(
					(item) => item.proactiveDecision,
				);
				assert.ok(delivery?.proactiveDecision);
				await tx.deliveries.put({
					...delivery,
					proactiveDecision: {
						...delivery.proactiveDecision,
						frozenAt: "2026-11-12T00:59:59.000Z",
					},
				});
			}
			if (change === "settings_version" || change === "confirmation_time") {
				const settings = await tx.subscriptionSettings.get(f.owner);
				assert.ok(settings);
				await tx.subscriptionSettings.put({
					...settings,
					version:
						change === "confirmation_time"
							? settings.version
							: settings.version + 1,
					...(change === "confirmation_time"
						? {
								decisionCards: {
									...settings.decisionCards,
									enabled: true,
									enabledAt: FREEZE,
								},
							}
						: {}),
				});
			}
			if (change === "consent_version") {
				const consent = await tx.notificationConsents.get(
					`${f.owner}:${f.destination.id}`,
				);
				assert.ok(consent);
				await tx.notificationConsents.put({
					...consent,
					version: consent.version + 1,
				});
			}
			if (change === "evidence_head") {
				const head = await tx.evidenceHeads.get(f.ref.evidenceId);
				assert.ok(head);
				await tx.evidenceHeads.put({ ...head, currentVersion: 2 });
			}
			if (change === "task_head") {
				const task = await tx.tasks.get(f.task.taskId);
				assert.ok(task);
				await tx.tasks.put({ ...task, currentVersion: 2 });
			}
		});
		await f.drain();
		assert.equal(f.sent.length, 0);
		assert.equal((await f.deliveries())[0]?.status, "suppressed");
	});
}

for (const mode of [
	"default_off",
	"matching",
	"wrong_app",
	"wrong_tenant",
	"wrong_id_type",
	"ambiguous",
	"no_attester",
] as const) {
	test(`decision delivery: runtime resolves the complete account scope (${mode})`, async () => {
		const f = await setup();
		f.setTime(new Date(Date.now() - 2000).toISOString());
		await f.settings({ proactiveEnabled: false, decisionCardsEnabled: false });
		await f.settings({ proactiveEnabled: true, decisionCardsEnabled: true });
		if (mode === "wrong_id_type")
			await f.storage.transaction(async (tx) => {
				const destination = await tx.notificationDestinations.get(
					f.destination.id,
				);
				assert.ok(destination);
				await tx.notificationDestinations.put({
					...destination,
					idType: "user_id",
				});
				for (const binding of await tx.identityBindings.all())
					if (binding.userId === f.owner)
						await tx.identityBindings.put({ ...binding, idType: "user_id" });
			});
		const account: ChannelAccount = {
			id: "scope-account",
			identityScope: {
				platform: "feishu",
				applicationId:
					mode === "wrong_app" ? "other-app" : f.identity.applicationId,
				tenantId:
					mode === "wrong_tenant" ? "other-tenant" : f.identity.tenantId,
			},
			inbound: {
				async parse() {
					throw new Error("unused synthetic inbound");
				},
				...(mode !== "no_attester"
					? {
							identifyActor: (actor: { externalId: string }) => ({
								...f.identity,
								externalId: actor.externalId,
							}),
						}
					: {}),
			},
			outbound: {
				async send() {
					throw new Error("this test must not invoke a channel");
				},
			},
		};
		const accounts =
			mode === "ambiguous"
				? [account, { ...account, id: "duplicate-scope" }]
				: [account];
		const runtime = compose(
			f.storage,
			accounts,
			undefined,
			mode === "default_off" ? {} : { decisionCardsEnabled: true },
		);
		const alert = await f.alerts.evaluateComparison(f.owner, f.comparison.id);
		assert.ok(alert);
		await f.alerts.prepareSession(alert.id);
		await runtime.decisions.prepareRound(alert.sessionId, 0);
		assert.equal((await f.deliveries()).length, mode === "matching" ? 1 : 0);
	});
}

test("decision delivery: one user's cancellation cannot consume another user's notification", async () => {
	const storage = new MemoryStorage();
	const f = await setup({ storage });
	const g = await setup({ storage });
	await f.freeze();
	await g.freeze();
	await f.settings({ proactiveEnabled: false });
	await f.drain();
	assert.equal(
		(await f.deliveries()).filter(
			(delivery) => delivery.recipient.externalId === f.identity.externalId,
		)[0]?.status,
		"suppressed",
	);
	assert.equal(f.sent.length, 1);
	assert.equal(f.sent[0]?.recipient.externalId, g.identity.externalId);
});

test("decision delivery: expired old cards reject owner clicks without changing the business strategy", async () => {
	const f = await setup();
	const { session, round } = await f.freeze();
	const delivery = (await f.deliveries())[0];
	assert.ok(delivery?.actions[0]);
	assert.ok(round.expiresAt);
	f.setTime(round.expiresAt);
	const inbox = await f.decisions.receiveChoice({
		sourceId: "console",
		eventId: "expired",
		actionRef: delivery.actions[0].actionRef,
		actor: { kind: "console", userId: f.owner },
	});
	await f.decisions.processInbox(inbox.id);
	const result = await f.storage.transaction((tx) => tx.inbox.get(inbox.id));
	assert.equal(result?.reason, "expired");
	const saved = await f.storage.transaction((tx) =>
		tx.sessions.get(session.id),
	);
	assert.deepEqual(saved?.strategy, session.strategy);
	assert.equal(saved?.version, 0);
});

test("decision delivery: retry uses the same frozen identity, cancellation survives an in-flight failure", async () => {
	const f = await setup();
	await f.freeze();
	let attempts = 0;
	f.onSend(async () => {
		if (++attempts === 1) throw new Error("synthetic transport failure");
	});
	await f.drain();
	assert.equal(f.sent.length, 1);
	f.setTime("2026-11-12T01:00:10.000Z");
	await f.drain();
	assert.equal(f.sent.length, 2);
	assert.equal(f.sent[0]?.id, f.sent[1]?.id);
	assert.deepEqual(f.sent[0]?.actions, f.sent[1]?.actions);
	const g = await setup();
	await g.freeze();
	g.onSend(async () => {
		await g.settings({ proactiveEnabled: false });
		throw new Error("synthetic failure after cancellation");
	});
	await g.drain();
	g.setTime("2026-11-12T01:00:10.000Z");
	await g.drain();
	assert.equal((await g.deliveries())[0]?.status, "suppressed");
	assert.equal(
		g.sent.length,
		1,
		"an in-flight request cannot be recalled, but must not be retried",
	);
});

test("decision delivery: unreachable receipt and expired worker lease cannot corrupt a new owner's result", async () => {
	const f = await setup();
	await f.freeze();
	f.onSend(async () => {
		throw new RecipientUnreachableError();
	});
	await f.drain();
	assert.equal((await f.deliveries())[0]?.status, "failed");
	assert.equal(
		(await f.notifications.status(f.owner)).destination?.status,
		"invalidated",
	);
	const g = await setup();
	await g.freeze();
	g.onSend(async () => {
		const jobs = await g.storage.transaction((tx) => tx.jobs.all());
		const running = jobs.find(
			(item) =>
				item.task.kind === "send_investigation_decision" &&
				item.status === "running",
		);
		assert.ok(running);
		await g.storage.transaction((tx) =>
			tx.jobs.put({
				...running,
				leaseToken: "new-owner",
				lockedUntil: "2026-11-12T02:00:00.000Z",
			}),
		);
		throw new RecipientUnreachableError();
	});
	await g.drain();
	assert.equal((await g.deliveries())[0]?.status, "pending");
	assert.equal(
		(await g.notifications.status(g.owner)).destination?.status,
		"verified",
	);
});

test("PostgreSQL: concurrent freeze and restart preserve one candidate, delivery and fenced outbox job", {
	skip: !process.env.TEST_DATABASE_URL,
	timeout: 15_000,
}, async (t) => {
	const url = process.env.TEST_DATABASE_URL;
	assert.ok(url);
	const {
		Pool,
	}: {
		Pool: new (config: {
			connectionString: string;
		}) => {
			query(sql: string): Promise<unknown>;
			end(): Promise<void>;
		};
	} = createRequire(
		new URL("../packages/storage/package.json", import.meta.url),
	)("pg");
	const admin = new Pool({ connectionString: url });
	const schema = `decision_test_${crypto.randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE SCHEMA "${schema}"`);
	const isolated = new URL(url);
	isolated.searchParams.set("options", `-c search_path=${schema}`);
	const storage = PostgresStorage.connect(isolated.toString());
	let reconnect: PostgresStorage | undefined;
	t.after(async () => {
		await reconnect?.close();
		await storage.close();
		try {
			await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
		} finally {
			await admin.end();
		}
	});
	await storage.initialize();
	const f = await setup({ storage });
	const alert = await f.alerts.evaluateComparison(f.owner, f.comparison.id);
	assert.ok(alert);
	await f.alerts.prepareSession(alert.id);
	await Promise.all(
		Array.from({ length: 4 }, () =>
			f.decisions.prepareRound(alert.sessionId, 0),
		),
	);
	const deliveries = await f.deliveries();
	assert.equal(deliveries.length, 1);
	assert.equal(
		(await storage.transaction((tx) => tx.rounds.all())).filter(
			(round) => round.sessionId === alert.sessionId,
		).length,
		1,
	);
	reconnect = PostgresStorage.connect(isolated.toString());
	await reconnect.initialize();
	const restored = new Worker(
		reconnect,
		f.decisions,
		f.channels,
		f.clock,
		2,
		f.alerts,
		f.notifications,
		undefined,
		30_000,
		f.accountFor,
	);
	await f.drain(restored);
	assert.equal(
		f.sent.filter((delivery) => delivery.id === deliveries[0]?.id).length,
		1,
	);
	assert.equal((await f.deliveries())[0]?.status, "sent");
	const jobs = (await reconnect.transaction((tx) => tx.jobs.all())).filter(
		(job) =>
			job.task.kind === "send_investigation_decision" &&
			job.task.deliveryId === deliveries[0]?.id,
	);
	assert.equal(jobs.length, 1);
	assert.equal(jobs[0]?.status, "done");

	const g = await setup({ storage });
	const frozen = await g.freeze();
	// The fixture called preparation directly; commit its job completion before testing send leases.
	await storage.transaction(async (tx) => {
		for (const job of await tx.jobs.all()) {
			if (
				(job.task.kind === "prepare_round" &&
					job.task.sessionId === frozen.session.id) ||
				(job.task.kind === "prepare_investigation_alert_session" &&
					job.task.alertId === frozen.alert.id)
			)
				await tx.jobs.put({ ...job, status: "done" });
		}
	});
	let signalEntered: () => void = () => {};
	let release: () => void = () => {};
	const entered = new Promise<void>((resolve) => {
		signalEntered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	t.after(() => release());
	let firstAttempt = true;
	g.onSend(async () => {
		if (!firstAttempt) return;
		firstAttempt = false;
		signalEntered();
		await gate;
		throw new RecipientUnreachableError();
	});
	const expiredWorker = g.worker.runOnce();
	await entered;
	g.setTime("2026-11-12T01:01:01.000Z");
	const replacement = new Worker(
		reconnect,
		g.decisions,
		g.channels,
		g.clock,
		2,
		g.alerts,
		g.notifications,
		undefined,
		30_000,
		g.accountFor,
	);
	assert.equal(await replacement.runOnce(), true);
	release();
	await expiredWorker;
	assert.equal((await g.deliveries())[0]?.status, "sent");
	assert.equal(
		(await g.notifications.status(g.owner)).destination?.status,
		"verified",
	);
	assert.equal(
		g.sent.length,
		2,
		"lease recovery is not a promise of physical exactly-once delivery",
	);
	assert.equal(g.sent[0]?.id, g.sent[1]?.id);

	const race = await setup({ storage });
	const raceAlert = await race.alerts.evaluateComparison(
		race.owner,
		race.comparison.id,
	);
	assert.ok(raceAlert);
	await race.alerts.prepareSession(raceAlert.id);
	await Promise.all([
		race.decisions.prepareRound(raceAlert.sessionId, 0),
		race.settings({ proactiveEnabled: false }),
	]);
	await race.drain();
	assert.equal(race.sent.length, 0);
	assert.ok(
		(await race.deliveries()).every(
			(delivery) => delivery.status === "suppressed",
		),
	);
});
