import assert from "node:assert/strict";
import test from "node:test";
import {
	applyChanges,
	isMetricKeyForPlacement,
	normalizePlacementType,
	validatePlacementMetricKeys,
	validateStrategy,
} from "../packages/core/dist/index.js";

/**
 * 审核时用的对抗性输入：畸形类型值、原型污染键、重复/跨口径键。
 * 这些不是正常业务流程会产生的输入，但一旦边界被绕过，后果是「静默降级」
 * 或「把不同口径的指标混在一起算」，所以固定成回归测试。
 */

const limits = { maxBudgetChangeRatio: 0.5, maxBidChangeRatio: 0.5 };
const strategy = (channel: Record<string, unknown>) => ({
	objective: "目标",
	audience: [] as string[],
	sellingPoints: [] as string[],
	channels: { ch: channel },
});

test("畸形投放方式值全部拒绝，不静默降级为付费广告", () => {
	const badValues: unknown[] = [
		"",
		"PAID_ADS",
		"paid_ads ",
		"paid_ads\u0000",
		1,
		0,
		{},
		[],
		true,
		false,
		"__proto__",
		"constructor",
		"toString",
		"paid_ads\u0000influencer",
	];
	for (const value of badValues)
		assert.throws(
			() => normalizePlacementType(value),
			/invalid placement type/,
			`应当拒绝 ${JSON.stringify(value)}`,
		);
});

test("缺省值按付费广告读取，兼容旧数据", () => {
	assert.equal(normalizePlacementType(undefined), "paid_ads");
	assert.equal(normalizePlacementType(null), "paid_ads");
});

test("指标键校验拒绝原型污染、重复键、跨口径键、空键", () => {
	assert.throws(() =>
		validatePlacementMetricKeys("influencer", ["feeMinor", "__proto__"]));
	assert.throws(() =>
		validatePlacementMetricKeys("paid_ads", ["spendMinor", "constructor"]));
	assert.throws(() =>
		validatePlacementMetricKeys("influencer", ["feeMinor", "feeMinor"]));
	assert.throws(() =>
		validatePlacementMetricKeys("paid_ads", ["spendMinor", "engagement"]));
	assert.throws(() =>
		validatePlacementMetricKeys("seeding", ["feeMinor", "engagement"]));
	assert.throws(() =>
		validatePlacementMetricKeys("seeding", ["contentCostMinor", ""]));
});

test("指标键校验允许缺键：证据可以留空等待补证", () => {
	assert.doesNotThrow(() => validatePlacementMetricKeys("seeding", []));
	assert.doesNotThrow(() =>
		validatePlacementMetricKeys("seeding", ["contentCostMinor"]));
	assert.doesNotThrow(() =>
		validatePlacementMetricKeys("paid_ads", ["consultations"]));
});

test("派生成本键与投放方式严格对应", () => {
	assert.equal(isMetricKeyForPlacement("cost_per_consultation", "paid_ads"), true);
	assert.equal(isMetricKeyForPlacement("cost_per_engagement", "paid_ads"), false);
	assert.equal(isMetricKeyForPlacement("cost_per_engagement", "influencer"), true);
	assert.equal(isMetricKeyForPlacement("cost_per_engagement", "seeding"), true);
	assert.equal(isMetricKeyForPlacement("toString", "paid_ads"), false);
	assert.equal(isMetricKeyForPlacement("__proto__", "seeding"), false);
	assert.equal(isMetricKeyForPlacement("constructor", "influencer"), false);
});

test("策略：运行时畸形 type 与出价旋钮均被拒", () => {
	assert.throws(() => validateStrategy(strategy({ type: {} }), limits));
	assert.throws(() => validateStrategy(strategy({ type: 1 }), limits));
	assert.throws(() => validateStrategy(strategy({ type: [] }), limits));
	assert.throws(() =>
		validateStrategy(strategy({ type: "influencer", bidCpc: 1 }), limits));
	assert.throws(() =>
		validateStrategy(strategy({ type: "seeding", bidCpc: 1 }), limits));
	assert.doesNotThrow(() =>
		validateStrategy(strategy({ type: "paid_ads", bidCpc: 1 }), limits));
	assert.doesNotThrow(() =>
		validateStrategy(strategy({ bidCpc: 1 }), limits));
});

test("策略变更：达人/种草的出价在冻结候选阶段再次被拒", () => {
	const influencer = strategy({ type: "influencer", budget: 100 });
	assert.throws(
		() => applyChanges(influencer, [
			{ kind: "bidCpc", channelId: "ch", from: 0, to: 1 },
		], limits),
		/bidCpc is not available/,
	);
	// 即使策略本身带非法出价，空变更也要先过 validateStrategy，不能放行。
	assert.throws(
		() => applyChanges(strategy({ type: "seeding", bidCpc: 99 }), [], limits),
		/bidCpc is not available/,
	);
});

test("预算/开关变更对三类投放方式都可用", () => {
	for (const type of ["paid_ads", "influencer", "seeding"] as const) {
		const next = applyChanges(strategy({ type, budget: 100 }), [
			{ kind: "budget", channelId: "ch", from: 100, to: 110 },
		], limits);
		assert.equal(next.channels.ch.budget, 110);
		const toggled = applyChanges(strategy({ type, enabled: true }), [
			{ kind: "enabled", channelId: "ch", from: true, to: false },
		], limits);
		assert.equal(toggled.channels.ch.enabled, false);
	}
});
