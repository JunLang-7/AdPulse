import assert from "node:assert/strict";
import test from "node:test";
import {
	createCatalogTaskDraftExtractor,
	createPersistedTaskDraftExtractor,
	createTaskDraftRequestLimit,
	type ModelRouteInput,
} from "../packages/runtime/dist/task-draft-extractor.js";
import { modelCatalogProviders } from "../packages/runtime/dist/model-catalog.js";
import { geminiEndpoint, isGeminiModelId, requestGeminiText } from "../packages/runtime/dist/model-gemini.js";
import { geminiReply, geminiText } from "./fixtures/google-generative-ai.ts";

const baseUrl = "https://generativelanguage.googleapis.com/v1beta";
const route: ModelRouteInput = {
	providerId: "synthetic-gemini", kind: "custom", baseUrl,
	protocol: "google-generative-ai", modelId: "gemini-synthetic", apiKey: "synthetic-google-key",
};

test("Gemini uses the REST stream endpoint with the key in a header only", async () => {
	let seen: { url: string; method: string; apiKey: string | null; authorization: string | null; body: Record<string, unknown> } | undefined;
	const extract = createPersistedTaskDraftExtractor(route, async (input, init) => {
		const sent = new Request(input, init);
		seen = {
			url: sent.url,
			method: sent.method,
			apiKey: sent.headers.get("x-goog-api-key"),
			authorization: sent.headers.get("authorization"),
			body: await sent.json() as Record<string, unknown>,
		};
		return geminiText(JSON.stringify({ product: "新品试用装", budget: 300 }));
	});
	assert.ok(extract);
	assert.deepEqual(await extract("新品试用装，投小红书", "overview"), { product: "新品试用装" });
	assert.ok(seen);
	// 密钥不进 URL；端点固定为 alt=sse 的流式接口。
	assert.equal(seen.url, `${baseUrl}/models/gemini-synthetic:streamGenerateContent?alt=sse`);
	assert.doesNotMatch(seen.url, /synthetic-google-key/u);
	assert.equal(seen.method, "POST");
	assert.equal(seen.apiKey, "synthetic-google-key");
	assert.equal(seen.authorization, null);
	const config = seen.body.generationConfig as Record<string, unknown>;
	assert.equal(config.temperature, 0);
	assert.equal(config.maxOutputTokens, 1024);
	assert.equal(config.responseMimeType, "application/json");
	assert.equal((seen.body.contents as { role: string }[])[0]?.role, "user");
	assert.match(JSON.stringify(seen.body.systemInstruction), /JSON/u);
});

test("every Gemini catalog provider routes through the same guarded endpoint", async () => {
	const providers = modelCatalogProviders.filter((provider) => provider.models.some((model) => model.api === "google-generative-ai"));
	assert.ok(providers.some((provider) => provider.id === "google"));
	for (const provider of providers) {
		const model = provider.models.find((item) => item.api === "google-generative-ai");
		assert.ok(model, provider.id);
		let calls = 0;
		const extract = createCatalogTaskDraftExtractor(provider.id, model.id, "synthetic-google-key", async (input, init) => {
			calls++;
			const sent = new Request(input, init);
			assert.equal(sent.url, geminiEndpoint(model.baseUrl, model.id), provider.id);
			assert.equal(sent.headers.get("x-goog-api-key"), "synthetic-google-key", provider.id);
			return geminiText(JSON.stringify({ product: "连接测试" }));
		});
		assert.ok(extract, provider.id);
		assert.deepEqual(await extract("产品：连接测试", "overview"), { product: "连接测试" }, provider.id);
		assert.equal(calls, 1);
		// 目录模型不能被标成别的协议。
		assert.equal(createPersistedTaskDraftExtractor({
			...route, kind: "catalog", catalogId: provider.id, modelId: model.id,
			baseUrl: model.baseUrl, protocol: "openai-completions",
		}), undefined, provider.id);
	}
});

test("Gemini fails closed on blocked, truncated, malformed, oversized and upstream errors", async () => {
	const cases: (() => Response)[] = [
		() => geminiReply([{ promptFeedback: { blockReason: "SAFETY" } }]),
		() => geminiText(JSON.stringify({ product: "产品" }), "MAX_TOKENS"),
		() => geminiText(JSON.stringify({ product: "产品" }), "SAFETY"),
		() => geminiReply([{ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }]),
		() => new Response("data: not-json\n\n", { headers: { "content-type": "text/event-stream" } }),
		() => new Response("x".repeat(513 * 1024), { headers: { "content-type": "text/event-stream" } }),
		() => geminiText("x".repeat(17 * 1024)),
		() => new Response("synthetic private detail", { status: 429 }),
		() => new Response(null, { status: 302, headers: { location: "https://other.example" } }),
		() => new Response("", { status: 200 }),
	];
	for (const reply of cases) {
		let calls = 0;
		const extract = createPersistedTaskDraftExtractor(route, async () => { calls++; return reply(); });
		assert.ok(extract);
		assert.equal(await extract("产品"), null);
		assert.equal(calls, 1, "每次只发一次请求，不重试");
	}
	const thrown = createPersistedTaskDraftExtractor(route, async () => {
		throw new Error("synthetic transport detail");
	});
	assert.ok(thrown);
	assert.equal(await thrown("产品"), null);
});

test("Gemini rejects model ids that would change the request path", async () => {
	let calls = 0;
	const fetchImpl = async () => { calls++; return geminiText("{}"); };
	for (const modelId of ["../models/other", "gemini/x", "a:b", "", "x".repeat(200)]) {
		const extract = createPersistedTaskDraftExtractor({ ...route, modelId }, fetchImpl);
		assert.ok(extract);
		assert.equal(await extract("产品"), null, modelId);
	}
	assert.equal(calls, 0, "非法 model id 在发请求前就被拒绝");
	assert.equal(isGeminiModelId("gemini-2.5-flash"), true);
	assert.equal(isGeminiModelId("models/gemini"), false);
});

test("Gemini shares the request budget with the other protocols", async () => {
	let calls = 0;
	const limit = createTaskDraftRequestLimit();
	const extract = createPersistedTaskDraftExtractor(route, async () => { calls++; return geminiText("{}"); }, limit);
	assert.ok(extract);
	for (let index = 0; index < 8; index++) assert.deepEqual(await extract("产品"), {});
	assert.equal(await extract("产品"), null);
	const chat = createPersistedTaskDraftExtractor({ ...route, protocol: "openai-completions" }, async () => {
		throw new Error("budget must reject before transport");
	}, limit);
	assert.ok(chat);
	assert.equal(await chat("产品"), null);
	assert.equal(calls, 8);
});

test("requestGeminiText returns a typed stop reason instead of guessing", async () => {
	const ok = await requestGeminiText({
		baseUrl, modelId: "gemini-synthetic", apiKey: "k", systemPrompt: "p", brief: "b",
		maxOutputTokens: 64, fetchImpl: async () => geminiText('{"a":1}'),
	});
	assert.deepEqual(ok, { text: '{"a":1}', stopReason: "stop" });
	const blocked = await requestGeminiText({
		baseUrl, modelId: "gemini-synthetic", apiKey: "k", systemPrompt: "p", brief: "b",
		maxOutputTokens: 64, fetchImpl: async () => geminiReply([{ promptFeedback: { blockReason: "SAFETY" } }]),
	});
	assert.deepEqual(blocked, { text: "", stopReason: "blocked" });
});
