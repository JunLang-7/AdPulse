// #222 定时发现循环：站内索引搜索 → 未核验线索 → 自动排初判 job。
// 全部使用内存存储与假搜索出口，不发真实网络请求。
// 回归覆盖（PR #223 review）：
// - 站外结果按登记 host 过滤，不冒充该官网的线索入库；
// - 锁内重读站点与水位线：同槽位第二步不重复搜索、删除/停用后跳过；
// - 搜索期间站点被删除/换站：写入事务守卫拒绝，不产生新线索；
// - 逐站隔离：单站锁/存储失败由 onRoundError 记录，循环继续处理其他站点。
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DiscoveryLeadService, TaskService } from "../packages/core/dist/index.js";
import { runDiscoveryLeads, runDiscoveryRound, runDiscoveryStep } from "../packages/runtime/dist/index.js";
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

async function countJobs(storage: MemoryStorage): Promise<number> {
	return storage.transaction(async (tx) =>
		(await tx.jobs.all()).filter((job) => job.task.kind === "prepare_signal_assessments").length,
	);
}

test("round：同域命中入库、排初判 job、水位线推进；站外链接被过滤不入库", async () => {
	const storage = new MemoryStorage();
	let seq = 0;
	const tasks = new TaskService(storage, () => "2026-01-05T01:00:00.000Z", () => `task-${++seq}`);
	await tasks.create(source.ownerId, "task-create", taskInput);
	await putSource(storage, source);

	const searches: string[] = [];
	const outcome = await runDiscoveryRound(
		storage,
		source,
		async (query) => {
			searches.push(query);
			return [
				hit(1),
				// 聚合器可能无视 site: 限定返回站外链接：不得冒充该官网的线索（P2 review）。
				{ title: "媒体报道示例集团动态", url: "https://news.example.org/example-1.html" },
				// 解析失败的 URL 一律丢弃。
				{ title: "坏链接", url: "not a url" },
			];
		},
		"2026-01-05T01:00:00.000Z",
	);

	assert.deepEqual(searches, ["site:www.example.com 示例集团 新闻"]);
	assert.equal(outcome.status, "ok");
	assert.equal(outcome.discovered, 1);
	assert.equal(outcome.created, 1);

	const leads = await new DiscoveryLeadService(storage).list(source.ownerId);
	assert.equal(leads.length, 1);
	assert.equal(leads[0]!.url, hit(1).url);

	assert.equal(await countJobs(storage), 1);

	const stored = await storage.transaction(async (tx) => tx.userSources.get(source.id));
	assert.equal(stored?.lastDiscoveryRunAt, "2026-01-05T01:00:00.000Z");
});

test("round：重复 URL 与次日空轮如实 skipped；搜索抛错仍推进水位线", async () => {
	const storage = new MemoryStorage();
	await putSource(storage, source);
	let calls = 0;
	const search = async () => {
		calls += 1;
		return [hit(2)];
	};

	await runDiscoveryRound(storage, source, search, "2026-01-05T01:00:00.000Z");
	const second = await runDiscoveryRound(storage, source, search, "2026-01-06T01:00:00.000Z");
	assert.equal(second.created, 0);
	assert.equal(second.skipped, 1);
	assert.equal(second.status, "empty");

	const failed = await runDiscoveryRound(
		storage,
		source,
		async () => {
			calls += 1;
			throw new Error("quota exhausted upstream");
		},
		"2026-01-07T01:00:00.000Z",
	);
	assert.equal(failed.status, "failed");
	assert.match(failed.reason ?? "", /quota exhausted upstream/);
	const stored = await storage.transaction(async (tx) => tx.userSources.get(source.id));
	assert.equal(stored?.lastDiscoveryRunAt, "2026-01-07T01:00:00.000Z");
	assert.equal((await new DiscoveryLeadService(storage).list(source.ownerId)).length, 1);
	assert.equal(calls, 3);
});

test("round：搜索期间站点被删除或换站，守卫拒绝写入，不产生新线索", async () => {
	{
		const storage = new MemoryStorage();
		await putSource(storage, source);
		const outcome = await runDiscoveryRound(
			storage,
			source,
			async () => {
				// 搜索挂起期间站点被本人删除。
				await storage.transaction(async (tx) => tx.userSources.delete(source.id));
				return [hit(3)];
			},
			"2026-01-05T01:00:00.000Z",
		);
		assert.equal(outcome.status, "failed");
		assert.match(outcome.reason ?? "", /removed or changed/);
		assert.equal((await new DiscoveryLeadService(storage).list(source.ownerId)).length, 0);
	}
	{
		const storage = new MemoryStorage();
		await putSource(storage, source);
		const outcome = await runDiscoveryRound(
			storage,
			source,
			async () => {
				// 搜索挂起期间换站：host 变了，本轮线索不再挂到旧 host 名下。
				await storage.transaction(async (tx) => {
					const current = await tx.userSources.get(source.id);
					if (current) await tx.userSources.put({ ...current, host: "www.newsite.com" });
				});
				return [hit(4)];
			},
			"2026-01-05T01:00:00.000Z",
		);
		assert.equal(outcome.status, "failed");
		assert.match(outcome.reason ?? "", /removed or changed/);
		assert.equal((await new DiscoveryLeadService(storage).list(source.ownerId)).length, 0);
	}
});

test("step：锁内重读水位线——同槽位第二步不重复搜索；站点删除/停用后跳过", async () => {
	const storage = new MemoryStorage();
	await putSource(storage, source);
	let calls = 0;
	const search = async () => {
		calls += 1;
		return [hit(5)];
	};
	const slot = "2026-01-05T00:00:00.000Z";

	const first = await runDiscoveryStep(storage, source.id, slot, search, "2026-01-05T01:00:00.000Z");
	assert.equal(first?.status, "ok");
	// 拿锁后重读：水位线已被第一步推进，同槽位不再搜索（双实例只跑一次）。
	const second = await runDiscoveryStep(storage, source.id, slot, search, "2026-01-05T01:01:00.000Z");
	assert.equal(second, null);
	assert.equal(calls, 1);

	// 站点被删除：锁内复检直接跳过，不发搜索。
	await storage.transaction(async (tx) => tx.userSources.delete(source.id));
	const afterDelete = await runDiscoveryStep(storage, source.id, slot, search, "2026-01-06T01:00:00.000Z");
	assert.equal(afterDelete, null);
	assert.equal(calls, 1);
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
	assert.equal((await new DiscoveryLeadService(storage).list(source.ownerId)).length, 0);
});

// 注入水位线写入级故障：覆写 runExclusive 让指定站点的整步抛错，
// 模拟 finally 内水位线事务失败——循环必须逐站隔离而不是整体退出。
class StepFailStorage extends MemoryStorage {
	public failKeys = new Set<string>();
	async runExclusive<T>(
		key: string,
		work: () => Promise<T>,
	): Promise<{ acquired: boolean; value: T | null }> {
		if (this.failKeys.has(key)) throw new Error("simulated storage failure");
		return super.runExclusive(key, work);
	}
}

test("loop：单站整步失败逐站隔离——onRoundError 记录，循环不退出，次站照常发现", async () => {
	const failing: SourceFixture = {
		id: randomUUID(),
		ownerId: "owner-2",
		host: "www.failing.com",
		subject: { kind: "brand", name: "失败集团" },
	};
	const storage = new StepFailStorage();
	storage.failKeys.add(`discovery:${failing.id}`);
	await putSource(storage, failing);
	await putSource(storage, source);

	const errors: Array<{ sourceId: string; message: string }> = [];
	const controller = new AbortController();
	const loop = runDiscoveryLeads(storage, controller.signal, {
		enabled: true,
		tickMs: 5,
		now: () => "2026-01-05T01:00:00.000Z",
		search: async () => [hit(6)],
		onRoundError: (sourceId, error) =>
			errors.push({ sourceId, message: error instanceof Error ? error.message : String(error) }),
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	controller.abort();
	await loop;

	// 首站每个 tick 都会重试并记录（水位线未推进，符合一天一次的语义），
	// 循环未退出；次站照常产出线索。
	assert.ok(errors.length >= 1);
	assert.ok(errors.every((item) => item.sourceId === failing.id));
	assert.ok(errors.every((item) => /simulated storage failure/.test(item.message)));
	const leads = await new DiscoveryLeadService(storage).list(source.ownerId);
	assert.equal(leads.length, 1);
});
