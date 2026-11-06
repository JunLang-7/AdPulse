import assert from "node:assert/strict";
import test from "node:test";
import {
	EvidenceConflictError,
	EvidenceService,
	EvidenceValidationError,
	TaskService,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

const taskInput = () => ({
	product: "产品 A",
	strategy: {
		objective: "获取咨询",
		audience: ["山东企业"],
		channels: { ads: {} },
		sellingPoints: [],
	},
	observation: { scope: "山东地区" },
	rules: { currency: "CNY", unit: "分", metricDefinition: "消耗与咨询" },
});

const record = (overrides: Record<string, unknown> = {}) => ({
	source: {
		platform: "web-report",
		accountRef: "account-1",
		reportRef: "report-1",
	},
	scope: { planRef: "plan-1", campaignRefs: ["campaign-1"] },
	period: {
		startsAt: "2026-01-01T00:00:00+08:00",
		endsAt: "2026-01-02T00:00:00+08:00",
		timeZone: "Asia/Shanghai",
		completeness: "complete" as const,
	},
	metricsContract: {
		spendMinor: {
			definition: "消耗金额",
			formula: "原始消耗乘以最小单位系数",
			sourceField: "spend",
		},
		consultations: {
			definition: "咨询数",
			formula: "报表咨询数",
			sourceField: "consultations",
		},
	},
	currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
	attribution: { model: "click", windowDays: 7 },
	callbackStatus: "complete" as const,
	rawValues: { spend: "0.00", consultations: null },
	values: { spendMinor: 0 },
	...overrides,
});

async function setup() {
	const storage = new MemoryStorage();
	const tasks = new TaskService(
		storage,
		() => "2026-01-01T00:00:00.000Z",
		() => "task-1",
	);
	const task = await tasks.create("owner", "task-key", taskInput());
	const evidence = new EvidenceService(
		storage,
		() => "2026-01-02T00:00:00.000Z",
	);
	return { storage, task, evidence };
}

test("evidence import preserves unknown, source null and zero; retries and cross-key duplicates reuse", async () => {
	const { task, evidence } = await setup();
	const input = {
		schemaVersion: 1 as const,
		taskRef: { taskId: task.taskId, taskVersion: 1 },
		records: [record()],
	};
	const [created] = await evidence.import("owner", "import-key-1", input);
	assert.equal(created?.status, "created");
	assert.ok(created);
	assert.deepEqual(await evidence.import("owner", "import-key-1", input), [
		created,
	]);
	await assert.rejects(
		evidence.import("owner", "import-key-1", {
			...input,
			records: [
				record({
					source: {
						platform: "web-report",
						accountRef: "account-1",
						reportRef: "different",
					},
				}),
			],
		}),
		(error: unknown) =>
			error instanceof EvidenceConflictError &&
			/idempotency/.test(error.message),
	);

	const [reused] = await evidence.import("owner", "import-key-2", {
		...input,
		records: [
			record({
				source: {
					platform: "web-report",
					accountRef: "account-1",
					reportRef: "report-2",
				},
			}),
		],
	});
	assert.equal(reused?.evidenceId, created?.evidenceId);
	assert.equal(reused?.status, "reused");
	const detail = await evidence.get("owner", created.evidenceId);
	assert.equal(detail?.current.values.spendMinor, 0);
	assert.equal("consultations" in (detail?.current.values ?? {}), false);
	assert.equal(detail?.sources[0]?.rawValues.consultations, null);
	assert.equal(detail?.sources.length, 2);
	assert.deepEqual(
		detail?.sources.map(({ source }) => source.reportRef),
		["report-1", "report-2"],
	);
	const [nullAndZero] = await evidence.import("owner", "import-key-4", {
		schemaVersion: 1,
		taskRef: { taskId: task.taskId, taskVersion: 1 },
		records: [
			record({
				period: {
					startsAt: "2026-01-02T00:00:00+08:00",
					endsAt: "2026-01-03T00:00:00+08:00",
					timeZone: "Asia/Shanghai",
					completeness: "complete",
				},
				values: { spendMinor: null, consultations: 0 },
			}),
		],
	});
	assert.ok(nullAndZero);
	const secondDetail = await evidence.get("owner", nullAndZero.evidenceId);
	assert.equal(secondDetail?.current.values.spendMinor, null);
	assert.equal(secondDetail?.current.values.consultations, 0);

	await assert.rejects(
		evidence.import("owner", "import-key-3", {
			...input,
			records: [record({ values: { spendMinor: 1, consultations: null } })],
		}),
		(error: unknown) =>
			error instanceof EvidenceConflictError && /content/.test(error.message),
	);
	await assert.rejects(
		evidence.import("other-owner", "import-key-1", input),
		(error: unknown) => error instanceof EvidenceValidationError,
	);
});

test("evidence batches are atomic on both validation and content conflicts", async () => {
	const { task, evidence } = await setup();
	const [existing] = await evidence.import("owner", "existing-key", {
		schemaVersion: 1,
		taskRef: { taskId: task.taskId, taskVersion: 1 },
		records: [record()],
	});
	const newPeriod = record({
		period: {
			startsAt: "2026-01-02T00:00:00+08:00",
			endsAt: "2026-01-03T00:00:00+08:00",
			timeZone: "Asia/Shanghai",
			completeness: "complete",
		},
	});
	await assert.rejects(
		evidence.import("owner", "conflict-batch", {
			schemaVersion: 1,
			taskRef: { taskId: task.taskId, taskVersion: 1 },
			records: [newPeriod, record({ values: { spendMinor: 9 } })],
		}),
		(error: unknown) => error instanceof EvidenceConflictError,
	);
	assert.deepEqual(
		(await evidence.listForTask("owner", task.taskId)).map(
			(item) => item.evidenceId,
		),
		[existing?.evidenceId],
	);

	const second = record({
		period: {
			startsAt: "2026-01-02T00:00:00+08:00",
			endsAt: "2026-01-03T00:00:00+08:00",
			timeZone: "Asia/Shanghai",
			completeness: "complete",
		},
		values: { spendMinor: -1, consultations: 2 },
	});
	await assert.rejects(
		evidence.import("owner", "atomic-key", {
			schemaVersion: 1,
			taskRef: { taskId: task.taskId, taskVersion: 1 },
			records: [newPeriod, second],
		}),
		(error: unknown) => error instanceof EvidenceValidationError,
	);
	assert.deepEqual(
		(await evidence.listForTask("owner", task.taskId)).map(
			(item) => item.evidenceId,
		),
		[existing?.evidenceId],
	);
});

test("evidence revisions require an expected version and retain immutable history", async () => {
	const { task, evidence } = await setup();
	const [first] = await evidence.import("owner", "import-key", {
		schemaVersion: 1,
		taskRef: { taskId: task.taskId, taskVersion: 1 },
		records: [record()],
	});
	assert.ok(first);
	const revised = await evidence.revise(
		"owner",
		first.evidenceId,
		"revision-key",
		{
			expectedEvidenceVersion: 1,
			reason: "来源报表已更正",
			record: record({
				source: {
					platform: "web-report",
					accountRef: "account-1",
					reportRef: "report-1-corrected",
				},
				values: { spendMinor: 5000, consultations: 5 },
				rawValues: { spend: "50.00", consultations: "5" },
			}),
		},
	);
	assert.equal(revised.version, 2);
	assert.equal(revised.status, "revised");
	assert.deepEqual(
		await evidence.revise("owner", first.evidenceId, "revision-key", {
			expectedEvidenceVersion: 1,
			reason: "来源报表已更正",
			record: record({
				source: {
					platform: "web-report",
					accountRef: "account-1",
					reportRef: "report-1-corrected",
				},
				values: { spendMinor: 5000, consultations: 5 },
				rawValues: { spend: "50.00", consultations: "5" },
			}),
		}),
		revised,
	);
	await assert.rejects(
		evidence.revise("owner", first.evidenceId, "stale-key", {
			expectedEvidenceVersion: 1,
			reason: "过期版本",
			record: record({ values: { spendMinor: 6000, consultations: 6 } }),
		}),
		(error: unknown) =>
			error instanceof EvidenceConflictError && /version/.test(error.message),
	);
	const detail = await evidence.get("owner", first.evidenceId);
	assert.equal(detail?.versions.length, 2);
	assert.equal(detail?.versions[0]?.values.spendMinor, 0);
	assert.equal(detail?.current.values.spendMinor, 5000);
	assert.equal(detail?.current.reason, "来源报表已更正");
	assert.equal(await evidence.get("other-owner", first.evidenceId), null);
});
