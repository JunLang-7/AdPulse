import assert from "node:assert/strict";
import test from "node:test";
import {
	LIFECYCLE,
	LifecycleValidationError,
	TaskNotActiveError,
	TaskService,
	addLifecycleDays,
	assertTaskActive,
	deletionOf,
	deletionWindow,
	isRetentionExpired,
	lastBusinessUpdateAt,
	markCleaned,
	retentionAnchor,
	retentionDeadline,
	restrictForDeletion,
} from "../packages/core/dist/index.js";
import type { Session, TaskVersion } from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

const input = (overrides: Partial<TaskVersion["observation"]> = {}) => ({
	product: "产品 A",
	strategy: {
		objective: "获取咨询",
		audience: ["山东企业"],
		channels: { ads: {} },
		sellingPoints: [],
	},
	observation: { scope: "山东地区", ...overrides },
	rules: { minimumSpendMinor: 0 },
});

function service(clock: { at: string }) {
	const storage = new MemoryStorage();
	let nextId = 0;
	const tasks = new TaskService(
		storage,
		() => clock.at,
		() => `task-${++nextId}`,
	);
	return { storage, tasks, clock };
}

const session = (
	id: string,
	ownerId: string,
	taskId: string,
	createdAt: string,
): Session => ({
	id,
	ownerId,
	taskRef: { taskId, taskVersion: 1 },
	allowedActorIds: [ownerId],
	strategy: {
		objective: "获取咨询",
		audience: [],
		channels: {},
		sellingPoints: [],
	},
	limits: { maxBudgetChangeRatio: 1, maxBidChangeRatio: 1 },
	signal: { id: "signal-1", title: "信号", summary: "摘要", evidence: [] },
	version: 0,
	roundNo: 1,
	status: "awaiting_input",
	createdAt,
});

test("retention anchor uses the observation end even when business writes are later", async () => {
	const clock = { at: "2026-01-01T00:00:00.000Z" };
	const { storage, tasks } = service(clock);
	const created = await tasks.create(
		"owner",
		"create-key",
		input({ endsAt: "2026-03-01T00:00:00.000Z" }),
	);
	await storage.transaction(async (tx) => {
		await tx.evidenceHeads.put({
			id: "evidence-1",
			ownerId: "owner",
			taskId: created.taskId,
			taskVersion: 1,
			currentVersion: 1,
			createdAt: "2026-06-01T00:00:00.000Z",
		});
		const task = await tx.tasks.get(created.taskId);
		assert.ok(task);
		const anchor = await retentionAnchor(tx, task, created);
		assert.deepEqual(anchor, {
			anchorAt: "2026-03-01T00:00:00.000Z",
			source: "observation_end",
		});
		assert.equal(retentionDeadline(anchor), "2027-03-01T00:00:00.000Z");
	});
});

test("without an observation end the anchor is the latest business write", async () => {
	const clock = { at: "2026-01-01T00:00:00.000Z" };
	const { storage, tasks } = service(clock);
	const created = await tasks.create("owner", "create-key", input());

	clock.at = "2026-02-01T00:00:00.000Z";
	await tasks.revise("owner", created.taskId, 1, "revise-key", input());

	await storage.transaction(async (tx) => {
		await tx.evidenceHeads.put({
			id: "evidence-1",
			ownerId: "owner",
			taskId: created.taskId,
			taskVersion: 2,
			currentVersion: 1,
			createdAt: "2026-03-01T00:00:00.000Z",
		});
		await tx.sessions.put(
			session("session-1", "owner", created.taskId, "2026-04-01T00:00:00.000Z"),
		);
		// 其他任务与另一名用户的写入不能被当成该任务的业务更新。
		await tx.evidenceHeads.put({
			id: "evidence-2",
			ownerId: "owner",
			taskId: "another-task",
			taskVersion: 1,
			currentVersion: 1,
			createdAt: "2026-05-01T00:00:00.000Z",
		});
		await tx.sessions.put(
			session("session-2", "owner", "another-task", "2026-06-01T00:00:00.000Z"),
		);
		const task = await tx.tasks.get(created.taskId);
		assert.ok(task);
		const version =
			(await tx.taskVersions.get(`${created.taskId}:${task.currentVersion}`)) ??
			created;
		assert.equal(await lastBusinessUpdateAt(tx, task), "2026-04-01T00:00:00.000Z");
		assert.deepEqual(await retentionAnchor(tx, task, version), {
			anchorAt: "2026-04-01T00:00:00.000Z",
			source: "last_business_update",
		});
	});
});

test("ordinary reads do not extend the retention anchor", async () => {
	const clock = { at: "2026-01-01T00:00:00.000Z" };
	const { storage, tasks } = service(clock);
	const created = await tasks.create("owner", "create-key", input());
	const seeded = "2026-05-01T00:00:00.000Z";
	await storage.transaction(async (tx) => {
		await tx.evidenceHeads.put({
			id: "evidence-1",
			ownerId: "owner",
			taskId: created.taskId,
			taskVersion: 1,
			currentVersion: 1,
			createdAt: seeded,
		});
	});

	clock.at = "2026-11-01T00:00:00.000Z";
	await tasks.get("owner", created.taskId);
	await tasks.getVersion("owner", created.taskId, 1);
	await tasks.list("owner");

	await storage.transaction(async (tx) => {
		const task = await tx.tasks.get(created.taskId);
		assert.ok(task);
		assert.equal(await lastBusinessUpdateAt(tx, task), seeded);
	});
});

test("the 365-day boundary is exact and UTC-only", async () => {
	const anchor = {
		anchorAt: "2026-01-01T00:00:00.000Z",
		source: "last_business_update" as const,
	};
	assert.equal(retentionDeadline(anchor), "2027-01-01T00:00:00.000Z");
	assert.equal(isRetentionExpired(anchor, "2026-12-31T23:59:59.999Z"), false);
	assert.equal(isRetentionExpired(anchor, "2027-01-01T00:00:00.000Z"), true);
	assert.equal(isRetentionExpired(anchor, "2027-01-01T00:00:00.001Z"), true);
	// 闰日不退化成「一年 365 天」以外的本地时区口径。
	assert.equal(
		addLifecycleDays("2028-02-28T00:00:00.000Z", 2),
		"2028-03-01T00:00:00.000Z",
	);
	assert.equal(LIFECYCLE.businessRetentionDays, 365);
});

test("deletion windows follow 7 / 30 / 37 and 180 days", () => {
	assert.deepEqual(deletionWindow("2026-01-01T00:00:00.000Z"), {
		requestedAt: "2026-01-01T00:00:00.000Z",
		onlineCleanupDueAt: "2026-01-08T00:00:00.000Z",
		backupDueAt: "2026-02-07T00:00:00.000Z",
		auditDueAt: "2026-06-30T00:00:00.000Z",
	});
	assert.equal(LIFECYCLE.onlineCleanupDays, 7);
	assert.equal(LIFECYCLE.backupRetentionDays, 30);
	assert.equal(LIFECYCLE.cleanupTotalDays, 37);
	assert.equal(LIFECYCLE.auditRetentionDays, 180);
});

test("deletion confirmation is idempotent and keeps the first request time", () => {
	const task = {
		id: "task-1",
		ownerId: "owner",
		currentVersion: 1,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	const restricted = restrictForDeletion(
		task,
		"2026-02-01T00:00:00.000Z",
		"owner",
	);
	assert.deepEqual(deletionOf(restricted), {
		requestedAt: "2026-02-01T00:00:00.000Z",
		requestedBy: "owner",
		state: "restricted",
		cleanupDueAt: "2026-02-08T00:00:00.000Z",
	});
	const again = restrictForDeletion(
		restricted,
		"2026-03-01T00:00:00.000Z",
		"owner",
	);
	assert.deepEqual(deletionOf(again), deletionOf(restricted));
});

test("restricted or cleaned tasks are not active", () => {
	const task = {
		id: "task-1",
		ownerId: "owner",
		currentVersion: 1,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	assert.deepEqual(assertTaskActive(task), task);
	const restricted = restrictForDeletion(
		task,
		"2026-02-01T00:00:00.000Z",
		"owner",
	);
	assert.throws(
		() => assertTaskActive(restricted),
		(error) => error instanceof TaskNotActiveError && error.reason === "restricted",
	);
	const cleaned = markCleaned(restricted, "2026-02-05T00:00:00.000Z");
	assert.throws(
		() => assertTaskActive(cleaned),
		(error) => error instanceof TaskNotActiveError && error.reason === "cleaned",
	);
	assert.equal(deletionOf(cleaned)?.cleanedAt, "2026-02-05T00:00:00.000Z");
});

test("invalid lifecycle timestamps are rejected instead of treated as expired", () => {
	assert.throws(
		() => addLifecycleDays("not-a-time", 1),
		(error) =>
			error instanceof LifecycleValidationError &&
			error.fieldPath === "lifecycle.at",
	);
	assert.throws(
		() =>
			isRetentionExpired(
				{ anchorAt: "not-a-time", source: "last_business_update" },
				"2026-01-01T00:00:00.000Z",
			),
		LifecycleValidationError,
	);
});
