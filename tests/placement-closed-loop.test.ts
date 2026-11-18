import assert from "node:assert/strict";
import test from "node:test";
import {
	ComparisonService,
	EvidenceService,
	InvestigationAlertService,
	Orchestrator,
	TaskService,
	Worker,
	type EvidenceImportRecord,
	type TaskInput,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

/**
 * 纯本地合成闭环：建任务 → 导入达人报表 → 比较 → 生成告警 → 候选会话。
 *
 * 不需要飞书登录、不需要 session cookie、不访问任何真实平台。
 * 覆盖的是 scripts/demo.mjs 的业务链路，但数据是合成的，且使用达人合作口径。
 */

function influencerRules(): TaskInput["rules"] {
	return {
		placementType: "influencer",
		metricKey: "cost_per_engagement",
		metricDefinition: "单次互动成本",
		currency: "CNY",
		unit: "分",
		statWindowDays: 1,
		alertThresholdMinor: 100,
		minimumSpendMinor: 0,
		minimumConsultations: 0,
		handlingDeadlineHours: 24,
	};
}

function influencerTask(): TaskInput {
	return {
		product: "合成演示 - 新品试用",
		strategy: {
			objective: "验证达人合作的互动口径",
			audience: ["合成人群"],
			channels: { kol: { type: "influencer", budget: 500_000 } },
			sellingPoints: ["合成卖点"],
		},
		observation: {},
		rules: influencerRules(),
	};
}

function influencerReport(feeMinor: number, reportRef: string): EvidenceImportRecord {
	return {
		source: {
			platform: "synthetic-report",
			accountRef: "synthetic-kol-account",
			reportRef,
		},
		placementType: "influencer",
		scope: { planRef: "synthetic-plan", campaignRefs: ["synthetic-campaign"] },
		period: {
			startsAt: "2026-01-01T00:00:00+08:00",
			endsAt: "2026-01-02T00:00:00+08:00",
			timeZone: "Asia/Shanghai",
			completeness: "complete",
		},
		metricsContract: {
			feeMinor: {
				definition: "合成合作费用",
				formula: "合成报表费用换算为分",
				sourceField: "fee",
			},
			engagement: {
				definition: "合成互动量（点赞+收藏+评论）",
				formula: "合成报表互动字段",
				sourceField: "engagement",
			},
		},
		currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
		attribution: { model: "synthetic-impression", windowDays: 7 },
		callbackStatus: "complete",
		rawValues: { fee: String(feeMinor / 100), engagement: 10 },
		values: { feeMinor, engagement: 10 },
	};
}

test("达人合作：从任务到排查候选的完整合成闭环按互动口径运行", async () => {
	let clock = "2026-01-03T00:00:00.000Z";
	let id = 0;
	const storage = new MemoryStorage();
	const tasks = new TaskService(storage, () => clock, () => `task-${++id}`);
	const evidence = new EvidenceService(storage, () => clock);
	const comparisons = new ComparisonService(storage, () => clock, () => `cmp-${++id}`);
	const alerts = new InvestigationAlertService(storage, () => clock);
	const orchestrator = new Orchestrator(
		storage,
		{ async propose() { throw new Error("Web 告警不应调用策略引擎"); } },
		() => clock,
		() => `action-${++id}`,
	);
	const worker = new Worker(storage, orchestrator, new Map(), () => clock, 3, alerts);

	// 1) 建任务：策略渠道与规则都是达人合作口径。
	const task = await tasks.create("synthetic-owner", "demo-task", influencerTask());
	assert.equal(task.rules.placementType, "influencer");
	assert.equal(task.strategy.channels.kol?.type, "influencer");
	assert.equal(task.strategy.channels.kol?.bidCpc, undefined);

	// 2) 导入合成达人报表，费用 2000 分 / 互动 10 → 单次互动成本 200 分，超出 100 分提醒线。
	const [imported] = await evidence.import("synthetic-owner", "demo-evidence", {
		schemaVersion: 1,
		taskRef: { taskId: task.taskId, taskVersion: task.version },
		records: [influencerReport(2_000, "synthetic-report-1")],
	});
	assert.ok(imported);
	const detail = await evidence.get("synthetic-owner", imported.evidenceId);
	assert.equal(detail?.current.placementType, "influencer");
	assert.deepEqual(Object.keys(detail?.current.values ?? {}).sort(), [
		"engagement",
		"feeMinor",
	]);

	// 3) 比较：按互动口径产出结论，不叫「咨询成本」。
	const comparison = await comparisons.evaluate("synthetic-owner", "demo-compare", {
		current: { evidenceId: imported.evidenceId, version: imported.version },
	});
	assert.equal(comparison.placementType, "influencer");
	assert.equal(comparison.metricKeys?.derived, "cost_per_engagement");
	assert.equal(comparison.thresholdEvaluation.status, "exceeded");
	assert.equal(comparison.thresholdEvaluation.metricKey, "cost_per_engagement");

	// 4) 生成告警：告警快照带口径与归因局限。
	const alert = await alerts.evaluateComparison("synthetic-owner", comparison.id);
	assert.ok(alert);
	assert.equal(alert.status, "open");
	assert.equal(alert.current.metric, "cost_per_engagement");
	assert.equal(alert.current.placementType, "influencer");
	assert.match(alert.current.attributionNote ?? "", /互动量不等于咨询或成交/);

	// 5) worker 准备 Web 会话与候选，不调用策略引擎、不发 IM。
	assert.equal(await worker.runOnce(), true);
	const session = await storage.transaction((tx) => tx.sessions.get(alert.sessionId));
	assert.ok(session);
	assert.equal(session.deliveryMode, "web");
	assert.equal(session.recipient, undefined);
	assert.equal(await worker.runOnce(), true);
	const refreshed = await storage.transaction((tx) => tx.sessions.get(alert.sessionId));
	assert.equal(refreshed?.status, "awaiting_input");
	const rounds = await storage.transaction((tx) => tx.rounds.all());
	const round = rounds.find((item) => item.sessionId === alert.sessionId);
	assert.equal(round?.candidates.length, 3);
	const deliveries = await storage.transaction((tx) => tx.deliveries.all());
	assert.equal(deliveries.length, 0, "合成闭环不应产生任何 IM 投递");
});

test("付费广告与达人合作在同一合成owner下互不混淆", async () => {
	let clock = "2026-01-03T00:00:00.000Z";
	let id = 0;
	const storage = new MemoryStorage();
	const tasks = new TaskService(storage, () => clock, () => `task-${++id}`);
	const evidence = new EvidenceService(storage, () => clock);

	const paidTask = await tasks.create("synthetic-owner", "paid", {
		product: "合成 - 付费",
		strategy: {
			objective: "获取咨询",
			audience: [],
			sellingPoints: [],
			channels: { ads: { type: "paid_ads" } },
		},
		observation: {},
		rules: {
			placementType: "paid_ads",
			metricKey: "cost_per_consultation",
			currency: "CNY",
			unit: "分",
		},
	});
	const kolTask = await tasks.create("synthetic-owner", "kol", influencerTask());

	const base = influencerReport(2_000, "shared-ref");
	const [paidImport] = await evidence.import("synthetic-owner", "paid-ev", {
		schemaVersion: 1,
		taskRef: { taskId: paidTask.taskId, taskVersion: 1 },
		records: [{
			...base,
			placementType: "paid_ads",
			metricsContract: {
				spendMinor: base.metricsContract.feeMinor!,
				consultations: base.metricsContract.engagement!,
			},
			values: { spendMinor: 1_000, consultations: 5 },
		}],
	});
	const [kolImport] = await evidence.import("synthetic-owner", "kol-ev", {
		schemaVersion: 1,
		taskRef: { taskId: kolTask.taskId, taskVersion: 1 },
		records: [base],
	});
	assert.ok(paidImport && kolImport);
	assert.notEqual(paidImport.evidenceId, kolImport.evidenceId);

	const paidDetail = await evidence.get("synthetic-owner", paidImport.evidenceId);
	const kolDetail = await evidence.get("synthetic-owner", kolImport.evidenceId);
	assert.equal(paidDetail?.current.placementType, "paid_ads");
	assert.equal(kolDetail?.current.placementType, "influencer");
});
