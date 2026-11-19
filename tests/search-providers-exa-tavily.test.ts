import assert from "node:assert/strict";
import test from "node:test";
import {
	bochaProvider,
	exaProvider,
	providersFromEnvironment,
	tavilyProvider,
} from "../packages/runtime/dist/search-providers.js";

/**
 * Exa 官方 API 与 Tavily 的适配器（#198）。全部合成响应，不访问真实服务。
 */

function stubFetch(bodies: unknown[], status = 200) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	let index = 0;
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const body = bodies[Math.min(index, bodies.length - 1)];
		index += 1;
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

test("Exa 官方 API：地址、x-api-key、请求体与 results 解析", async () => {
	const stub = stubFetch([{
		results: [
			{ title: "美的集团官方网站", url: "https://www.midea-example.com/" },
			{ title: "无链接条目", url: "" },
		],
	}]);
	try {
		const provider = exaProvider("synthetic-exa-key");
		assert.ok(provider);
		const result = await provider.search("美的 官网");
		assert.equal(stub.calls.length, 1);
		assert.equal(stub.calls[0]?.url, "https://api.exa.ai/search");
		const headers = stub.calls[0]?.init.headers as Record<string, string>;
		assert.equal(headers["x-api-key"], "synthetic-exa-key");
		const body = JSON.parse(String(stub.calls[0]?.init.body)) as Record<string, unknown>;
		assert.equal(body.query, "美的 官网");
		assert.equal(body.numResults, 8);
		assert.deepEqual(result.hits, [{ title: "美的集团官方网站", url: "https://www.midea-example.com/" }]);
	} finally {
		stub.restore();
	}
});

test("Tavily：Bearer 鉴权、max_results 与 results 解析", async () => {
	const stub = stubFetch([{
		results: [
			{ title: "海尔集团官网", url: "https://www.haier-example.com/" },
			{ title: "经销商加盟", url: "https://dealer-example.com/" },
		],
	}]);
	try {
		const provider = tavilyProvider("tvly-synthetic");
		assert.ok(provider);
		const result = await provider.search("海尔 新闻");
		assert.equal(stub.calls[0]?.url, "https://api.tavily.com/search");
		const headers = stub.calls[0]?.init.headers as Record<string, string>;
		assert.equal(headers.authorization, "Bearer tvly-synthetic");
		const body = JSON.parse(String(stub.calls[0]?.init.body)) as Record<string, unknown>;
		assert.equal(body.max_results, 8);
		assert.equal(body.include_raw_content, false);
		assert.equal(result.status, "ok");
		assert.equal(result.hits.length, 2);
	} finally {
		stub.restore();
	}
});

test("Exa/Tavily 的限流与密钥错误都如实报告，不假装成功", async () => {
	for (const limitStatus of [429, 401]) {
		const stub = stubFetch([{ error: "nope" }], limitStatus);
		try {
			const exa = exaProvider("k");
			const tavily = tavilyProvider("k");
			assert.ok(exa && tavily);
			const exaResult = await exa.search("q");
			const tavilyResult = await tavily.search("q");
			const expected = limitStatus === 429 ? "rate_limited" : "unavailable";
			assert.equal(exaResult.status, expected);
			assert.equal(tavilyResult.status, expected);
			assert.deepEqual(exaResult.hits, []);
			assert.deepEqual(tavilyResult.hits, []);
		} finally {
			stub.restore();
		}
	}
});

test("六个源全配齐时的注册顺序：国内索引优先，其余按原顺序", () => {
	const ids = providersFromEnvironment({
		BAIDU_QIANFAN_API_KEY: "k",
		BOCHA_API_KEY: "k",
		EXA_API_KEY: "k",
		TAVILY_API_KEY: "k",
		SERPER_API_KEY: "k",
		BRAVE_API_KEY: "k",
	}).map((provider) => provider.id);
	assert.deepEqual(ids, ["baidu", "bocha", "bing", "exa", "serper", "brave", "exa-api", "tavily"]);
	// 未配置时只有免费源。
	assert.deepEqual(providersFromEnvironment({}).map((provider) => provider.id), ["bing", "exa"]);
	// 额度可单独覆盖。
	const limited = providersFromEnvironment({
		BAIDU_QIANFAN_API_KEY: "k",
		SEARCH_DAILY_LIMITS: "baidu:7,tavily:3",
		TAVILY_API_KEY: "k",
	});
	assert.equal(limited.find((p) => p.id === "baidu")?.dailyLimit, 7);
	assert.equal(limited.find((p) => p.id === "tavily")?.dailyLimit, 3);
	// bochaProvider 仍可用（避免未使用导出被误删）。
	assert.ok(bochaProvider("k"));
});
