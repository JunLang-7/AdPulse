import assert from "node:assert/strict";
import test from "node:test";
import {
	SearchAggregator,
	quotaDay,
	type SearchProvider,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const hit = (url: string) => ({ title: `标题 ${url}`, url });

const provider = (
	id: string,
	opts: { metered?: boolean; dailyLimit?: number | null; hits?: number; fail?: boolean; rateLimited?: boolean } = {},
): SearchProvider & { calls: number } => {
	const state = {
		id,
		label: `${id} 源`,
		metered: opts.metered ?? false,
		dailyLimit: opts.dailyLimit === undefined ? 3 : opts.dailyLimit,
		calls: 0,
		async search() {
			state.calls += 1;
			if (opts.fail) throw new Error("boom");
			if (opts.rateLimited) return { status: "rate_limited" as const, hits: [], detail: "限流" };
			const hits = Array.from({ length: opts.hits ?? 5 }, (_, index) => hit(`https://${id}.example/${index}`));
			return { status: "ok" as const, hits };
		},
	};
	return state;
};

test("quotaDay：按北京时间自然日切分", () => {
	// UTC 15:59 是北京时间 23:59，同一日；UTC 16:00 是次日 00:00。
	assert.equal(quotaDay(new Date("2026-11-18T15:59:00Z")), "2026-11-18");
	assert.equal(quotaDay(new Date("2026-11-18T16:00:00Z")), "2026-11-19");
});

test("聚合：免费源优先，够用后不再调用付费源", async () => {
	const storage = new MemoryStorage();
	const free = provider("free", { hits: 10 });
	const paid = provider("paid", { metered: true, hits: 10 });
	const aggregator = new SearchAggregator(storage, [free, paid], { enoughHits: 8 });
	const result = await aggregator.search("某企业");
	assert.equal(result.hits.length, 10);
	assert.equal(free.calls, 1);
	assert.equal(paid.calls, 0, "免费源已够，不该消耗付费额度");
	assert.equal(result.providers.find((p) => p.provider === "paid")?.status, "skipped");
});

test("额度：每日上限用完后停止调用，并如实报告", async () => {
	const storage = new MemoryStorage();
	const paid = provider("paid", { metered: true, dailyLimit: 2, hits: 1 });
	const aggregator = new SearchAggregator(storage, [paid], { enoughHits: 8 });

	const first = await aggregator.search("企业A");
	assert.equal(first.hits.length, 1);
	const second = await aggregator.search("企业B");
	assert.equal(second.hits.length, 1);
	assert.equal(paid.calls, 2, "两次调用用满额度");

	const third = await aggregator.search("企业C");
	assert.equal(paid.calls, 2, "额度用完不再发请求");
	assert.equal(third.hits.length, 0);
	assert.equal(third.anyQuotaExhausted, true);
	const outcome = third.providers.find((p) => p.provider === "paid");
	assert.equal(outcome?.status, "quota_exhausted");
	assert.match(outcome?.detail ?? "", /次日 00:00/);

	const quotas = await aggregator.quotas();
	assert.deepEqual(
		quotas.map((q) => ({ provider: q.provider, used: q.used, remaining: q.remaining, exhausted: q.exhausted })),
		[{ provider: "paid", used: 2, remaining: 0, exhausted: true }],
	);
});

test("额度：不同自然日互不影响", async () => {
	const storage = new MemoryStorage();
	const paid = provider("paid", { metered: true, dailyLimit: 1, hits: 1 });
	let clock = new Date("2026-11-18T02:00:00Z");
	const aggregator = new SearchAggregator(storage, [paid], { enoughHits: 8, now: () => clock });
	await aggregator.search("企业A");
	const sameDay = await aggregator.search("企业B");
	assert.equal(sameDay.anyQuotaExhausted, true, "同日第二次超限");
	clock = new Date("2026-11-19T02:00:00Z");
	const nextDay = await aggregator.search("企业C");
	assert.equal(nextDay.anyQuotaExhausted, false, "次日额度恢复");
	assert.equal(paid.calls, 2);
});

test("失败退还额度：抛错、失败、限流、不可用都不扣付费额度", async () => {
	const storage = new MemoryStorage();
	const throwing = provider("throw", { metered: true, dailyLimit: 5, fail: true });
	const failed = provider("failed", { metered: true, dailyLimit: 5 });
	failed.search = async () => {
		failed.calls += 1;
		return { status: "failed" as const, hits: [], detail: "上游 500" };
	};
	const unavailable = provider("unavailable", { metered: true, dailyLimit: 5 });
	unavailable.search = async () => {
		unavailable.calls += 1;
		return { status: "unavailable" as const, hits: [], detail: "密钥无效" };
	};
	const limited = provider("limited", { metered: true, dailyLimit: 5, rateLimited: true });
	const aggregator = new SearchAggregator(storage, [throwing, failed, unavailable, limited], { enoughHits: 8 });
	await aggregator.search("某企业");
	const quotas = await aggregator.quotas();
	assert.deepEqual(
		quotas.map((q) => ({ provider: q.provider, used: q.used })),
		[
			{ provider: "throw", used: 0 },
			{ provider: "failed", used: 0 },
			{ provider: "unavailable", used: 0 },
			{ provider: "limited", used: 0 },
		],
		"没拿到结果的调用不应消耗额度",
	);
});

test("成功调用计入额度：有结果的源正常扣费", async () => {
	const storage = new MemoryStorage();
	const paid = provider("paid", { metered: true, dailyLimit: 5, hits: 2 });
	const aggregator = new SearchAggregator(storage, [paid], { enoughHits: 8 });
	await aggregator.search("某企业");
	const quotas = await aggregator.quotas();
	assert.equal(quotas[0]?.used, 1, "拿到结果的调用要计数");
});

test("失败与限流：不吞掉，逐源报告给调用方", async () => {
	const storage = new MemoryStorage();
	const failing = provider("bad", { fail: true });
	const limited = provider("limited", { rateLimited: true });
	const aggregator = new SearchAggregator(storage, [failing, limited], { enoughHits: 8 });
	const result = await aggregator.search("某企业");
	assert.equal(result.hits.length, 0);
	assert.equal(result.providers[0]?.status, "failed");
	assert.match(result.providers[0]?.detail ?? "", /boom/);
	assert.equal(result.providers[1]?.status, "rate_limited");
	assert.equal(result.anyQuotaExhausted, false);
});

test("去重：同一 URL 只保留一次，来源标注正确", async () => {
	const storage = new MemoryStorage();
	const shared = hit("https://same.example/1");
	const first: SearchProvider = {
		id: "a", label: "A", metered: false, dailyLimit: null,
		async search() { return { status: "ok" as const, hits: [shared, hit("https://a.example/1")] }; },
	};
	const second: SearchProvider = {
		id: "b", label: "B", metered: false, dailyLimit: null,
		async search() { return { status: "ok" as const, hits: [shared, hit("https://b.example/1")] }; },
	};
	const aggregator = new SearchAggregator(storage, [first, second], { enoughHits: 99 });
	const result = await aggregator.search("某企业");
	assert.equal(result.hits.length, 3, "重复 URL 合并");
	assert.equal(result.providers.find((p) => p.provider === "b")?.hits.length, 1, "只计新增的那条");
});
