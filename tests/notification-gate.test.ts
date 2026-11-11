import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
	AuthenticationService,
	NotificationService,
	RecipientUnreachableError,
	type PlatformIdentity,
} from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identity: PlatformIdentity = {
	platform: "feishu",
	applicationId: "cli_test",
	tenantId: "tenant-a",
	idType: "open_id",
	externalId: "ou-owner",
};
const card = {
	title: "复核出价",
	summary: "仅调整方案草案",
	evidence: [],
	options: [{ id: "observe", label: "继续观察" }],
};

async function setup(options: { unreachable?: boolean } = {}) {
	let clock = "2026-01-01T00:00:00.000Z";
	const sent: string[] = [];
	const runtime = compose(
		new MemoryStorage(),
		[
			{
				id: "account-a",
				inbound: {
					async parse() {
						throw new Error("unused");
					},
				},
				outbound: {
					async send(delivery) {
						if (options.unreachable) throw new RecipientUnreachableError();
						sent.push(delivery.id);
						return { externalMessageId: delivery.id };
					},
				},
			},
		],
		{
			propose: async () => structuredClone({ card, candidates: [{ id: "observe", label: "继续观察", changes: [], complete: false }] }),
		},
	);
	const auth = new AuthenticationService(runtime.storage);
	const session = await auth.createWebSession(identity, hash("a".repeat(43)), clock);
	const notifications = new NotificationService(runtime.storage, () => clock);

	/**
	 * 系统主动发起的会话：告警服务创建时写入 `initiatedBy: "system"`，
	 * 这里用存储补上同一标志（#37 的订阅推送沿用该语义）。
	 */
	const startSession = async (systemInitiated: boolean) => {
		const created = await runtime.decisions.startSession({
			requestId: crypto.randomUUID(),
			ownerId: session.userId,
			recipient: { accountId: "account-a", kind: "user", externalId: "ou-owner" },
			allowedActorIds: ["ou-owner"],
			strategy: { objective: "leads", audience: [], channels: {}, sellingPoints: [] },
			limits: { maxBidChangeRatio: 0.2, maxBudgetChangeRatio: 0.2 },
			signal: { id: "sig", title: "成本变化", summary: "需复核", evidence: [] },
			expiresAt: "2030-01-02T00:00:00.000Z",
		});
		if (systemInitiated)
			await runtime.storage.transaction(async (tx) => {
				const current = await tx.sessions.get(created.id);
				if (current)
					await tx.sessions.put({ ...current, initiatedBy: "system" });
			});
		return created;
	};

	/** 跑空队列：startSession 会先入队 prepare_round，直接 send 前需要排空。 */
	const drain = async (limit = 6) => {
		for (let i = 0; i < limit; i += 1) {
			if (!(await runtime.worker.runOnce())) return;
		}
	};

	return {
		runtime,
		session,
		notifications,
		sent,
		drain,
		startSession,
		tick: () => {
			clock = new Date(Date.parse(clock) + 60_000).toISOString();
		},
	};
}

test("gate: 系统自动发起的决策卡在未授权时被抑制且不调用渠道", async () => {
	const { runtime, session, notifications, sent, startSession, drain } = await setup();
	await notifications.verifyDestination(session.userId, identity);
	const alertSession = await startSession(true);
	await runtime.decisions.prepareRound(alertSession.id, 0);

	await drain();

	const deliveries = await runtime.storage.transaction((tx) =>
		tx.deliveries.all(),
	);
	const decision = deliveries.find((item) => item.sessionId === alertSession.id);
	assert.equal(decision?.status, "suppressed");
	assert.equal(decision?.suppressionReason, "consent_missing");
	assert.deepEqual(sent, [], "未授权时不得调用渠道");
});

test("gate: 系统自动发起的卡片在授权后可正常发送", async () => {
	const { runtime, session, notifications, sent, startSession, drain } = await setup();
	const destination = await notifications.verifyDestination(session.userId, identity);
	await notifications.grantConsent(session.userId, destination.id, 0);
	const alertSession = await startSession(true);
	await runtime.decisions.prepareRound(alertSession.id, 0);
	await drain();

	const deliveries = await runtime.storage.transaction((tx) =>
		tx.deliveries.all(),
	);
	const decision = deliveries.find((item) => item.sessionId === alertSession.id);
	assert.equal(decision?.status, "sent");
	assert.equal(sent.length, 1);
});

test("gate: 用户自己创建的会话不受通知授权影响", async () => {
	const { runtime, session, notifications, sent, startSession, drain } = await setup();
	// 只确认地址，不授权。
	await notifications.verifyDestination(session.userId, identity);
	const ownSession = await startSession(false);
	await runtime.decisions.prepareRound(ownSession.id, 0);
	await drain();

	const deliveries = await runtime.storage.transaction((tx) =>
		tx.deliveries.all(),
	);
	const decision = deliveries.find((item) => item.sessionId === ownSession.id);
	assert.equal(decision?.status, "sent", "本人操作回执不受授权闸门限制");
	assert.equal(sent.length, 1);
});

test("gate: 平台报告不可达时终态失败并立即判定地址失效", async () => {
	const { runtime, session, notifications, startSession, drain } = await setup({
		unreachable: true,
	});
	const destination = await notifications.verifyDestination(session.userId, identity);
	await notifications.grantConsent(session.userId, destination.id, 0);

	const first = await startSession(true);
	await runtime.decisions.prepareRound(first.id, 0);
	await drain();
	let deliveries = await runtime.storage.transaction((tx) => tx.deliveries.all());
	assert.equal(
		deliveries.find((item) => item.sessionId === first.id)?.status,
		"failed",
		"不可达应终态失败；重试无意义",
	);
	// 平台说「用户不存在/机器人不在会话」是确定性事实，一次即可判定失效。
	let status = await notifications.status(session.userId);
	assert.equal(status.destination?.status, "invalidated");
	assert.equal(status.destination?.unreachableCount, 1);
	assert.equal(status.canSendProactive, false);
	assert.ok(status.destination?.invalidatedAt);
});

test("gate: 目的地失效后系统卡片改为抑制，不再尝试发送", async () => {
	const { runtime, session, notifications, sent, startSession, drain } = await setup({
		unreachable: true,
	});
	const destination = await notifications.verifyDestination(session.userId, identity);
	await notifications.grantConsent(session.userId, destination.id, 0);
	await notifications.noteUnreachable(session.userId);
	assert.equal((await notifications.status(session.userId)).destination?.status, "invalidated");

	const alertSession = await startSession(true);
	await runtime.decisions.prepareRound(alertSession.id, 0);
	sent.length = 0;
	await drain();
	const deliveries = await runtime.storage.transaction((tx) => tx.deliveries.all());
	const decision = deliveries.find((item) => item.sessionId === alertSession.id);
	assert.equal(decision?.status, "suppressed");
	assert.equal(decision?.suppressionReason, "destination_invalidated");
	assert.deepEqual(sent, []);
});

test("gate: 投递被抑制后即使任务被重新领取也不会补发", async () => {
	const { runtime, session, notifications, sent, startSession, drain } = await setup();
	await notifications.verifyDestination(session.userId, identity);
	const alertSession = await startSession(true);
	await runtime.decisions.prepareRound(alertSession.id, 0);
	await drain();

	const suppressed = (
		await runtime.storage.transaction((tx) => tx.deliveries.all())
	).find((item) => item.sessionId === alertSession.id);
	assert.equal(suppressed?.status, "suppressed");

	// 模拟「写 suppressed 后进程退出」：任务回到 pending 并被重新领取，
	// 此时用户已经授权——已抑制的卡片仍不得补发。
	const destination = await notifications.verifyDestination(session.userId, identity);
	await notifications.grantConsent(session.userId, destination.id, 0);
	await runtime.storage.transaction(async (tx) => {
		const jobs = await tx.jobs.all();
		for (const job of jobs) {
			if (job.task.kind !== "send_delivery" || job.task.deliveryId !== suppressed?.id)
				continue;
			// exactOptionalPropertyTypes：用解构去掉 leaseToken，而不是写 undefined。
			const { leaseToken: _lease, ...rest } = job;
			await tx.jobs.put({ ...rest, status: "pending" });
		}
	});
	sent.length = 0;
	await drain();

	assert.deepEqual(sent, [], "已抑制的投递不得因任务恢复而重新发送");
	const after = (
		await runtime.storage.transaction((tx) => tx.deliveries.all())
	).find((item) => item.id === suppressed?.id);
	assert.equal(after?.status, "suppressed");
});

test("gate: 租约过期后旧 worker 不得把目的地判为失效", async () => {
	let stolenJobId: string | null = null;
	let storage: {
		transaction: <T>(work: (tx: unknown) => Promise<T>) => Promise<T>;
	} | null = null;
	const sent: string[] = [];
	const identityLocal: PlatformIdentity = {
		platform: "feishu",
		applicationId: "cli_test",
		tenantId: "tenant-a",
		idType: "open_id",
		externalId: "ou-owner",
	};
	const runtime = compose(
		new MemoryStorage(),
		[
			{
				id: "account-a",
				inbound: {
					async parse() {
						throw new Error("unused");
					},
				},
				outbound: {
					async send(delivery) {
						// 发送期间租约被新 worker 接管，然后平台才返回不可达。
						if (storage && stolenJobId)
							await storage.transaction(async (tx) => {
								const jobs = await (
									tx as { jobs: { all(): Promise<Array<Record<string, unknown>>>; put(v: unknown): Promise<void> } }
								).jobs.all();
								for (const job of jobs)
									if (job.id === stolenJobId)
										await (
											tx as { jobs: { put(v: unknown): Promise<void> } }
										).jobs.put({
											...job,
											status: "done",
											leaseToken: "new-lease",
										});
							});
						sent.push(delivery.id);
						throw new RecipientUnreachableError();
					},
				},
			},
		],
		{
			propose: async () => ({
				card,
				candidates: [{ id: "observe", label: "继续观察", changes: [], complete: false }],
			}),
		},
	);
	storage = runtime.storage as unknown as typeof storage;
	const auth = new AuthenticationService(runtime.storage);
	const session = await auth.createWebSession(identityLocal, hash("b".repeat(43)), "2026-01-01T00:00:00.000Z");
	const notifications = new NotificationService(runtime.storage);
	const destination = await notifications.verifyDestination(session.userId, identityLocal);
	await notifications.grantConsent(session.userId, destination.id, 0);

	const created = await runtime.decisions.startSession({
		requestId: crypto.randomUUID(),
		ownerId: session.userId,
		recipient: { accountId: "account-a", kind: "user", externalId: "ou-owner" },
		allowedActorIds: ["ou-owner"],
		strategy: { objective: "leads", audience: [], channels: {}, sellingPoints: [] },
		limits: { maxBidChangeRatio: 0.2, maxBudgetChangeRatio: 0.2 },
		signal: { id: "sig", title: "t", summary: "s", evidence: [] },
		expiresAt: "2030-01-02T00:00:00.000Z",
	});
	await runtime.storage.transaction(async (tx) => {
		const current = await tx.sessions.get(created.id);
		if (current) await tx.sessions.put({ ...current, initiatedBy: "system" });
	});
	await runtime.decisions.prepareRound(created.id, 0);
	const jobs = await runtime.storage.transaction((tx) => tx.jobs.all());
	stolenJobId = jobs.find((job) => job.task.kind === "send_delivery")?.id ?? null;

	for (let i = 0; i < 6; i += 1) if (!(await runtime.worker.runOnce())) break;

	const status = await notifications.status(session.userId);
	assert.equal(status.destination?.status, "verified", "过期 worker 不得让地址失效");
	assert.equal(status.canSendProactive, true, "新 worker 已接管，闸门不应被旧结果关闭");
});

test("gate: 发往他人地址的失败不能牵连本人已确认目的地", async () => {
	const { runtime, session, notifications, startSession, drain } = await setup({
		unreachable: true,
	});
	const destination = await notifications.verifyDestination(session.userId, identity);
	await notifications.grantConsent(session.userId, destination.id, 0);

	// 会话发给另一个（不可达的）收件人：失败属实，但不应让本人目的地失效。
	const other = await runtime.decisions.startSession({
		requestId: crypto.randomUUID(),
		ownerId: session.userId,
		recipient: { accountId: "account-a", kind: "user", externalId: "ou-someone-else" },
		allowedActorIds: ["ou-owner"],
		strategy: { objective: "leads", audience: [], channels: {}, sellingPoints: [] },
		limits: { maxBidChangeRatio: 0.2, maxBudgetChangeRatio: 0.2 },
		signal: { id: "sig", title: "t", summary: "s", evidence: [] },
		expiresAt: "2030-01-02T00:00:00.000Z",
	});
	await runtime.decisions.prepareRound(other.id, 0);
	await drain();

	const deliveries = await runtime.storage.transaction((tx) => tx.deliveries.all());
	assert.equal(
		deliveries.find((item) => item.sessionId === other.id)?.status,
		"failed",
		"投递本身仍应记为失败",
	);
	const status = await notifications.status(session.userId);
	assert.equal(status.destination?.status, "verified", "他人地址失败不得让本人地址失效");
	assert.equal(status.canSendProactive, true);
	assert.equal(status.destination?.unreachableCount, undefined, "不应累计不可达次数");
	assert.ok(await startSession);
});
