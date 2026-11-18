import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluateEvidenceComparison,
	placementSpec,
	placementTypes,
	type PlacementType,
} from "../packages/core/dist/index.js";
import type { EvidenceVersion } from "../packages/core/dist/index.js";

/**
 * 大规模合成数据：用确定性种子生成三种口径的多组报表，验证领域不变量。
 *
 * 这些数据全部是合成数字，不来自任何真实平台或真实账户。
 * 目的不是证明「指标选得对」（那是产品验证，需要真实用户），
 * 而是证明「一旦给定口径，系统的计算/拒绝/比较行为在各种数值下都一致」。
 */

// 固定种子 PRNG，保证 CI 可复现。
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_663 + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

const SOURCE = { platform: "synthetic-report", accountRef: "synthetic-account" };
const CURRENCY = { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 };

const period = (day: number) => ({
	startsAt: `2026-01-${String(day).padStart(2, "0")}T00:00:00+08:00`,
	endsAt: `2026-01-${String(day + 1).padStart(2, "0")}T00:00:00+08:00`,
	timeZone: "Asia/Shanghai",
	completeness: "complete" as const,
});

function report(
	type: PlacementType,
	values: Record<string, number | null>,
	day: number,
	version: number,
): EvidenceVersion {
	const spec = placementSpec(type);
	const metric = (sourceField: string) => ({
		definition: `合成口径 ${sourceField}`,
		formula: `合成报表字段 ${sourceField}`,
		sourceField,
	});
	return {
		id: `synthetic:${type}:${version}`,
		evidenceId: `synthetic-${type}`,
		ownerId: "synthetic-owner",
		taskId: "synthetic-task",
		taskVersion: 1,
		version,
		businessKey: `synthetic-${type}`,
		contentDigest: `synthetic-${version}`,
		placementType: type,
		scope: { planRef: "synthetic-plan", campaignRefs: ["synthetic-campaign"] },
		period: period(day),
		metricsContract: {
			[spec.spendKey]: metric(spec.spendKey),
			[spec.countKey]: metric(spec.countKey),
		},
		currency: CURRENCY,
		attribution: { model: "synthetic-attribution" },
		callbackStatus: "complete",
		values,
		createdAt: `2026-02-${String(day).padStart(2, "0")}T00:00:00.000Z`,
	};
}

function rulesFor(type: PlacementType, thresholdMinor: number) {
	return {
		placementType: type,
		metricKey: placementSpec(type).derivedKey,
		currency: "CNY",
		unit: "分",
		statWindowDays: 1,
		alertThresholdMinor: thresholdMinor,
		minimumSpendMinor: 0,
		minimumConsultations: 0,
	};
}

const boundaryValues: Array<[number, number]> = [
	[0, 0],
	[0, 1],
	[1, 0],
	[1, 1],
	[1, 2],
	[2, 1],
	[99, 1],
	[100, 100],
	[1_000_000, 1],
	[1, 1_000_000],
	[Number.MAX_SAFE_INTEGER - 1, 1],
];

test("三种口径 × 边界值：零分母不计算，非零结果方向正确", () => {
	let cases = 0;
	for (const type of placementTypes) {
		const spec = placementSpec(type);
		for (const [spend, count] of boundaryValues) {
			const current = report(type, { [spec.spendKey]: spend, [spec.countKey]: count }, 2, 1);
			const result = evaluateEvidenceComparison({
				current,
				currentSource: SOURCE,
				rules: rulesFor(type, 50),
			});
			cases++;
			if (count === 0) {
				assert.ok(
					result.reasons.some((item) => item.code === "ZERO_DENOMINATOR"),
					`${type} 零分母必须给出 ZERO_DENOMINATOR（spend=${spend}）`,
				);
				assert.equal(result.thresholdEvaluation.status, "not_evaluated");
			} else {
				const exceeded = BigInt(spend) > BigInt(50) * BigInt(count);
				assert.equal(
					result.thresholdEvaluation.status,
					exceeded ? "exceeded" : "not_exceeded",
					`${type} spend=${spend} count=${count} 阈值判断错误`,
				);
				assert.equal(result.thresholdEvaluation.metricKey, spec.derivedKey);
			}
		}
	}
	assert.equal(cases, placementTypes.length * boundaryValues.length);
});

test("固定种子随机 300 组：阈值判定与比率方向严格一致", () => {
	const random = rng(20261118);
	for (const type of placementTypes) {
		const spec = placementSpec(type);
		for (let index = 0; index < 300; index++) {
			const spend = Math.floor(random() * 1_000_000);
			const count = 1 + Math.floor(random() * 1_000);
			const threshold = Math.floor(random() * 5_000);
			const current = report(type, { [spec.spendKey]: spend, [spec.countKey]: count }, 2, 1);
			const result = evaluateEvidenceComparison({
				current,
				currentSource: SOURCE,
				rules: rulesFor(type, threshold),
			});
			const expected = BigInt(spend) > BigInt(threshold) * BigInt(count)
				? "exceeded"
				: "not_exceeded";
			assert.equal(
				result.thresholdEvaluation.status,
				expected,
				`${type} 第 ${index} 组：spend=${spend} count=${count} threshold=${threshold}`,
			);
		}
	}
});

test("可比性矩阵：只有同口径、同定义的相邻两期可比", () => {
	const types = [...placementTypes];
	for (const currentType of types) {
		for (const baselineType of types) {
			const currentSpec = placementSpec(currentType);
			const baselineSpec = placementSpec(baselineType);
			const current = report(
				currentType,
				{ [currentSpec.spendKey]: 200, [currentSpec.countKey]: 10 },
				2,
				1,
			);
			// 基线即使数值相同，只要口径不同也必须判不可比。
			const baseline = report(
				baselineType,
				{ [baselineSpec.spendKey]: 100, [baselineSpec.countKey]: 10 },
				1,
				1,
			);
			const result = evaluateEvidenceComparison({
				current,
				baseline,
				currentSource: SOURCE,
				baselineSource: SOURCE,
				rules: rulesFor(currentType, 50),
			});
			if (currentType === baselineType) {
				assert.equal(result.canComparePeriods, true, `${currentType} 同口径应可比`);
				assert.equal(result.status, "comparable");
			} else {
				assert.equal(result.canComparePeriods, false, `${currentType} vs ${baselineType} 不可比`);
				assert.equal(result.status, "incomparable");
				assert.ok(result.reasons.some((item) => item.code === "PLACEMENT_TYPE_MISMATCH"));
			}
		}
	}
});

test("缺结果与零结果：保留局限，不编造趋势", () => {
	const cases: Array<[PlacementType, Record<string, number | null>]> = [
		["paid_ads", { spendMinor: 100 }],
		["influencer", { feeMinor: 100 }],
		["seeding", { contentCostMinor: 100 }],
	];
	for (const [type, values] of cases) {
		const current = report(type, values, 2, 1);
		const result = evaluateEvidenceComparison({
			current,
			currentSource: SOURCE,
			rules: rulesFor(type, 50),
		});
		assert.ok(
			result.reasons.some((item) => item.code === "VALUE_MISSING"),
			`${type} 缺少结果指标应给出 VALUE_MISSING`,
		);
		assert.equal(result.thresholdEvaluation.status, "not_evaluated");
		assert.equal(result.comparisons.costPerConsultation, undefined);
	}
});

test("随机 90 组两期比较：方向由交叉相乘决定，不受浮点误差影响", () => {
	const random = rng(90210);
	for (const type of placementTypes) {
		const spec = placementSpec(type);
		for (let index = 0; index < 30; index++) {
			const baselineSpend = 1 + Math.floor(random() * 100_000);
			const baselineCount = 1 + Math.floor(random() * 1_000);
			const currentSpend = 1 + Math.floor(random() * 100_000);
			const currentCount = 1 + Math.floor(random() * 1_000);
			const baseline = report(
				type,
				{ [spec.spendKey]: baselineSpend, [spec.countKey]: baselineCount },
				1,
				1,
			);
			const current = report(
				type,
				{ [spec.spendKey]: currentSpend, [spec.countKey]: currentCount },
				2,
				1,
			);
			const result = evaluateEvidenceComparison({
				current,
				baseline,
				currentSource: SOURCE,
				baselineSource: SOURCE,
				rules: rulesFor(type, 1),
			});
			assert.equal(result.canComparePeriods, true);
			const cost = result.comparisons.costPerConsultation;
			assert.ok(cost, `${type} 第 ${index} 组应产出成本比较`);
			const oldCross = BigInt(baselineSpend) * BigInt(currentCount);
			const newCross = BigInt(currentSpend) * BigInt(baselineCount);
			const expected = newCross > oldCross
				? "increased"
				: newCross < oldCross
					? "decreased"
					: "unchanged";
			assert.equal(cost.direction, expected, `${type} 第 ${index} 组方向错误`);
		}
	}
});
