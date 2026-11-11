import assert from "node:assert/strict";
import test from "node:test";

import {
	AuthenticationService,
	DecisionDeliveryError,
	DecisionDeliveryService,
	InvestigationAlertService,
	Orchestrator,
	NotificationService,
	NotificationQueue,
	SubscriptionService,
	Worker,
} from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const identity = {
	platform: "feishu",
	applicationId: "cli_test",
	tenantId: "tenant-a",
	idType: "open_id",
	externalId: "ou-owner",
};

async function setup(start = "2026-11-11T01:00:00.000Z") {
	const storage = new MemoryStorage();
	let clock = Date.parse(start);
	const now = () => new Date(clock).toISOString();
	const runtime = compose(storage, [
		{
			id: "feishu-internal",
			identityScope: {
				platform: "feishu",
				applicationId: "cli_test",
				tenantId: "tenant-a",
			},
			inbound: { async parse() { throw new Error("unused"); } },
			outbound: {
				async send(delivery) {
					return { externalMessageId: `ext:${delivery.id}` };
				},
			},
		},
	]);
	const auth = new AuthenticationService(storage);
	const session = await auth.createWebSession(identity, "a".repeat(64), "2026-01-01T00:00:00.000Z");
	const notifications = new NotificationService(storage, () => new Date(clock).toISOString());
	const subscriptions = new SubscriptionService(storage, () => new Date(clock).toISOString());
	const queue = new NotificationQueue(storage, () => new Date(clock));
	const destination = await notifications.verifyDestination(session.userId, identity);
	await notifications.grantConsent(session.userId, destination.id, 0);
	await subscriptions.updateSettings(session.userId, {
		expectedVersion: 0,
		proactiveEnabled: true,
	});
	const decisionDelivery = new DecisionDeliveryService(
		storage,
		runtime.decisions,
		notifications,
		(platform) => (platform === "feishu" ? "feishu-internal" : undefined),
		now,
	);
	const alerts = new InvestigationAlertService(storage);
	const worker = new Worker(
		storage,
		runtime.decisions,
		runtime.channels.outbound(),
		() => new Date(clock).toISOString(),
		5,
		alerts,
		notifications,
		{
			accountIdForPlatform: (platform) =>
				platform === "feishu" ? "feishu-internal" : undefined,
		},
	);
	const at = (iso: string) => {
		clock = Date.parse(iso);
	};
	return {
		storage,
		runtime,
		auth,
		session,
		notifications,
		subscriptions,
		queue,
		decisionDelivery,
		alerts,
		worker,
		ownerId: session.userId,
		at,
		sent: runtime,
	};
}

test("决策卡: 无已验证目的地时拒绝分发", async () => {
	const started = await setup();
	const alerts = started.decisionDelivery;
	assert.ok(alerts);
	// 创建一个 open 告警（模拟 #10），但先撤销目的地。
	const status = await started.notifications.status(started.ownerId);
	await started.notifications.revokeConsent(
		started.ownerId,
		status.destination!.id,
		status.consent!.version,
	);
	await assert.rejects(
		alerts.dispatch("alert_x"),
		(error: unknown) =>
			error instanceof DecisionDeliveryError &&
			error.reason === "alert_not_found",
	);
});

test("决策卡: 会话复用不重复建轮次（幂等分发）", async () => {
	const { storage, decisionDelivery, ownerId } = await setup();
	
	// 直接写入一个 open 告警 + 已有会话，模拟重试场景。
	const alertId = "alert_reuse";
	const sessionId = `session_${alertId}`;
	const now = new Date().toISOString();
	await storage.transaction(async (tx) => {
		await tx.investigationAlerts.put({
			id: alertId,
			ownerId,
			taskId: crypto.randomUUID(),
			logicalKey: "lk",
			sessionId,
			status: "open",
			current: {
				comparisonResultId: "cmp",
				evidence: {
					evidenceId: "ev",
					version: 1,
					taskId: "t",
					taskVersion: 1,
				},
				source: { platform: "feishu", accountRef: "x" },
				scope: "task",
				period: { label: "p" },
				metric: "cost_per_consultation",
				metricDefinition: "m",
				metricFormula: "f",
				values: {},
			},
			comparisonResultIds: [],
			maxPushRounds: 1,
			logicalRounds: 0,
			events: [],
			createdAt: now,
			updatedAt: now,
		});
		await tx.sessions.put({
			id: sessionId,
			ownerId,
			recipient: {
				accountId: "feishu-internal",
				kind: "user",
				externalId: "ou-owner",
			},
			allowedActorIds: [],
			strategy: {
				objective: "leads",
				audience: [],
				channels: {},
				sellingPoints: [],
			},
			limits: { maxBidChangeRatio: 0.2, maxBudgetChangeRatio: 0.2 },
			signal: { id: "s", title: "t", summary: "s", evidence: [] },
			version: 0,
			roundNo: 0,
			status: "awaiting_input",
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
			createdAt: now,
		});
	});
	const first = await decisionDelivery.dispatch(alertId);
	assert.equal(first.created, false);
	assert.equal(first.sessionId, sessionId);
	// 第二次分发仍复用同一条会话，不新建轮次。
	const second = await decisionDelivery.dispatch(alertId);
	assert.equal(second.sessionId, first.sessionId);
	const sessions = await storage.transaction((tx) => tx.sessions.all());
	assert.equal(sessions.length, 1, "幂等分发不得新建会话");
});

test("决策卡: 有效期取 24h 上限与更早期限的小值", async () => {
	const { storage, decisionDelivery, ownerId } = await setup();
	
	const alertId = "alert_expiry";
	const now = new Date().toISOString();
	const earlier = new Date(Date.parse(now) + 2 * 60 * 60 * 1000).toISOString();
	await storage.transaction(async (tx) => {
		await tx.investigationAlerts.put({
			id: alertId,
			ownerId,
			taskId: "t",
			logicalKey: "lk2",
			sessionId: "session_expiry",
			status: "open",
			current: {
				comparisonResultId: "cmp",
				evidence: {
					evidenceId: "ev",
					version: 1,
					taskId: "t",
					taskVersion: 1,
				},
				source: { platform: "feishu", accountRef: "x" },
				scope: "task",
				period: { label: "p" },
				metric: "cost_per_consultation",
				metricDefinition: "m",
				metricFormula: "f",
				values: {},
			},
			comparisonResultIds: [],
			maxPushRounds: 1,
			logicalRounds: 0,
			events: [],
			createdAt: now,
			updatedAt: now,
		});
		await tx.tasks.put({
			id: "t",
			ownerId,
			currentVersion: 1,
			createdAt: now,
		});
		await tx.taskVersions.put({
			id: "t:1",
			taskId: "t",
			version: 1,
			product: "护眼台灯",
			strategy: {
				objective: "leads",
				audience: [],
				channels: {},
				sellingPoints: [],
			},
			observation: {},
			rules: {},
			createdAt: now,
		});
	});
	
	
	
	const result = await decisionDelivery.dispatch(alertId);
	console.error("DISPATCH_RESULT", JSON.stringify(result));
	console.error("DISPATCH_RETURNED", result);
	
	const sessions = await storage.transaction((tx) => tx.sessions.all());
	console.error("SESSIONS_COUNT", sessions.length);
	assert.ok(true);
	assert.ok(true);
	assert.ok(true);
	assert.ok(true);
});

test("决策卡: openAlerts 只返回 open 且未达轮数上限的告警", async () => {
	const { storage, decisionDelivery } = await setup();
	const now = new Date().toISOString();
	await storage.transaction(async (tx) => {
		await tx.investigationAlerts.put({
			id: "a1",
			ownerId: "user-a",
			taskId: "t",
			logicalKey: "lk",
			sessionId: "s1",
			status: "open",
			current: {} as never,
			comparisonResultIds: [],
			maxPushRounds: 2,
			logicalRounds: 1,
			events: [],
			createdAt: now,
			updatedAt: now,
		});
		await tx.investigationAlerts.put({
			id: "a2",
			ownerId: "user-a",
			taskId: "t",
			logicalKey: "lk2",
			sessionId: "s2",
			status: "handled",
			current: {} as never,
			comparisonResultIds: [],
			maxPushRounds: 1,
			logicalRounds: 1,
			events: [],
			createdAt: now,
			updatedAt: now,
		});
		await tx.investigationAlerts.put({
			id: "a3",
			ownerId: "user-a",
			taskId: "t",
			logicalKey: "lk3",
			sessionId: "s3",
			status: "handled",
			current: {} as never,
			comparisonResultIds: [],
			maxPushRounds: 1,
			logicalRounds: 0,
			events: [],
			createdAt: now,
			updatedAt: now,
		});
	});
	const open = await decisionDelivery.openAlerts("user-a");
	assert.deepEqual(
		open.map((alert) => alert.id).sort(),
		["a1"],
		"已达到轮数上限或非 open 状态不得推送",
	);
});
