import assert from "node:assert/strict";
import test from "node:test";
import { estimateReview, findReviewHeader, isYuanColumn, reviewInputFromRow, suggestReviewColumns } from "../apps/console/src/views/adpulse/tasks/review-quick.ts";

test("quick review preserves missing values and zero without dividing by zero", () => {
	assert.deepEqual(estimateReview({ spend: "", consultations: "2" }, {}), {
		spendMinor: undefined, consultations: 2,
	});
	assert.deepEqual(estimateReview({ spend: "50", consultations: "0" }, {}), {
		spendMinor: 5000, consultations: 0,
	});
	assert.throws(() => estimateReview({ spend: "1.001", consultations: "2" }, {}), /两位小数/);
	assert.throws(() => estimateReview({ spend: "1", consultations: "2.5" }, {}), /整数/);
	for (const consultations of ["1.0000000000000001", "1e-400", "9007199254740992"]) {
		assert.throws(() => estimateReview({ spend: "1", consultations }, {}), /整数/);
	}
	assert.equal(estimateReview({ spend: "", consultations: "12.00" }, {}).consultations, 12);
});

test("quick review calculates rounded cost and compares exact amounts to a compatible limit", () => {
	const rules = { metricKey: "cost_per_consultation", currency: "CNY", unit: "分", alertThresholdMinor: 100 } as const;
	assert.deepEqual(estimateReview({ spend: "3.01", consultations: "0" }, rules), {
		spendMinor: 301, consultations: 0,
	});
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

test("spreadsheet mapping rejects explicit foreign currencies and yuan scales", () => {
	for (const title of [
		"spend_USD", "消耗（JPY）", "広告費（円）", "投放金额（单位：分）", "spend_cents",
		"花费（万元）", "花费（单位：千元）", "消耗（人民币分）",
	]) {
		assert.throws(() => reviewInputFromRow(["1500"], [title], { spend: "0", consultations: "" }), /单位/);
	}
	assert.throws(() => reviewInputFromRow(["1e-400"], ["咨询次数"], { spend: "", consultations: "0" }), /整数/);
	assert.equal(isYuanColumn("广告花费"), false);
	assert.equal(isYuanColumn("花费（元）"), true);
	assert.equal(isYuanColumn("花费（单位：人民币元）"), true);
});

test("spreadsheet mapping rejects English lead counts as consultations", () => {
	for (const title of ["Leads", "new_leads", "Lead Count"]) {
		assert.throws(() => reviewInputFromRow(["10"], [title], { spend: "", consultations: "0" }), /口径/);
	}
});

test("a separate currency column prevents treating foreign spend as yuan", () => {
	const header = ["Product Name", "Total Cost", "Currency Unit", "Consultations Count"];
	const columns = { spend: "1", consultations: "3" };
	assert.throws(
		() => reviewInputFromRow(["PetalBook Journal", "88.00", "USD", "2"], header, columns),
		/不是人民币元/,
	);
	assert.throws(
		() => reviewInputFromRow(["PetalBook Journal", "88.00", "CHF", "2"], header, columns),
		/不是人民币元/,
	);
	assert.deepEqual(reviewInputFromRow(["PetalBook Journal", "88.00", "USD", "2"], header, { ...columns, spend: "" }),
		{ spend: "", consultations: "2" });
	assert.deepEqual(reviewInputFromRow(["PetalBook Journal", "88.00", "CNY", "2"], header, columns),
		{ spend: "88.00", consultations: "2" });
	assert.equal(isYuanColumn("Total Cost (RMB)"), true);
});
