import assert from "node:assert/strict";
import test from "node:test";
import { estimateReview, findReviewHeader, reviewInputFromRow, suggestReviewColumns } from "../apps/console/src/views/adpulse/tasks/review-quick.ts";

test("quick review preserves missing values and zero without dividing by zero", () => {
	assert.deepEqual(estimateReview({ spend: "", consultations: "2" }, {}), {
		spendMinor: undefined, consultations: 2,
	});
	assert.deepEqual(estimateReview({ spend: "50", consultations: "0" }, {}), {
		spendMinor: 5000, consultations: 0,
	});
	assert.throws(() => estimateReview({ spend: "1.001", consultations: "2" }, {}), /两位小数/);
	assert.throws(() => estimateReview({ spend: "1", consultations: "2.5" }, {}), /整数/);
});

test("quick review calculates rounded cost and compares exact amounts to a compatible limit", () => {
	const rules = { metricKey: "cost_per_consultation", currency: "CNY", unit: "分", alertThresholdMinor: 100 } as const;
	assert.deepEqual(estimateReview({ spend: "3.01", consultations: "3" }, rules), {
		spendMinor: 301, consultations: 3, unitCostMinor: 100,
		limit: { minor: 100, belowMinimum: false, exceeded: true },
	});
	assert.deepEqual(estimateReview({ spend: "0", consultations: "3" }, { ...rules, currency: "USD" }), {
		spendMinor: 0, consultations: 3, unitCostMinor: 0,
	});
	assert.deepEqual(estimateReview({ spend: "3", consultations: "3" }, { ...rules, minimumConsultations: 5 }), {
		spendMinor: 300, consultations: 3, unitCostMinor: 100,
		limit: { minor: 100, belowMinimum: true, exceeded: false },
	});
});

test("spreadsheet mapping suggests only unique known columns and keeps the selected row's raw meaning", () => {
	const header = ["日期", "花费（元）", "咨询次数", "咨询数", "线索数", "消耗（分）"];
	assert.equal(findReviewHeader([["投放报告"], [null], header]), 2);
	assert.deepEqual(suggestReviewColumns(header), { spend: "1", consultations: "" });
	const row = ["2026-11-01", "￥1,200.50", null, "0", "16", "120050"];
	assert.deepEqual(reviewInputFromRow(row, header, { spend: "1", consultations: "2" }), {
		spend: "1200.50", consultations: "",
	});
	assert.deepEqual(reviewInputFromRow(row, header, { spend: "1", consultations: "3" }), {
		spend: "1200.50", consultations: "0",
	});
	assert.throws(() => reviewInputFromRow(row, header, { spend: "1", consultations: "4" }), /口径/);
	assert.throws(() => reviewInputFromRow(row, header, { spend: "5", consultations: "3" }), /单位/);
	assert.throws(() => reviewInputFromRow(row, header, { spend: "1", consultations: "1" }), /不同的列/);
});
