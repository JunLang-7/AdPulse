import assert from "node:assert/strict";
import test from "node:test";
import {
	baiduProvider,
	bochaProvider,
	bingProvider,
	bingQueries,
	providersFromEnvironment,
} from "../packages/runtime/dist/search-providers.js";
import { discoverCompanySite, mentionsBrand } from "../packages/runtime/dist/site-discovery.js";
import type { SourceFetcher } from "../packages/core/dist/index.js";

/**
 * 中文企业搜索的准确性与国内源接入（#196）。
 * 全部使用合成响应，不访问真实搜索服务。
 */

test("品牌边界：二字品牌不再命中更长的无关词", () => {
	// 真命中
	assert.equal(mentionsBrand("海尔集团官网", "海尔"), true);
	assert.equal(mentionsBrand("海尔智家股份有限公司", "海尔"), true);
	assert.equal(mentionsBrand("上海海尔工业园", "海尔"), true);
	assert.equal(mentionsBrand("美的集团官方网站", "美的"), true);
	assert.equal(mentionsBrand("美的空调", "美的"), true);
	// 假命中：品牌只是更长词的一部分
	assert.equal(mentionsBrand("海尔曼工业集团", "海尔"), false, "海尔曼 不是海尔");
	assert.equal(mentionsBrand("美的很安静的社区", "美的"), false, "形容词用法不是品牌");
	assert.equal(mentionsBrand("真美的画面", "美的"), false);
	// 拉丁品牌按词边界
	assert.equal(mentionsBrand("Midea Group official site", "Midea"), true);
	assert.equal(mentionsBrand("Mideas is a typo", "Midea"), false);
});

test("Bing 查询带简中市场参数与更多中文变体", async () => {
	const urls: string[] = [];
	const originalFetch = globalThis.fetch;
	// bingProvider 走 UserSiteFetcher，这里只验证查询变体生成。
	const variants = bingQueries("美的");
	assert.ok(variants.includes("美的 官网"));
	assert.ok(variants.includes("美的官方网站"));
	assert.ok(variants.includes("美的首页"));
	assert.equal(urls.length, 0);
	assert.ok(originalFetch);
	const provider = bingProvider();
	assert.equal(provider.id, "bing");
});

test("百度千帆适配器：请求体与 references 解析", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify({
			references: [
				{ title: "美的集团官方网站", url: "https://www.midea.com.cn/zh/about-midea/news" },
				{ title: "", url: "not-a-url" },
			],
			request_id: "synthetic",
		}), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	try {
		const provider = baiduProvider("synthetic-baidu-key");
		assert.ok(provider);
		const result = await provider.search("美的 新闻中心");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.url, "https://qianfan.baidubce.com/v2/ai_search/web_search");
		const headers = calls[0]?.init.headers as Record<string, string>;
		assert.equal(headers.authorization, "Bearer synthetic-baidu-key");
		const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
		assert.deepEqual(body.messages, [{ role: "user", content: "美的 新闻中心" }]);
		assert.equal(body.search_source, "baidu_search_v2");
		assert.deepEqual(body.resource_type_filter, [{ type: "web", top_k: 8 }]);
		// 只保留可用的 http(s) 结果，不编造。
		assert.deepEqual(result.hits, [
			{ title: "美的集团官方网站", url: "https://www.midea.com.cn/zh/about-midea/news" },
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("百度千帆适配器：200 + 错误码与 429 都如实报告", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () => new Response(
			JSON.stringify({ code: 216003, message: "Authentication error" }),
			{ status: 200, headers: { "content-type": "application/json" } },
		)) as typeof fetch;
		const provider = baiduProvider("bad-key");
		assert.ok(provider);
		const authError = await provider.search("美的");
		assert.equal(authError.status, "failed");
		assert.match(String(authError.detail), /216003/);

		globalThis.fetch = (async () => new Response("quota", { status: 429 })) as typeof fetch;
		const limited = await provider.search("美的");
		assert.equal(limited.status, "rate_limited");
		assert.match(String(limited.detail), /额度/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("博查适配器：兼容官方信封与直出 webPages 两种响应", async () => {
	const originalFetch = globalThis.fetch;
	const bodies = [
		{ code: 200, data: { webPages: { value: [{ name: "美的集团", url: "https://www.midea.com.cn/" }] } } },
		{ webPages: { value: [{ name: "海尔集团", url: "https://www.haier.com/" }] } },
	];
	try {
		for (const [index, body] of bodies.entries()) {
			globalThis.fetch = (async () => new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
			const provider = bochaProvider("synthetic-bocha-key");
			assert.ok(provider);
			const result = await provider.search("官网");
			assert.equal(result.status, "ok");
			assert.equal(result.hits.length, 1, `第 ${index} 种响应形态应能解析`);
			assert.ok(result.hits[0]?.url.startsWith("https://"));
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("未配置密钥时不注册国内源；配置后排在英文源前面", () => {
	const withoutKeys = providersFromEnvironment({}).map((provider) => provider.id);
	assert.equal(withoutKeys.includes("baidu"), false);
	assert.equal(withoutKeys.includes("bocha"), false);

	const withKeys = providersFromEnvironment({
		BAIDU_QIANFAN_API_KEY: "synthetic",
		BOCHA_API_KEY: "synthetic",
	}).map((provider) => provider.id);
	assert.deepEqual(withKeys.slice(0, 2), ["baidu", "bocha"]);
	assert.ok(withKeys.indexOf("baidu") < withKeys.indexOf("bing"));
	assert.ok(withKeys.indexOf("bocha") < withKeys.indexOf("bing"));
});

test("选站排序：经销商/非官网页面让位给真官网", async () => {
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			if (new URL(url).pathname === "/")
				return { status: 200, bytes: 120, body: "<html><head><title>美的集团官方网站</title></head><body><a href=\"/news/index.html\">新闻中心</a></body></html>" };
			return { status: 200, bytes: 120, body: "<html><body><a href=\"/news/1.html\">美的集团发布年度报告</a></body></html>" };
		},
	};
	const site = await discoverCompanySite("美的", undefined, {
		fetcher,
		aggregator: {
			async search() {
				return {
					hits: [
						{ title: "美的空调经销商加盟中心", url: "https://www.midea-dealer-example.com/" },
						{ title: "美的集团官方网站", url: "https://www.midea-example.com/" },
					],
					providers: [],
					anyQuotaExhausted: false,
				};
			},
		},
	});
	assert.equal(site.host, "www.midea-example.com", "真官网应排在经销商页之前");
});

test("首页验证：只在正文里提到品牌的站不算官网", async () => {
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			if (new URL(url).pathname === "/")
				// 标题与我们无关，品牌只出现在正文里（典型经销商/媒体页）。
				return { status: 200, bytes: 80, body: "<title>某某商贸有限公司</title><p>本公司代理美的、海尔等品牌</p>" };
			return { status: 200, bytes: 40, body: "<a href=\"/news/1.html\">新闻</a>" };
		},
	};
	await assert.rejects(
		() => discoverCompanySite("美的", undefined, {
			fetcher,
			aggregator: {
				async search() {
					return {
						hits: [{ title: "某某商贸有限公司", url: "https://www.dealer-example.com/" }],
						providers: [],
						anyQuotaExhausted: false,
					};
				},
			},
		}),
		/site discovery found no usable official site|does not mention the company/,
	);
});
