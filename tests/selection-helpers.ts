import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
	AuthenticationService, ComparisonService, EvidenceService, InvestigationAlertService,
	MarketEventService, NotificationService, SubscriptionService, TaskService,
	type EvidenceImportRecord, type MarketEventInput, type Storage,
} from "../packages/core/dist/index.js";
import { eventInput } from "./market-event-fixtures.ts";

export const selectionEvidence = (spendMinor = 2000): EvidenceImportRecord => ({
	source: { platform: "synthetic-report", accountRef: "synthetic-account", reportRef: "synthetic-report-1" },
	scope: { planRef: "plan-1", campaignRefs: ["campaign-1"] },
	period: { startsAt: "2026-11-14T00:00:00+08:00", endsAt: "2026-11-15T00:00:00+08:00", timeZone: "Asia/Shanghai", completeness: "complete" },
	metricsContract: {
		spendMinor: { definition: "消耗", formula: "金额换算为分", sourceField: "spend" },
		consultations: { definition: "咨询数", formula: "咨询数", sourceField: "consultations" },
	},
	currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
	attribution: { model: "click", windowDays: 7 }, callbackStatus: "complete",
	rawValues: { spend: String(spendMinor), consultations: 10 }, values: { spendMinor, consultations: 10 },
});

export async function selectionFixture(storage: Storage) {
	let now = "2026-11-16T00:00:00.000Z";
	const clock = () => now;
	const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() };
	const auth = new AuthenticationService(storage);
	const session = await auth.createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), now);
	const owner = session.userId;
	const tasks = new TaskService(storage, clock);
	const task = await tasks.create(owner, randomUUID(), {
		product: "【模拟】产品 A", strategy: { objective: "咨询", audience: [], channels: { ads: {} }, sellingPoints: [] },
		observation: {}, rules: { metricKey: "cost_per_consultation", metricDefinition: "单次咨询成本", currency: "CNY", unit: "分", statWindowDays: 1, alertThresholdMinor: 100, minimumSpendMinor: 0, minimumConsultations: 0, maxPushRounds: 3 },
	});
	const subscriptions = new SubscriptionService(storage, clock);
	let view = await subscriptions.addTarget(owner, { expectedVersion: 0, kind: "task", refId: task.taskId, categories: ["effect"], scope: "task_only" });
	view = await subscriptions.updateSettings(owner, { expectedVersion: view.settings.version, proactiveEnabled: true });
	const notifications = new NotificationService(storage, clock);
	const destination = await notifications.verifyDestination(owner, identity);
	await notifications.grantConsent(owner, destination.id, 0);
	now = "2026-11-16T00:01:00.000Z";
	const evidence = new EvidenceService(storage, clock);
	const imported = await evidence.import(owner, randomUUID(), { schemaVersion: 1, taskRef: { taskId: task.taskId, taskVersion: 1 }, records: [selectionEvidence()] });
	assert.ok(imported[0]);
	const comparisons = new ComparisonService(storage, clock);
	const alerts = new InvestigationAlertService(storage, clock);
	const compare = (version = 1) => comparisons.evaluate(owner, randomUUID(), { current: { evidenceId: imported[0]!.evidenceId, version } });
	const comparison = await compare();
	return { storage, owner, task, evidence, comparisons, alerts, subscriptions, notifications, auth, identity, destination, comparison, compare, clock,
		setTime(value: string) { now = value; },
		async evaluate() { return alerts.evaluateComparison(owner, comparison.id); },
	};
}

/** #112 第二阶段：以本人品牌关注 + 明确事件主体为起点的筛选夹具。 */
export async function eventSelectionFixture(storage: Storage) {
	let now = "2026-11-16T00:00:00.000Z";
	const clock = () => now;
	const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() };
	const auth = new AuthenticationService(storage);
	const session = await auth.createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), now);
	const owner = session.userId;
	const tasks = new TaskService(storage, clock);
	const task = await tasks.create(owner, randomUUID(), {
		product: "【模拟】产品 A", strategy: { objective: "咨询", audience: [], channels: { ads: {} }, sellingPoints: [] },
		observation: {}, rules: { metricKey: "cost_per_consultation", metricDefinition: "单次咨询成本", currency: "CNY", unit: "分", statWindowDays: 1, alertThresholdMinor: 100, minimumSpendMinor: 0, minimumConsultations: 0, maxPushRounds: 3 },
	});
	const subscriptions = new SubscriptionService(storage, clock);
	let view = await subscriptions.addTarget(owner, {
		expectedVersion: 0, kind: "brand", label: "测试品牌", categories: ["event"], scope: "include_general",
	});
	view = await subscriptions.updateSettings(owner, { expectedVersion: view.settings.version, proactiveEnabled: true });
	const notifications = new NotificationService(storage, clock);
	const destination = await notifications.verifyDestination(owner, identity);
	await notifications.grantConsent(owner, destination.id, 0);
	now = "2026-11-16T00:01:00.000Z";
	const events = new MarketEventService(storage, clock);
	let operations = 0;
	return {
		storage, owner, task, subscriptions, notifications, events, destination, identity, clock,
		view: () => view,
		setTime(value: string) { now = value; },
		async addTarget(input: { kind: "task" | "brand" | "competitor"; refId?: string; label?: string; categories: string[]; scope: "task_only" | "include_general" }) {
			view = await subscriptions.addTarget(owner, {
				expectedVersion: view.settings.version, categories: input.categories, scope: input.scope,
				kind: input.kind, ...(input.refId ? { refId: input.refId } : {}), ...(input.label ? { label: input.label } : {}),
			});
			return view;
		},
		create(input: Partial<MarketEventInput> = {}, key = `event-${operations++}`) {
			return events.create(owner, key, { ...eventInput(), ...input });
		},
		revise(eventId: string, expectedVersion: number, input: Partial<MarketEventInput>, reason = "合成修订", key = `revise-${operations++}`) {
			return events.revise(owner, eventId, key, expectedVersion, { ...eventInput(), ...input }, reason);
		},
	};
}
