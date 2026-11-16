import assert from "node:assert/strict";
import test from "node:test";
import { createPersistedTaskDraftExtractor, createCatalogTaskDraftExtractor, createTaskDraftRequestLimit, type ModelRouteInput } from "../packages/runtime/dist/task-draft-extractor.js";
import { modelCatalogProviders } from "../packages/runtime/dist/model-catalog.js";
import { responsesReply } from "./fixtures/openai-responses.ts";

const route: ModelRouteInput = {
	providerId: "synthetic-gateway", kind: "custom", baseUrl: "https://gateway.example/v1",
	protocol: "openai-responses", modelId: "synthetic-model", apiKey: "synthetic-personal-key",
};

test("Responses uses native request fields and bounded excerpt extraction", async () => {
	const extract = createPersistedTaskDraftExtractor(route, async (input, init) => {
		const sent = new Request(input, init);
		assert.equal(sent.url, route.baseUrl + "/responses");
		assert.equal(sent.method, "POST");
		assert.equal(sent.redirect, "error");
		assert.equal(sent.headers.get("authorization"), "Bearer " + route.apiKey);
		assert.ok(init?.signal instanceof AbortSignal);
		const body = await sent.json();
		assert.equal(body.model, route.modelId);
		assert.equal(body.stream, true);
		assert.equal(body.store, false);
		assert.equal(body.max_output_tokens, 1024);
		assert.deepEqual(body.text, { format: { type: "json_object" } });
		assert.equal(body.response_format, undefined);
		assert.equal(body.messages, undefined);
		assert.equal(body.temperature, undefined);
		assert.equal(body.tools, undefined);
		assert.equal(body.input.length, 2);
		assert.match(JSON.stringify(body.input), /新品试用装/);
		return responsesReply(JSON.stringify({ product: "新品试用装", objective: "猜测目标", budget: 300, channels: ["小红书"] }));
	});
	assert.ok(extract);
	assert.deepEqual(await extract("新品试用装，投小红书", "overview"), { product: "新品试用装" });
});

test("every Responses catalog provider uses its own endpoint and personal bearer key", async () => {
	const providers = modelCatalogProviders.filter((provider) => provider.models.some((model) => model.api === "openai-responses"));
	assert.ok(providers.some((provider) => provider.id === "openai"));
	for (const provider of providers) {
		const model = provider.models.find((model) => model.api === "openai-responses");
		assert.ok(model);
		let requests = 0;
		const extract = createCatalogTaskDraftExtractor(provider.id, model.id, "synthetic-personal-key", async (input, init) => {
			requests++;
			const sent = new Request(input, init);
			assert.equal(sent.url, model.baseUrl + "/responses", provider.id);
			assert.equal(sent.headers.get("authorization"), "Bearer synthetic-personal-key");
			return responsesReply(JSON.stringify({ product: "连接测试" }));
		});
		assert.ok(extract, provider.id);
		assert.deepEqual(await extract("产品：连接测试", "overview"), { product: "连接测试" }, provider.id);
		assert.equal(requests, 1);
		assert.equal(createPersistedTaskDraftExtractor({ ...route, kind: "catalog", catalogId: provider.id, modelId: model.id, baseUrl: model.baseUrl, protocol: "openai-completions" }), undefined);
	}
});

test("Responses preserves SDK reasoning-off compatibility instead of assuming every model accepts none", async () => {
	for (const [modelId, expected] of [["gpt-5", undefined], ["o3", undefined], ["gpt-5.1", "none"]] as const) {
		let calls = 0;
		const extract = createCatalogTaskDraftExtractor("openai", modelId, "synthetic-key", async (input, init) => {
			calls++;
			const sent = new Request(input, init);
			const body = await sent.json();
			assert.equal(body.reasoning?.effort, expected, modelId);
			return responsesReply(JSON.stringify({ product: "连接测试" }));
		});
		assert.ok(extract);
		assert.deepEqual(await extract("产品：连接测试", "overview"), { product: "连接测试" });
		assert.equal(calls, 1);
	}
});

test("Responses rejects malformed, incomplete, missing-terminal and upstream-error replies without retry", async () => {
	const replies = [
		() => responsesReply("not JSON"),
		() => responsesReply("[]"),
		() => responsesReply('{"product":"产品"}', "incomplete"),
		() => responsesReply('{"product":"产品"}', "completed", false),
		() => responsesReply("x".repeat(17 * 1024)),
		() => responsesReply("x".repeat(513 * 1024)),
		() => responsesReply("{}", "failed"),
		() => new Response("synthetic upstream secret", { status: 429 }),
		() => new Response(null, { status: 302, headers: { location: "https://other.example" } }),
		() => { throw new Error("synthetic private transport detail"); },
	];
	for (const reply of replies) {
		let calls = 0;
		const extract = createPersistedTaskDraftExtractor(route, async () => { calls++; return reply(); });
		assert.ok(extract);
		assert.equal(await extract("产品"), null);
		assert.equal(calls, 1);
	}
});

test("Responses shares the existing request budget with Chat Completions", async () => {
	let calls = 0;
	const limit = createTaskDraftRequestLimit();
	const extract = createPersistedTaskDraftExtractor(route, async () => { calls++; return responsesReply("{}"); }, limit);
	assert.ok(extract);
	for (let index = 0; index < 8; index++) assert.deepEqual(await extract("产品"), {});
	assert.equal(await extract("产品"), null);
	const chat = createPersistedTaskDraftExtractor({ ...route, protocol: "openai-completions" }, async () => { throw new Error("budget must reject before transport"); }, limit);
	assert.ok(chat);
	assert.equal(await chat("产品"), null);
	assert.equal(calls, 8);
});
