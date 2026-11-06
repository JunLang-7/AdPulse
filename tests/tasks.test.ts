import assert from "node:assert/strict";
import test from "node:test";
import { TaskService } from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

const input = (product = "产品 A") => ({
	product,
	strategy: {
		objective: "获取咨询",
		audience: ["山东企业"],
		channels: { ads: {} },
		sellingPoints: [],
	},
	observation: { scope: "山东地区" },
	rules: { minimumSpendMinor: 0 },
});

test("task create is owner-scoped and idempotent by operation key and request body", async () => {
	const storage = new MemoryStorage();
	let nextId = 0;
	const tasks = new TaskService(
		storage,
		() => "2026-01-01T00:00:00.000Z",
		() => `task-${++nextId}`,
	);
	const [created, retry] = await Promise.all([
		tasks.create("owner-a", "create-key", input()),
		tasks.create("owner-a", "create-key", input()),
	]);
	assert.equal(created.taskId, retry.taskId);
	assert.equal(nextId, 1);
	assert.equal(created.strategy.channels.ads?.budget, undefined);
	assert.equal(created.rules.minimumSpendMinor, 0);
	assert.equal(created.rules.alertThresholdMinor, undefined);
	assert.equal(await tasks.get("owner-b", created.taskId), null);
	await assert.rejects(
		tasks.create("owner-a", "create-key", input("另一个产品")),
		/idempotency conflict/,
	);
});

test("task revisions require the expected version and retain immutable history", async () => {
	const storage = new MemoryStorage();
	let nextId = 0;
	const tasks = new TaskService(
		storage,
		() => "2026-01-01T00:00:00.000Z",
		() => `task-${++nextId}`,
	);
	const first = await tasks.create("owner", "create-key", input());
	const revisedInput = input("产品 B");
	const second = await tasks.revise(
		"owner",
		first.taskId,
		1,
		"revise-key",
		revisedInput,
	);
	assert.equal(second.version, 2);
	assert.equal(second.product, "产品 B");
	assert.equal((await tasks.getVersion("owner", first.taskId, 1))?.product, "产品 A");
	assert.equal(
		(await tasks.revise("owner", first.taskId, 1, "revise-key", revisedInput))
			.version,
		2,
	);
	await assert.rejects(
		tasks.revise("owner", first.taskId, 1, "stale-key", input("产品 C")),
		/task version conflict/,
	);
	await assert.rejects(
		tasks.revise("owner", first.taskId, 1, "revise-key", input("产品 C")),
		/idempotency conflict/,
	);
	assert.deepEqual(
		(await tasks.list("owner")).map(({ version }) => version),
		[2],
	);
});
