import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	EvidenceService,
	EvidenceValidationError,
	TaskService,
	applyChanges,
	evaluateEvidenceComparison,
	isMetricKeyForPlacement,
	normalizePlacementType,
	placementSpec,
	placementTypes,
	validatePlacementMetricKeys,
	validateStrategy,
} from "../packages/core/dist/index.js";
import type {
	EvidenceVersion,
	TaskInput,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

const limits = { maxBudgetChangeRatio: 0.5, maxBidChangeRatio: 0.5 };
const strategy = (channel: Record<string, unknown> = {}) => ({
	objective: "获取咨询",
	audience: ["山东企业"],
	channels: { ads: channel },
	sellingPoints: [] as string[],
});

const metric = (sourceField: string) => ({
	definition: `${sourceField} 的统计定义`,
	formula: `报表 ${sourceField}`,
	sourceField,
});

function makeVersion(
	placementType: "paid_ads" | "influencer" | "seeding",
	overrides: Partial<EvidenceVersion> = {},
): EvidenceVersion {
	const spec = placementSpec(placementType);
	return {
		id: "ev:1",
		evidenceId: "ev-1",
		ownerId: "owner",
		taskId: "task-1",
		taskVersion: 1,
		version: 1,
		businessKey: "key-1",
		contentDigest: "digest-1",
		placementType,
		scope: { planRef: "plan-1", campaignRefs: ["campaign-1"] },
		period: {
			startsAt: "2026-01-01T00:00:00+08:00",
			endsAt: "2026-01-02T00:00:00+08:00",
			timeZone: "Asia/Shanghai",
			completeness: "complete",
		},
		metricsContract: {
			[spec.spendKey]: metric(spec.spendKey),
			[spec.countKey]: metric(spec.countKey),
		},
		currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
		attribution: { model: "click", windowDays: 7 },
		callbackStatus: "complete",
		values: { [spec.spendKey]: 2_000, [spec.countKey]: 10 },
		createdAt: "2026-01-02T00:00:00.000Z",
		...overrides,
	};
}

const source = { platform: "web-report", accountRef: "account-1" };
const rulesFor = (placementType: "paid_ads" | "influencer" | "seeding") => ({
	placementType,
	metricKey: placementSpec(placementType).derivedKey,
	currency: "CNY",
	unit: "分",
	statWindowDays: 1,
	alertThresholdMinor: 100,
	minimumSpendMinor: 0,
	minimumConsultations: 0,
});

test("投放方式口径：三种类型、缺省归一与非法值拒绝", () => {
	assert.deepEqual([...placementTypes], ["paid_ads", "influencer", "seeding"]);
	assert.equal(normalizePlacementType(undefined), "paid_ads");
	assert.equal(normalizePlacementType("seeding"), "seeding");
	assert.throws(() => normalizePlacementType("unknown"), /invalid placement type/);
	assert.equal(placementSpec("paid_ads").spendKey, "spendMinor");
	assert.equal(placementSpec("influencer").spendKey, "feeMinor");
	assert.equal(placementSpec("seeding").spendKey, "contentCostMinor");
	assert.equal(isMetricKeyForPlacement("cost_per_consultation", "paid_ads"), true);
	assert.equal(isMetricKeyForPlacement("cost_per_consultation", "influencer"), false);
	assert.equal(isMetricKeyForPlacement("cost_per_engagement", "seeding"), true);
});

test("不同投放方式使用不同指标键，且不能混用", () => {
	assert.deepEqual(validatePlacementMetricKeys("influencer", ["feeMinor", "engagement"]), ["feeMinor", "engagement"]);
	// 允许缺一个键：证据本来就允许值缺失，比较引擎会要求补证。
	assert.deepEqual(validatePlacementMetricKeys("influencer", ["feeMinor"]), ["feeMinor", "engagement"]);
	assert.throws(() => validatePlacementMetricKeys("influencer", ["spendMinor"]), /invalid placement metrics/);
	assert.throws(() => validatePlacementMetricKeys("paid_ads", ["engagement"]), /invalid placement metrics/);
	assert.throws(() => validatePlacementMetricKeys("seeding", ["feeMinor", "engagement"]), /invalid placement metrics/);
});

test("策略：旧渠道无类型按付费广告读取，达人/种草没有出价旋钮", () => {
	assert.doesNotThrow(() => validateStrategy(strategy(), limits));
	assert.doesNotThrow(() => validateStrategy(strategy({ type: "influencer", budget: 100 }), limits));
	assert.throws(
		() => validateStrategy(strategy({ type: "influencer", bidCpc: 1.2 }), limits),
		/bidCpc is not available/,
	);
	assert.throws(
		() => validateStrategy(strategy({ type: "seeding", bidCpc: 1.2 }), limits),
		/bidCpc is not available/,
	);
	assert.throws(
		() => validateStrategy(strategy({ type: "unknown" }), limits),
		/invalid placement type/,
	);
});

test("策略变更：达人渠道可以改预算，出价变更在提交时再次被拒", () => {
	const base = strategy({ type: "influencer", budget: 100 });
	const next = applyChanges(base, [
		{ kind: "budget", channelId: "ads", from: 100, to: 120 },
	], limits);
	assert.equal(next.channels.ads?.budget, 120);
	assert.throws(
		() => applyChanges(base, [
			{ kind: "bidCpc", channelId: "ads", from: 0, to: 1 },
		], limits),
		/bidCpc is not available/,
	);
});

test("比较引擎：达人合作按单次互动成本判定，不换算成咨询成本", () => {
	const current = makeVersion("influencer");
	const result = evaluateEvidenceComparison({
		current,
		currentSource: source,
		rules: rulesFor("influencer"),
	});
	assert.equal(result.placementType, "influencer");
	assert.equal(result.metricKeys.derived, "cost_per_engagement");
	assert.equal(result.metricKeys.spend, "feeMinor");
	assert.equal(result.canEvaluateCurrentThreshold, true);
	assert.equal(result.thresholdEvaluation.status, "exceeded");
	assert.equal(result.thresholdEvaluation.metricKey, "cost_per_engagement");
	assert.equal(result.thresholdEvaluation.value?.numeratorMinor, 2_000);
});

test("比较引擎：内容种草按自己的口径判定", () => {
	const result = evaluateEvidenceComparison({
		current: makeVersion("seeding"),
		currentSource: source,
		rules: rulesFor("seeding"),
	});
	assert.equal(result.metricKeys.spend, "contentCostMinor");
	assert.equal(result.thresholdEvaluation.metricKey, "cost_per_engagement");
	assert.equal(result.thresholdEvaluation.status, "exceeded");
});

test("比较引擎：任务规则口径与证据不一致时拒绝阈值判定", () => {
	const result = evaluateEvidenceComparison({
		current: makeVersion("influencer"),
		currentSource: source,
		rules: rulesFor("paid_ads"),
	});
	assert.ok(result.reasons.some((item) => item.code === "RULE_PLACEMENT_MISMATCH"));
	assert.ok(result.reasons.some((item) => item.code === "RULE_METRIC_UNSUPPORTED"));
	assert.equal(result.canEvaluateCurrentThreshold, false);
	assert.equal(result.thresholdEvaluation.status, "not_evaluated");
});

test("比较引擎：不同投放方式的两期证据不可比", () => {
	const baseline = makeVersion("paid_ads", {
		id: "ev:0",
		evidenceId: "ev-0",
		version: 1,
		period: {
			startsAt: "2025-12-31T00:00:00+08:00",
			endsAt: "2026-01-01T00:00:00+08:00",
			timeZone: "Asia/Shanghai",
			completeness: "complete",
		},
	});
	const result = evaluateEvidenceComparison({
		current: makeVersion("influencer"),
		baseline,
		currentSource: source,
		baselineSource: source,
		rules: rulesFor("paid_ads"),
	});
	assert.ok(result.reasons.some((item) => item.code === "PLACEMENT_TYPE_MISMATCH"));
	assert.equal(result.status, "incomparable");
	assert.equal(result.canComparePeriods, false);
	assert.equal(result.comparisons.costPerConsultation, undefined);
});

const taskInput = (): TaskInput => ({
	product: "产品 A",
	strategy: {
		objective: "获取咨询",
		audience: ["山东企业"],
		channels: { ads: { type: "influencer" } },
		sellingPoints: [],
	},
	observation: {},
	rules: rulesFor("influencer"),
});

const baseRecord = () => ({
	source: { platform: "web-report", accountRef: "account-1", reportRef: "report-1" },
	scope: { planRef: "plan-1", campaignRefs: ["campaign-1"] },
	period: {
		startsAt: "2026-01-01T00:00:00+08:00",
		endsAt: "2026-01-02T00:00:00+08:00",
		timeZone: "Asia/Shanghai",
		completeness: "complete" as const,
	},
	currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
	attribution: { model: "click", windowDays: 7 },
	callbackStatus: "complete" as const,
	rawValues: { fee: "20.00", engagement: 10 },
});

async function setup() {
	const storage = new MemoryStorage();
	const now = () => "2026-01-02T00:00:00.000Z";
	const tasks = new TaskService(storage, now, () => "task-1");
	const task = await tasks.create("owner", "task-key", taskInput());
	const evidence = new EvidenceService(storage, now);
	return { task, evidence };
}

test("证据导入：达人合作使用自己的指标键并保存口径", async () => {
	const { task, evidence } = await setup();
	const spec = placementSpec("influencer");
	const result = await evidence.import("owner", "import-1", {
		schemaVersion: 1,
		taskRef: { taskId: task.taskId, taskVersion: task.version },
		records: [{
			...baseRecord(),
			placementType: "influencer",
			metricsContract: {
				[spec.spendKey]: metric("fee"),
				[spec.countKey]: metric("engagement"),
			},
			values: { [spec.spendKey]: 2_000, [spec.countKey]: 10 },
		}],
	});
	assert.equal(result[0]?.status, "created");
	const detail = await evidence.get("owner", result[0]!.evidenceId);
	assert.equal(detail?.current.placementType, "influencer");
	assert.equal(detail?.current.values[spec.spendKey], 2_000);
});

test("证据导入：旧证据无口径字段按付费广告读取，无需迁移", async () => {
	const { task, evidence } = await setup();
	const result = await evidence.import("owner", "import-legacy", {
		schemaVersion: 1,
		taskRef: { taskId: task.taskId, taskVersion: task.version },
		records: [{
			...baseRecord(),
			metricsContract: {
				spendMinor: metric("spend"),
				consultations: metric("consultations"),
			},
			values: { spendMinor: 100 },
		}],
	});
	const detail = await evidence.get("owner", result[0]!.evidenceId);
	assert.equal(detail?.current.placementType, "paid_ads");
});

test("证据导入：混用不同口径的指标键被拒绝", async () => {
	const { task, evidence } = await setup();
	await assert.rejects(
		() => evidence.import("owner", "import-mixed", {
			schemaVersion: 1,
			taskRef: { taskId: task.taskId, taskVersion: task.version },
			records: [{
				...baseRecord(),
				placementType: "influencer",
				metricsContract: {
					feeMinor: metric("fee"),
					engagement: metric("engagement"),
				},
				values: { spendMinor: 100, engagement: 10 },
			}],
		}),
		EvidenceValidationError,
	);
});

test("证据导入：非法投放方式与缺一个指标键的处理", async () => {
	const { task, evidence } = await setup();
	await assert.rejects(
		() => evidence.import("owner", "import-bad-type", {
			schemaVersion: 1,
			taskRef: { taskId: task.taskId, taskVersion: task.version },
			records: [{
				...baseRecord(),
				placementType: "unknown" as "influencer",
				metricsContract: { feeMinor: metric("fee"), engagement: metric("engagement") },
				values: { feeMinor: 100, engagement: 10 },
			}],
		}),
		EvidenceValidationError,
	);
	// 缺一个键仍可导入：值缺失由比较引擎标为待补证，不在导入时编造数值。
	const partial = await evidence.import("owner", "import-partial", {
		schemaVersion: 1,
		taskRef: { taskId: task.taskId, taskVersion: task.version },
		records: [{
			...baseRecord(),
			placementType: "seeding",
			metricsContract: {
				contentCostMinor: metric("contentCost"),
				engagement: metric("engagement"),
			},
			values: { contentCostMinor: 300 },
		}],
	});
	assert.equal(partial[0]?.status, "created");
});


/**
 * 旧库里的证据是用「不含 placementType」的内容算指纹的。
 * 这里独立复算一遍旧算法，确保升级后重新导入同一份付费广告报表仍然是「复用」，
 * 而不是被判成内容冲突、也不是重新生成一条重复证据。
 */
const canonicalJson = (value: unknown): string =>
	JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.keys(item)
					.sort()
					.reduce<Record<string, unknown>>((result, child) => {
						result[child] = (item as Record<string, unknown>)[child];
						return result;
					}, {})
			: item,
	);
const sha = (value: unknown): string =>
	createHash("sha256").update(canonicalJson(value)).digest("hex");

type LegacyRecord = ReturnType<typeof baseRecord> & {
	metricsContract: Record<string, { definition: string; formula: string; sourceField: string }>;
	values: Record<string, number | null>;
	placementType?: "paid_ads" | "influencer" | "seeding";
};

function legacyIdentity(ownerId: string, taskRef: { taskId: string; taskVersion: number }, record: LegacyRecord) {
	return sha({
		ownerId,
		taskRef,
		platform: record.source.platform,
		accountRef: record.source.accountRef,
		scope: { planRef: record.scope.planRef, campaignRefs: [...record.scope.campaignRefs].sort() },
		period: {
			startsAt: new Date(record.period.startsAt).toISOString(),
			endsAt: new Date(record.period.endsAt).toISOString(),
			timeZone: record.period.timeZone,
		},
	});
}

function legacyContent(record: LegacyRecord) {
	return {
		scope: { planRef: record.scope.planRef, campaignRefs: [...record.scope.campaignRefs].sort() },
		period: {
			startsAt: new Date(record.period.startsAt).toISOString(),
			endsAt: new Date(record.period.endsAt).toISOString(),
			timeZone: record.period.timeZone,
			completeness: record.period.completeness,
		},
		metricsContract: record.metricsContract,
		currency: record.currency,
		attribution: record.attribution,
		callbackStatus: record.callbackStatus,
		values: record.values,
	};
}

test("兼容：付费广告证据的身份与指纹和升级前一致，重复导入仍是复用", async () => {
	const { task, evidence } = await setup();
	const spec = placementSpec("paid_ads");
	const record = {
		...baseRecord(),
		metricsContract: {
			[spec.spendKey]: metric("spend"),
			[spec.countKey]: metric("consultations"),
		},
		values: { [spec.spendKey]: 1_000, [spec.countKey]: 10 },
	};
	const taskRef = { taskId: task.taskId, taskVersion: task.version };
	const first = await evidence.import("owner", "legacy-1", { schemaVersion: 1, taskRef, records: [record] });
	const detail = await evidence.get("owner", first[0]!.evidenceId);
	assert.equal(detail?.current.businessKey, legacyIdentity("owner", taskRef, record));
	assert.equal(detail?.current.contentDigest, sha(legacyContent(record)));
	// 换一个幂等键重放同一份报表：命中已存在的证据，状态为复用。
	const replay = await evidence.import("owner", "legacy-2", { schemaVersion: 1, taskRef, records: [record] });
	assert.equal(replay[0]?.status, "reused");
	assert.equal(replay[0]?.evidenceId, first[0]?.evidenceId);
});

test("兼容：同账号同区间的付费广告与达人合作是两条证据，互不覆盖", async () => {
	const { task, evidence } = await setup();
	const taskRef = { taskId: task.taskId, taskVersion: task.version };
	const paid = placementSpec("paid_ads");
	const influencer = placementSpec("influencer");
	const paidRecord: LegacyRecord = {
		...baseRecord(),
		metricsContract: {
			[paid.spendKey]: metric("spend"),
			[paid.countKey]: metric("consultations"),
		},
		values: { [paid.spendKey]: 1_000, [paid.countKey]: 10 },
	};
	const influencerRecord: LegacyRecord = {
		...baseRecord(),
		placementType: "influencer",
		metricsContract: {
			[influencer.spendKey]: metric("fee"),
			[influencer.countKey]: metric("engagement"),
		},
		values: { [influencer.spendKey]: 2_000, [influencer.countKey]: 20 },
	};
	const first = await evidence.import("owner", "mix-1", { schemaVersion: 1, taskRef, records: [paidRecord] });
	const second = await evidence.import("owner", "mix-2", { schemaVersion: 1, taskRef, records: [influencerRecord] });
	assert.equal(second[0]?.status, "created");
	assert.notEqual(second[0]?.evidenceId, first[0]?.evidenceId);
	const list = await evidence.listForTask("owner", task.taskId);
	assert.equal(list.length, 2);
	assert.deepEqual(new Set(list.map((item) => item.placementType)), new Set(["paid_ads", "influencer"]));
});
