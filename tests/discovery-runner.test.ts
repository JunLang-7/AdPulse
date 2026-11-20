// #222 定时发现循环：站内索引搜索 → 未核验线索 → 自动排初判 job。
// 全部使用内存存储与假搜索出口，不发真实网络请求。
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DiscoveryLeadService, TaskService } from "../packages/core/dist/index.js";
import { runDiscoveryLeads, runDiscoveryRound } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { taskInput } from "./market-event-fixtures.ts";

interface SourceFixture {
	id: string;
	ownerId: string;
	host: string;
	subject: { kind: "brand" | "competitor"; name: string };
}

/** 直接落一条 active 的用户站点，绕过官网发现流程。 */
async function putSource(
	storage: MemoryStorage,
	source: SourceFixture,
	overrides: Record<string, unknown> = {},
): Promise<void> {
	await storage.transaction(async (tx) => {
		await tx.userSources.put({
			id: source.id,
			ownerId: source.ownerId,
			label: source.subject.name,
			host: source.host,
			listUrl: `https://${source.host}/news`,
			subject: source.subject,
			createdAt: "2026-01-01T00:00:00.000Z",
			discoveryStartedAt: null,
			lastRefreshAt: null,
			lastOutcome: null,
			lastReason: null,
			status: "active",
			...overrides,
		});
	});
}

const source: SourceFixture = {
	id: randomUUID(),
	ownerId: "owner-1",
	host: "www.example.com",
	subject: { kind: "brand", name: "示例集团" },
};

const hit = (n: number) => ({
	title: `示例集团发布第 ${n} 代产品`,
	url: `https://www.example.com/news/2026/news${n}.shtml`,
});

test("round：搜索命中新 URL → 线索入库 + 每个活跃任务排初判 job + 水位线推进", async () => {
	const storage = new MemoryStorage();
	const tasks = new TaskService(storage, () => "2026-01-05T01:00:00.000Z", () => "task-1");
	await tasks.create(source.ownerId, "task-create", taskInput);
	await putSource(storage, source);

	const searches: string[] = [];
	const outcome = await runDiscoveryRound(
		storage,
		source,
		async (query) => {
			searches.push(query);
			return [hit(1)];
		},
		"2026-01-05T01:00:00.000Z",
	);

	assert.deepEqual(searches, ["site:www.example.com 示例集团 新闻"]);
	assert.equal(outcome.status, "ok");
	assert.equal(outcome.created, 1);

	const leads = await new DiscoveryLeadService(storage).list(source.ownerId);
	assert.equal(leads.length, 1);
	assert.equal(leads[0]!.status, "pending");
	assert.equal(leads[0]!.verification, "unverified");
	assert.equal(leads[0]!.provider, "scheduled/site-index");
	assert.equal(leads[0]!.sourceKey, `user:${source.id}`);
	assert.equal(leads[0]!.topic, "新闻");

	// 活跃任务应有一条 prepare_signal_assessments job（幂等 id）。
	const jobs = await storage.transaction(async (tx) => {
		const all = [];
		for (const job of await tx.jobs.all()) all.push(job);
		return all;
	});
	assert.equal(jobs.filter((job) => job.task.kind === "prepare_signal_assessments").length, 1);

	// 水位线推进到本轮时刻。
	const stored = await storage.transaction(async (tx) => tx.userSources.get(source.id));
	assert.equal(stored?.lastDiscoveryRunAt, "2026-01-05T01:00:00.000Z");
});

test("round：同槽位重复跑不再搜索；重复 URL created=0 如实 skipped", async () => {
	const storage = new MemoryStorage();
	await putSource(storage, source);
	let calls = 0;
	const search = async () => {
		calls += 1;
		return [hit(2)];
	};

	await runDiscoveryRound(storage, source, search, "2026-01-05T01:00:00.000Z");
	await runDiscoveryRound(storage, source, search, "2026-01-05T01:01:00.000Z");

	const second = await runDiscoveryRound(storage, source, search, "2026-01-06T01:00:00.000Z");
	assert.equal(calls, 3);
	// 次日槽位：同 URL 已在历史线索里 → 只记 skipped，不重复入库。
	assert.equal(second.created, 0);
	assert.equal(second.skipped, 1);
	assert.equal(second.status, "empty");
	const leads = await new DiscoveryLeadService(storage).list(source.ownerId);
	assert.equal(leads.length, 1);
});

test("round：搜索抛错 → 失败如实返回，水位线仍推进，不产生线索", async () => {
	const storage = new MemoryStorage();
	await putSource(storage, source);

	const outcome = await runDiscoveryRound(
		storage,
		source,
		async () => {
			throw new Error("quota exhausted upstream");
		},
		"2026-01-05T01:00:00.000Z",
	);

	assert.equal(outcome.status, "failed");
	assert.match(outcome.reason ?? "", /quota exhausted upstream/);
	const leads = await new DiscoveryLeadService(storage).list(source.ownerId);
	assert.equal(leads.length, 0);
	const stored = await storage.transaction(async (tx) => tx.userSources.get(source.id));
	assert.equal(stored?.lastDiscoveryRunAt, "2026-01-05T01:00:00.000Z");
});

test("loop：未启用立即返回，不发起搜索", async () => {
	const storage = new MemoryStorage();
	await putSource(storage, source);
	let calls = 0;
	const controller = new AbortController();
	await runDiscoveryLeads(storage, controller.signal, {
		enabled: false,
		search: async () => {
			calls += 1;
			return [];
		},
		tickMs: 5,
		now: () => "2026-01-05T01:00:00.000Z",
	});
	assert.equal(calls, 0);
	const leads = await new DiscoveryLeadService(storage).list(source.ownerId);
	assert.equal(leads.length, 0);
});

test("loop：启用后跑一轮，同槽位 tick 不重复搜索；无 host 或非 active 站点跳过", async () => {
	const storage = new MemoryStorage();
	await putSource(storage, source);
	// discovering 站点：没有 host，不应被搜索。
	await putSource(
		storage,
		{ ...source, id: randomUUID(), host: "pending.example.com" },
		{ host: null, listUrl: null, status: "discovering" },
	);

	let calls = 0;
	const controller = new AbortController();
	const loop = runDiscoveryLeads(storage, controller.signal, {
		enabled: true,
		tickMs: 5,
		now: () => "2026-01-05T01:00:00.000Z",
		search: async (query) => {
			calls += 1;
			assert.equal(query, "site:www.example.com 示例集团 新闻");
			return [hit(3)];
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	controller.abort();
	await loop;

	// 多次 tick 只应跑一轮（槽位判定 + 水位线）。
	assert.equal(calls, 1);
	const leads = await new DiscoveryLeadService(storage).list(source.ownerId);
	assert.equal(leads.length, 1);
});
