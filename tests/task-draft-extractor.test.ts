import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createApi } from "../apps/api/dist/server.js";
import { compose, type Runtime } from "../packages/runtime/dist/index.js";
import { createTaskDraftExtractor, type TaskDraftStage } from "../packages/runtime/dist/task-draft-extractor.js";
import { createTaskDraftModels } from "../packages/runtime/dist/task-draft-models.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const deepseekEnv = { DEEPSEEK_API_KEY: "synthetic-provider-key" };

function providerReply(content: string, finishReason = "stop"): Response {
	const chunk = { id: "synthetic-completion", object: "chat.completion.chunk", created: 1, model: "deepseek-flash" };
	const frames = [
		{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
		{ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
	];
	const stream = frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n";
	return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

test("task draft extracts only bounded, distinct excerpts from the submitted brief", async () => {
	const names = Array.from({ length: 9 }, (_, index) => `人群${index + 1}`);
	const objective = "长".repeat(321);
	const brief = `新品试用装。增加到店咨询。小红书。方便携带。抖音。${names.join("。")}。${objective}。constructor。预算 300 元。`;
	const extract = createTaskDraftExtractor(deepseekEnv, async (url, init) => {
		const sent = new Request(url, init);
		assert.equal(sent.url, "https://api.deepseek.com/chat/completions");
		assert.equal(sent.method, "POST");
		assert.equal(sent.redirect, "error");
		assert.equal(sent.headers.get("authorization"), "Bearer synthetic-provider-key");
		assert.ok(init?.signal instanceof AbortSignal);
		const request = await sent.json();
		assert.equal(request.model, "deepseek-flash");
		assert.deepEqual(request.thinking, { type: "disabled" });
		assert.deepEqual(request.response_format, { type: "json_object" });
		assert.equal(request.max_tokens, 1024);
		assert.equal(request.stream, true);
		assert.equal(request.tools, undefined);
		assert.match(request.messages[0].content, /JSON/);
		assert.deepEqual(request.messages[1], { role: "user", content: brief });
		assert.equal(request.messages.length, 2);
		return providerReply(JSON.stringify({
			product: " 新品试用装 ",
			objective,
			audience: [null, "陌生人", names[0], ...names],
			sellingPoints: ["方便携带", "耐用"],
			channels: [{ name: "小红书", budget: 300 }, "小红书", "constructor", "  抖音  ", "小红书"],
			budget: 300,
			startDate: "2026-12-01",
			rules: { minimumSpendMinor: 30000 },
			enabled: true,
		}));
	});
	assert.ok(extract);
	assert.deepEqual(await extract(brief), {
		product: "新品试用装",
		audience: names.slice(0, 8),
		sellingPoints: ["方便携带"],
		channels: ["小红书", "抖音"],
	});
});

test("task draft handles invalid replies, non-success status and provider errors", async () => {
	const replies = [
		() => providerReply("not JSON"),
		() => providerReply("  "),
		() => providerReply("[]"),
		() => providerReply(JSON.stringify({ product: "产品" }), "length"),
		() => providerReply("x".repeat(17 * 1024)),
		() => new Response("x".repeat(513 * 1024), { headers: { "content-type": "text/event-stream" } }),
		() => new Response("synthetic private provider detail", { status: 429 }),
		() => { throw new Error("synthetic transport detail"); },
	];
	for (const reply of replies) {
		const extract = createTaskDraftExtractor(deepseekEnv, async () => reply());
		assert.ok(extract);
		assert.equal(await extract("产品"), null);
	}
});

test("task draft ignores unsupported field values and keeps valid empty results", async () => {
	const extract = createTaskDraftExtractor(deepseekEnv, async () =>
		providerReply(JSON.stringify({ product: ["产品"], objective: 100, channels: "小红书" })));
	assert.ok(extract);
	assert.deepEqual(await extract("产品，发在小红书"), {});
});

test("task draft uses an instance-local provider call limit", async () => {
	let calls = 0;
	const extract = createTaskDraftExtractor(deepseekEnv, async () => {
		calls++;
		return providerReply("{}");
	});
	assert.ok(extract);
	for (let index = 0; index < 8; index++)
		assert.deepEqual(await extract("测试"), {});
	assert.equal(await extract("测试"), null);
	assert.equal(calls, 8);
});

test("task draft bounds simultaneous calls and releases slots on provider completion", async () => {
	const started: Array<(response: Response) => void> = [];
	let arrived: (() => void) | undefined;
	const nextArrival = () => new Promise<void>((resolve) => { arrived = resolve; });
	const extract = createTaskDraftExtractor(deepseekEnv, () =>
		new Promise<Response>((resolve) => {
			started.push(resolve);
			arrived?.();
		}));
	assert.ok(extract);
	const firstStarted = nextArrival();
	const first = extract("测试一");
	await firstStarted;
	const secondStarted = nextArrival();
	const second = extract("测试二");
	await secondStarted;
	assert.equal(await extract("测试三"), null);
	assert.equal(started.length, 2);
	started[0]?.(providerReply("bad response"));
	assert.equal(await first, null);
	const thirdStarted = nextArrival();
	const third = extract("测试三");
	await thirdStarted;
	assert.equal(started.length, 3);
	started[1]?.(providerReply("{}"));
	started[2]?.(providerReply("{}"));
	assert.deepEqual(await second, {});
	assert.deepEqual(await third, {});
});

const token = "synthetic-console-token-000";
async function serve(t: TestContext, runtime: Runtime) {
	const server = createApi(runtime, { token, userId: "task-draft-test-owner" });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return `http://127.0.0.1:${address.port}`;
}

function request(url: string, input: unknown, authorization = `Bearer ${token}`) {
	return fetch(url + "/api/task-drafts/extract", {
		method: "POST",
		headers: { authorization, "content-type": "application/json" },
		body: JSON.stringify(input),
	});
}

test("task draft endpoint authenticates, validates and creates no task or jobs", async (t) => {
	const runtime = compose(new MemoryStorage(), []);
	let received: { brief: string; stage: TaskDraftStage | undefined } | undefined;
	const url = await serve(t, {
		...runtime,
		extractTaskDraft: async (brief, stage) => {
			received = { brief, stage };
			return { product: brief };
		},
	});
	assert.equal((await request(url, { brief: "试用装" }, "invalid")).status, 401);
	for (const invalid of [{ brief: "   " }, { brief: "x".repeat(2501) }, { brief: "试用装", userId: "spoofed" }, { brief: "试用装", stage: "unknown" }])
		assert.equal((await request(url, invalid)).status, 400);
	assert.equal(received, undefined);
	const extracted = await request(url, { brief: "  试用装  " });
	assert.equal(extracted.status, 200);
	assert.equal(extracted.headers.get("cache-control"), "no-store");
	assert.deepEqual(await extracted.json(), { product: "试用装" });
	assert.deepEqual(received, { brief: "试用装", stage: undefined });
	assert.equal((await request(url, { brief: "试用装", stage: "overview" })).status, 200);
	assert.deepEqual(received, { brief: "试用装", stage: "overview" });
	assert.deepEqual(await runtime.tasks.list("task-draft-test-owner"), []);
	assert.equal(await runtime.worker.runOnce(), false);
});

test("task draft endpoint returns a generic unavailable error without a configured key", async (t) => {
	assert.equal(createTaskDraftExtractor({ DEEPSEEK_API_KEY: "  " }), undefined);
	const url = await serve(t, compose(new MemoryStorage(), []));
	const response = await request(url, { brief: "试用装" });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "task draft extraction unavailable" });
});

test("task draft endpoint returns a generic unavailable error for upstream failure", async (t) => {
	const extract = createTaskDraftExtractor(deepseekEnv, async () =>
		Response.json({ error: "synthetic private provider error" }, { status: 401 }));
	assert.ok(extract);
	const url = await serve(t, { ...compose(new MemoryStorage(), []), extractTaskDraft: extract });
	const response = await request(url, { brief: "试用装" });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "task draft extraction unavailable" });
});

test("task draft accepts only the selected stage even when other fields match the brief", async () => {
	const brief = "试用装。增加到店咨询。王女士。方便携带。小红书。";
	const fields = {
		product: "试用装",
		objective: "增加到店咨询",
		audience: ["王女士"],
		sellingPoints: ["方便携带"],
		channels: ["小红书"],
	};
	const prompts: string[] = [];
	const extract = createTaskDraftExtractor(deepseekEnv, async (input, init) => {
		const sent = new Request(input, init);
		const request = await sent.json();
		prompts.push(request.messages[0].content);
		assert.deepEqual(request.messages[1], { role: "user", content: brief });
		return providerReply(JSON.stringify(fields));
	});
	assert.ok(extract);
	assert.deepEqual(await extract(brief, "overview"), { product: "试用装", objective: "增加到店咨询" });
	assert.deepEqual(await extract(brief, "audience"), { audience: ["王女士"], sellingPoints: ["方便携带"] });
	assert.deepEqual(await extract(brief, "channels"), { channels: ["小红书"] });
	assert.deepEqual(await extract(brief), fields);
	assert.match(prompts[0] ?? "", /仅使用这些键：product（产品或服务名称）、objective/);
	assert.doesNotMatch(prompts[0] ?? "", /"audience"|"channels"/);
	assert.doesNotMatch(prompts[1] ?? "", /"product"|"channels"/);
	assert.doesNotMatch(prompts[2] ?? "", /"audience"|"product"/);
});

test("task draft uses an explicitly configured HTTPS gateway and never falls back", async () => {
	const env = {
		DEEPSEEK_API_KEY: "synthetic-default-key",
		TASK_DRAFT_PROVIDER: "openai-compatible",
		TASK_DRAFT_GATEWAY_BASE_URL: "https://gateway.example/v1/",
		TASK_DRAFT_GATEWAY_MODEL: "gateway-model",
		TASK_DRAFT_GATEWAY_API_KEY: "synthetic-gateway-key",
	};
	let count = 0;
	const extract = createTaskDraftExtractor(env, async (input, init) => {
		count++;
		const sent = new Request(input, init);
		assert.equal(sent.url, "https://gateway.example/v1/chat/completions");
		assert.equal(sent.headers.get("authorization"), "Bearer synthetic-gateway-key");
		assert.equal(sent.redirect, "error");
		const request = await sent.json();
		assert.equal(request.model, "gateway-model");
		assert.equal(request.thinking, undefined);
		assert.equal(request.max_tokens, 1024);
		assert.deepEqual(request.response_format, { type: "json_object" });
		return count === 1 ? providerReply('{"channels":["小红书"]}') : new Response("busy", { status: 429 });
	});
	assert.ok(extract);
	assert.deepEqual(await extract("小红书", "channels"), { channels: ["小红书"] });
	assert.equal(await extract("小红书", "channels"), null);
	assert.equal(count, 2);
	for (const baseUrl of ["http://gateway.example/v1", "https://user:pass@gateway.example/v1", "https://gateway.example/v1?secret=x", "https://gateway.example/v1#path"])
		assert.equal(createTaskDraftExtractor({ ...env, TASK_DRAFT_GATEWAY_BASE_URL: baseUrl }), undefined);
	assert.equal(createTaskDraftExtractor({ ...env, TASK_DRAFT_GATEWAY_API_KEY: undefined }), undefined);
	assert.equal(createTaskDraftExtractor({ ...env, TASK_DRAFT_PROVIDER: "unsupported" }), undefined);
});

test("configured model selection routes only to the chosen provider", async () => {
	const urls: string[] = [];
	const models = createTaskDraftModels({
		...deepseekEnv,
		TASK_DRAFT_GATEWAY_BASE_URL: "https://gateway.example/v1",
		TASK_DRAFT_GATEWAY_MODEL: "synthetic-alt",
		TASK_DRAFT_GATEWAY_API_KEY: "synthetic-gateway-key",
	}, async (input, init) => {
		const sent = new Request(input, init);
		urls.push(sent.url);
		return providerReply("{}");
	});
	assert.deepEqual(models.list("owner").models.map(({ id, status }) => [id, status]), [
		["deepseek", "configured"], ["openai-compatible", "configured"],
	]);
	assert.deepEqual(await models.extract("owner", "openai-compatible", "产品", "overview"), {});
	assert.deepEqual(await models.extract("owner", undefined, "产品", "overview"), {});
	assert.deepEqual(urls, ["https://gateway.example/v1/chat/completions", "https://api.deepseek.com/chat/completions"]);
});

test("temporary model credentials are verified, isolated, redacted, removable and expire", async (t) => {
	let now = 0;
	const requests: { auth: string | null; brief: string }[] = [];
	const models = createTaskDraftModels({ TASK_DRAFT_USER_KEYS_ENABLED: "1" }, async (input, init) => {
		const sent = new Request(input, init);
		const body = await sent.json();
		requests.push({ auth: sent.headers.get("authorization"), brief: body.messages[1].content });
		return providerReply("{}");
	}, () => now);
	const base = await serve(t, { ...compose(new MemoryStorage(), []), taskDraftModels: models });
	const url = base + "/api/task-drafts/models";
	assert.equal((await fetch(url)).status, 401);
	const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
	const connect = () => fetch(url, { method: "PUT", headers, body: JSON.stringify({ provider: "deepseek", apiKey: "synthetic-personal-key" }) });
	const connected = await connect();
	assert.equal(connected.status, 200);
	assert.equal(connected.headers.get("cache-control"), "no-store");
	const result = await connected.text();
	assert.match(result, /connected/);
	assert.doesNotMatch(result, /synthetic-personal-key/);
	assert.equal(models.list("other-owner").models[0]?.status, "unconfigured");
	assert.equal(await models.extract("other-owner", "deepseek", "其他用户资料"), null);
	assert.deepEqual(requests, [{ auth: "Bearer synthetic-personal-key", brief: "产品：连接测试" }]);
	assert.equal((await request(base, { provider: "deepseek", stage: "overview", brief: "本用户资料" })).status, 200);
	assert.equal((await fetch(url + "?provider=deepseek", { method: "DELETE", headers })).status, 200);
	assert.equal((await request(base, { provider: "deepseek", brief: "不能再调用" })).status, 503);
	assert.equal((await connect()).status, 200);
	now = 8 * 60 * 60 * 1000;
	assert.equal(models.list("task-draft-test-owner").models[0]?.status, "unconfigured");
});

test("connection changes are disabled unless enabled by deployment", async (t) => {
	const models = createTaskDraftModels({}, async () => { throw new Error("unexpected network"); });
	const base = await serve(t, { ...compose(new MemoryStorage(), []), taskDraftModels: models });
	const response = await fetch(base + "/api/task-drafts/models", {
		method: "PUT",
		headers: { authorization: "Bearer " + token, "content-type": "application/json" },
		body: JSON.stringify({ provider: "deepseek", apiKey: "synthetic-personal-key" }),
	});
	assert.equal(response.status, 403);
});
