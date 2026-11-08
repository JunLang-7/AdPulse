import assert from "node:assert/strict";
import test from "node:test";
import type { components } from "../apps/console/src/generated/api.js";
import {
	readEvidenceCorrection,
	readEvidenceImport,
} from "../apps/console/src/views/adpulse/tasks/evidence-file.ts";

const taskRef = { taskId: "synthetic-task", taskVersion: 2 };
const record = {
	source: { platform: "synthetic-platform", accountRef: "account", reportRef: "report" },
	scope: { planRef: "plan", campaignRefs: [] },
	period: {
		startsAt: "2026-11-01T00:00:00+08:00",
		endsAt: "2026-11-02T00:00:00+08:00",
		timeZone: "Asia/Shanghai",
		completeness: "complete",
	},
	metricsContract: {
		spendMinor: { definition: "测试消耗", formula: "源值乘 100", sourceField: "spend" },
		consultations: { definition: "测试咨询", formula: "报表原值", sourceField: "consultations" },
	},
	currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
	attribution: { model: "测试口径" },
	callbackStatus: "unknown",
	rawValues: { spend: "0.00", consultations: null },
	values: { spendMinor: 0, consultations: null },
} satisfies components["schemas"]["EvidenceRecordInput"];
const report = { schemaVersion: 1, taskRef, records: [record] };
const jsonFile = (value: unknown) =>
	new File([JSON.stringify(value)], "report.json", { type: "application/json" });

test("report file import keeps source timezone, raw values and explicit zero", async () => {
	const loaded = await readEvidenceImport(
		new File(["\uFEFF", JSON.stringify(report)], "report.json"),
		taskRef,
	);
	assert.deepEqual(loaded, report);
	assert.deepEqual(await readEvidenceCorrection(jsonFile(record)), record);
});

test("report file import rejects a different task or version", async () => {
	for (const mismatchedRef of [
		{ ...taskRef, taskId: "different-task" },
		{ ...taskRef, taskVersion: 1 },
	]) {
		await assert.rejects(
			readEvidenceImport(jsonFile({ ...report, taskRef: mismatchedRef }), taskRef),
			/任务或版本不匹配/,
		);
	}
});

test("report file parsing rejects wrong shapes, invalid JSON and oversized files", async () => {
	await assert.rejects(
		readEvidenceImport(jsonFile({ ...report, records: [record, record, record] }), taskRef),
		/1 或 2 个区间/,
	);
	await assert.rejects(readEvidenceCorrection(jsonFile(report)), /单区间更正文件/);
	await assert.rejects(
		readEvidenceImport(new File(["not json"], "report.json"), taskRef),
		/无法识别文件内容/,
	);
	await assert.rejects(
		readEvidenceImport(new File([" ".repeat(256 * 1024 + 1)], "report.json"), taskRef),
		/256 KB/,
	);
});
