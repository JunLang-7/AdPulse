import assert from "node:assert/strict";
import test from "node:test";
import { modelCatalogDocument } from "../packages/runtime/dist/model-catalog.generated.js";
import { findCatalogModel, modelCatalogProviders } from "../packages/runtime/dist/model-catalog.js";
import { createCatalogTaskDraftExtractor } from "../packages/runtime/dist/task-draft-extractor.js";

interface SdkModel {
	id: string;
	api: string;
	thinkingLevelMap?: unknown;
}

interface SdkProvider {
	id: string;
	name: string;
	baseUrl?: string;
	auth?: { apiKey?: { name?: string }; oauth?: unknown };
	getModels(): readonly SdkModel[];
}

// The SDK is a dependency of the runtime workspace, so load it from there
// instead of duplicating the pin in the root manifest. The direct dist path is
// used because the package only exposes import-conditioned subpaths.
const sdk = await import(new URL(
	"../packages/runtime/node_modules/@earendil-works/pi-ai/dist/providers/all.js",
	import.meta.url,
).href) as {
	builtinProviders(): SdkProvider[];
};

function providerReply(content: string): Response {
	const chunk = { id: "synthetic-completion", object: "chat.completion.chunk", created: 1, model: "synthetic" };
	const frames = [
		{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
		{ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	];
	return new Response(frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream" },
	});
}

test("generated catalog matches the locked pi-ai provider directory", () => {
	const providers = sdk.builtinProviders();
	assert.equal(modelCatalogProviders.length, providers.length);
	for (const provider of providers) {
		const entry = modelCatalogProviders.find((candidate) => candidate.id === provider.id);
		assert.ok(entry, `missing catalog entry for ${provider.id}`);
		assert.equal(entry.name, provider.name);
		assert.equal(entry.catalogModelCount, provider.getModels().length);
		assert.deepEqual(entry.auth, { apiKey: Boolean(provider.auth?.apiKey), name: provider.auth?.apiKey?.name ?? null, oauth: Boolean(provider.auth?.oauth) });
		assert.equal(entry.baseUrl, provider.baseUrl ?? null);
		const expectedModels = provider.getModels()
			.filter((model) => model.api === "openai-completions" || model.api === "openai-responses")
			.map((model) => model.id);
		const supported = expectedModels.length > 0 && Boolean(provider.baseUrl?.startsWith("https://")) && Boolean(provider.auth?.apiKey);
		assert.equal(entry.supported, supported, `support flag drifted for ${provider.id}`);
		assert.deepEqual(entry.models.map((model) => model.id), supported ? expectedModels : []);
		for (const model of entry.models.filter((item) => item.api === "openai-responses")) {
			assert.deepEqual(model.thinkingLevelMap, provider.getModels().find((item) => item.id === model.id)?.thinkingLevelMap, model.id);
		}
	}
	assert.equal(modelCatalogDocument.generatedFrom.package, "@earendil-works/pi-ai");
	assert.match(modelCatalogDocument.generatedFrom.version, /^\d+\.\d+\.\d+$/);
});

test("only API-key providers with wired native protocols are offered as connectable", () => {
	const supported = modelCatalogProviders.filter((provider) => provider.supported);
	assert.ok(supported.length >= 10, "expected a multi-provider catalog, not a single vendor");
	assert.ok(supported.some((provider) => provider.id === "deepseek"));
	for (const provider of supported) {
		assert.match(provider.baseUrl ?? "", /^https:\/\//);
		assert.equal(provider.reason, undefined);
		assert.ok(provider.models.length > 0);
		assert.ok(provider.models.every((model) => model.api === "openai-completions" || model.api === "openai-responses"));
	}
	for (const provider of modelCatalogProviders.filter((candidate) => !candidate.supported)) {
		assert.ok(provider.reason, `unsupported provider ${provider.id} needs a reason`);
		assert.deepEqual(provider.models, []);
	}
});

test("every connectable catalog provider routes a synthetic Chat Completions response", async () => {
	for (const provider of modelCatalogProviders.filter((entry) => entry.models.some((model) => model.api === "openai-completions"))) {
		const model = provider.models.find((model) => model.api === "openai-completions");
		assert.ok(model, provider.id);
		let calls = 0;
		const extract = createCatalogTaskDraftExtractor(provider.id, model.id, "synthetic-personal-key", async (input, init) => {
			calls++;
			const sent = new Request(input, init);
			assert.equal(sent.url, model.baseUrl + "/chat/completions", provider.id);
			assert.equal(sent.headers.get("authorization"), "Bearer synthetic-personal-key", provider.id);
			return providerReply(JSON.stringify({ product: "连接测试" }));
		});
		assert.ok(extract, provider.id);
		assert.deepEqual(await extract("产品：连接测试", "overview"), { product: "连接测试" }, provider.id);
		assert.equal(calls, 1, provider.id);
	}
});

test("catalog extractor calls the vendor endpoint with the personal key and model id", async () => {
	assert.ok(findCatalogModel("xiaomi", "mimo-v2.6-flash"));
	assert.equal(findCatalogModel("openai", "gpt-4")?.api, "openai-responses");
	const extract = createCatalogTaskDraftExtractor("xiaomi", "mimo-v2.6-flash", "synthetic-mimo-key", async (input, init) => {
		const sent = new Request(input, init);
		assert.equal(sent.url, "https://api.xiaomimimo.com/v1/chat/completions");
		assert.equal(sent.method, "POST");
		assert.equal(sent.redirect, "error");
		assert.equal(sent.headers.get("authorization"), "Bearer synthetic-mimo-key");
		const body = await sent.json();
		assert.equal(body.model, "mimo-v2.6-flash");
		assert.deepEqual(body.response_format, { type: "json_object" });
		assert.equal(body.max_completion_tokens ?? body.max_tokens, 1024);
		assert.equal(body.stream, true);
		assert.equal(body.tools, undefined);
		return providerReply(JSON.stringify({ channels: ["小红书"] }));
	});
	assert.ok(extract);
	assert.deepEqual(await extract("产品投小红书", "channels"), { channels: ["小红书"] });
});

test("catalog extractor never falls back to another provider, model or deployment key", async () => {
	assert.equal(createCatalogTaskDraftExtractor("openai", "not-in-catalog", "synthetic-key"), undefined);
	assert.equal(createCatalogTaskDraftExtractor("deepseek", "unknown-model", "synthetic-key"), undefined);
	assert.equal(createCatalogTaskDraftExtractor("deepseek", "deepseek-flash", "   "), undefined);
	let called = false;
	const extract = createCatalogTaskDraftExtractor("deepseek", "deepseek-v4-pro", "synthetic-key", async () => {
		called = true;
		return providerReply("not JSON");
	});
	assert.ok(extract);
	assert.equal(await extract("产品", "overview"), null);
	assert.equal(called, true);
});
