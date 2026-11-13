// 模型发现（#86 §4.4 便利项）：只在显式点击时读取供应商模型列表。
// 成功只代表“能列出模型”，不代表生成能力已验证；失败不猜默认模型。

import assert from "node:assert/strict";
import test from "node:test";
import { discoverModels, modelDiscoveryMaxModels } from "../packages/runtime/dist/model-discovery.js";

const input = {
	baseUrl: "https://api.example.com/v1",
	protocol: "openai-completions" as const,
	apiKey: "synthetic-personal-key",
};

function reply(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("discovery: reads /models with the personal key and de-duplicates ids", async () => {
	let seen: { url: string; method: string; auth: string | null } | undefined;
	const models = await discoverModels(input, async (request, init) => {
		const sent = new Request(request, init);
		seen = { url: sent.url, method: sent.method, auth: sent.headers.get("authorization") };
		return reply({ data: [{ id: "mimo-v2-flash" }, { id: " mimo-v2-flash " }, { id: "mimo-pro" }, { id: 42 }, null] });
	});
	assert.deepEqual(models, ["mimo-v2-flash", "mimo-pro"]);
	assert.deepEqual(seen, {
		url: "https://api.example.com/v1/models",
		method: "GET",
		auth: "Bearer synthetic-personal-key",
	});
});

test("discovery: caps the list and refuses unwired protocols or empty keys", async () => {
	const many = { data: Array.from({ length: 150 }, (_, index) => ({ id: `model-${index}` })) };
	const models = await discoverModels(input, async () => reply(many));
	assert.equal(models?.length, modelDiscoveryMaxModels);

	assert.equal(await discoverModels({ ...input, protocol: "anthropic-messages" }, async () => reply(many)), null);
	assert.equal(await discoverModels({ ...input, apiKey: "   " }, async () => reply(many)), null);
});

test("discovery: non-2xx, invalid JSON, oversized or unexpected bodies return null", async () => {
	const cases: Array<() => Response> = [
		() => reply({ data: [] }, 401),
		() => new Response("not json", { status: 200 }),
		() => reply({ models: ["mimo"] }),
		() => reply({ data: "mimo" }),
		() => { throw new Error("synthetic transport failure"); },
	];
	for (const make of cases) {
		assert.equal(await discoverModels(input, async () => make()), null);
	}
	// 结构合法但没有可用 id：是空列表而不是错误，用户可改为手动填写。
	assert.deepEqual(await discoverModels(input, async () => reply({ data: [{ id: "x".repeat(200) }] })), []);
	// 上游返回的超限内容由受控传输层拦截；这里再兜一层长度检查。
	const huge = { data: [{ id: "mimo" }], padding: "x".repeat(300 * 1024) };
	assert.equal(await discoverModels(input, async () => reply(huge)), null);
});
