import type { MarketEventInput } from "../packages/core/dist/index.js";

export const eventInput = (): MarketEventInput => ({
	occurrenceKey: "release-2026-11", title: "测试品牌新品发布", type: "product_launch", subject: { kind: "brand", name: "测试品牌" },
	eventTime: "2026-11-16", conditions: "仅限试点地区",
	sources: [{ url: "https://example.com/releases/1", publisher: "测试官网", content: "测试品牌于2026-11-16发布新品，仅限试点地区。", scope: "full_text", origin: "official", publishedAt: "2026-11-16", acquiredAt: "2026-11-16T02:00:00Z", limitations: "人造 fixture；官方性质由录入者声明" }],
	citations: { subject: { sourceIndex: 0, quote: "测试品牌" }, eventTime: { sourceIndex: 0, quote: "2026-11-16" }, conditions: { sourceIndex: 0, quote: "仅限试点地区" } }, taskRefs: [],
	provenance: { simulated: false, reference: null, transformation: null },
});
export const taskInput = { product: "本人任务", strategy: { objective: "了解市场", audience: [], channels: {}, sellingPoints: [] }, observation: {}, rules: {} };
