import assert from "node:assert/strict";
import test from "node:test";
import {
	createCatalogTaskDraftExtractor,
	createPersistedTaskDraftExtractor,
	createTaskDraftRequestLimit,
	type ModelRouteInput,
} from "../packages/runtime/dist/task-draft-extractor.js";
import { modelCatalogProviders } from "../packages/runtime/dist/model-catalog.js";
import { anthropicReply } from "./fixtures/anthropic-messages.ts";

const route: ModelRouteInput = {
	providerId: "synthetic-claude", kind: "custom", baseUrl: "https://claude.example",
	protocol: "anthropic-messages", modelId: "synthetic-claude-1", apiKey: "synthetic-anthropic-key",
};

test("Anthropic Messages uses the native endpoint, header auth and prompt-only JSON", async () => {
	let seen: { url: string; method: string; apiKey: string | null; version: string | null; body: Record<string, unknown> } | undefined;
	const extract = createPersistedTaskDraftExtractor(route, async (input, init) => {
		const sent = new Request(input, init);
		seen = {
			url: sent.url,
			method: sent.method,
			apiKey: sent.headers.get("x-api-key"),
			version: sent.headers.get("anthropic-version"),
			body: await sent.json() as Record<string, unknown>,
		};
		return anthropicReply(JSON.stringify({ product: "新品试用装", budget: 300, channels: ["小红书"] }));
	});
	assert.ok(extract);
	assert.deepEqual(await extract("新品试用装，投小红书", "overview"), { product: "新品试用装" });
	assert.ok(seen);
	// SDK 会附带 ?beta=true；除这个已知变体外不接受其他地址。
	assert.equal(seen.url, "https://claude.example/v1/messages?beta=true");
	assert.equal(seen.method, "POST");
	assert.equal(seen.apiKey, "synthetic-anthropic-key");
	assert.equal(seen.version, "2023-06-01");
	assert.equal(seen.body.model, "synthetic-claude-1");
	assert.equal(seen.body.stream, true);
	assert.equal(seen.body.max_tokens, 1024);
	assert.equal(seen.body.temperature, 0);
	// Anthropic 没有 response_format / text.format；只能靠提示词约束。
	assert.equal(seen.body.response_format, undefined);
	assert.equal((seen.body as { text?: unknown }).text, undefined);
	assert.equal(seen.body.thinking, undefined);
	assert.equal(seen.body.tools, undefined);
	assert.match(JSON.stringify(seen.body.system), /JSON/);
});

test("Anthropic catalog providers all use header auth and their own endpoint", async () => {
	const providers = modelCatalogProviders.filter((provider) => provider.models.some((model) => model.api === "anthropic-messages"));
	assert.ok(providers.some((provider) => provider.id === "anthropic"));
	for (const provider of providers) {
		const model = provider.models.find((item) => item.api === "anthropic-messages");
		assert.ok(model, provider.id);
		let calls = 0;
		const extract = createCatalogTaskDraftExtractor(provider.id, model.id, "synthetic-anthropic-key", async (input, init) => {
			calls++;
			const sent = new Request(input, init);
			assert.ok(sent.url.startsWith(model.baseUrl + "/v1/messages"), provider.id);
			assert.equal(sent.headers.get("x-api-key"), "synthetic-anthropic-key", provider.id);
			assert.equal(sent.headers.get("authorization"), null, provider.id);
			return anthropicReply(JSON.stringify({ product: "连接测试" }));
		});
		assert.ok(extract, provider.id);
		assert.deepEqual(await extract("产品：连接测试", "overview"), { product: "连接测试" }, provider.id);
		assert.equal(calls, 1);
		// 目录模型不能被标成另一个协议去调用。
		assert.equal(createPersistedTaskDraftExtractor({
			...route, kind: "catalog", catalogId: provider.id, modelId: model.id,
			baseUrl: model.baseUrl, protocol: "openai-completions",
		}), undefined, provider.id);
	}
});

test("Anthropic rejects truncated, missing-terminal, non-JSON and upstream failures without retry", async () => {
	const replies = [
		() => anthropicReply("not JSON"),
		() => anthropicReply("[]"),
		() => anthropicReply('{"product":"产品"}', "max_tokens"),
		() => anthropicReply('{"product":"产品"}', "end_turn", false),
		() => anthropicReply("x".repeat(17 * 1024)),
		() => anthropicReply("x".repeat(513 * 1024)),
		() => new Response("event: error\ndata: synthetic upstream secret\n\n", { headers: { "content-type": "text/event-stream" } }),
		() => new Response("synthetic private detail", { status: 429 }),
		() => new Response(null, { status: 302, headers: { location: "https://other.example" } }),
		() => { throw new Error("synthetic transport detail"); },
	];
	for (const reply of replies) {
		let calls = 0;
		const extract = createPersistedTaskDraftExtractor(route, async () => { calls++; return reply(); });
		assert.ok(extract);
		assert.equal(await extract("产品"), null);
		assert.equal(calls, 1);
	}
});

test("Anthropic shares the request budget with the other protocols", async () => {
	let calls = 0;
	const limit = createTaskDraftRequestLimit();
	const extract = createPersistedTaskDraftExtractor(route, async () => { calls++; return anthropicReply("{}"); }, limit);
	assert.ok(extract);
	for (let index = 0; index < 8; index++) assert.deepEqual(await extract("产品"), {});
	assert.equal(await extract("产品"), null);
	const responses = createPersistedTaskDraftExtractor({ ...route, protocol: "openai-responses" }, async () => {
		throw new Error("budget must reject before transport");
	}, limit);
	assert.ok(responses);
	assert.equal(await responses("产品"), null);
	assert.equal(calls, 8);
});

test("Anthropic refuses a different host even with the same key", async () => {
	let calls = 0;
	const extract = createPersistedTaskDraftExtractor(route, async (input) => {
		const sent = new Request(input);
		calls++;
		assert.ok(sent.url.startsWith("https://claude.example/v1/messages"));
		return anthropicReply(JSON.stringify({ product: "连接测试" }));
	});
	assert.ok(extract);
	assert.deepEqual(await extract("产品：连接测试", "overview"), { product: "连接测试" });
	assert.equal(calls, 1);
});
