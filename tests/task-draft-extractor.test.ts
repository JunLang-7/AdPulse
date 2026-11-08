import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createApi } from "../apps/api/dist/server.js";
import { compose, type Runtime } from "../packages/runtime/dist/index.js";
import { createDeepSeekTaskDraftExtractor } from "../packages/runtime/dist/task-draft-extractor.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

function providerReply(content: unknown, finishReason = "stop"): Response {
	return Response.json({
		choices: [{ finish_reason: finishReason, message: { content } }],
	});
}

test("task draft extracts only bounded, distinct excerpts from the submitted brief", async () => {
	const names = Array.from({ length: 9 }, (_, index) => `人群${index + 1}`);
	const objective = "长".repeat(321);
	const brief = `新品试用装。增加到店咨询。小红书。方便携带。抖音。${names.join("。")}。${objective}。constructor。预算 300 元。`;
	const extract = createDeepSeekTaskDraftExtractor("synthetic-provider-key", async (url, init) => {
		assert.equal(url, "https://api.deepseek.com/chat/completions");
		assert.equal(init?.method, "POST");
		assert.equal(init?.redirect, "error");
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-provider-key");
		assert.ok(init?.signal instanceof AbortSignal);
		assert.equal(typeof init?.body, "string");
		const request = JSON.parse(String(init?.body));
		assert.equal(request.model, "deepseek-flash");
		assert.deepEqual(request.thinking, { type: "disabled" });
		assert.deepEqual(request.response_format, { type: "json_object" });
		assert.equal(request.max_tokens, 1024);
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
		() => new Response("synthetic private provider detail", { status: 429 }),
		() => { throw new Error("synthetic transport detail"); },
	];
	for (const reply of replies) {
		const extract = createDeepSeekTaskDraftExtractor("synthetic-provider-key", async () => reply());
		assert.ok(extract);
		assert.equal(await extract("产品"), null);
	}
});

test("task draft ignores unsupported field values and keeps valid empty results", async () => {
	const extract = createDeepSeekTaskDraftExtractor("synthetic-provider-key", async () =>
		providerReply(JSON.stringify({ product: ["产品"], objective: 100, channels: "小红书" })));
	assert.ok(extract);
	assert.deepEqual(await extract("产品，发在小红书"), {});
});

test("task draft uses an instance-local provider call limit", async () => {
	let calls = 0;
	const extract = createDeepSeekTaskDraftExtractor("synthetic-provider-key", async () => {
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
	const extract = createDeepSeekTaskDraftExtractor("synthetic-provider-key", () =>
		new Promise<Response>((resolve) => { started.push(resolve); }));
	assert.ok(extract);
	const first = extract("测试一");
	const second = extract("测试二");
	assert.equal(await extract("测试三"), null);
	assert.equal(started.length, 2);
	started[0]?.(providerReply("bad response"));
	assert.equal(await first, null);
	const third = extract("测试三");
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
	let received = "";
	const url = await serve(t, {
		...runtime,
		extractTaskDraft: async (brief) => {
			received = brief;
			return { product: brief };
		},
	});
	assert.equal((await request(url, { brief: "试用装" }, "invalid")).status, 401);
	for (const invalid of [{ brief: "   " }, { brief: "x".repeat(2501) }, { brief: "试用装", userId: "spoofed" }])
		assert.equal((await request(url, invalid)).status, 400);
	assert.equal(received, "");
	const extracted = await request(url, { brief: "  试用装  " });
	assert.equal(extracted.status, 200);
	assert.equal(extracted.headers.get("cache-control"), "no-store");
	assert.deepEqual(await extracted.json(), { product: "试用装" });
	assert.equal(received, "试用装");
	assert.deepEqual(await runtime.tasks.list("task-draft-test-owner"), []);
	assert.equal(await runtime.worker.runOnce(), false);
});

test("task draft endpoint returns a generic unavailable error without a configured key", async (t) => {
	assert.equal(createDeepSeekTaskDraftExtractor("  "), undefined);
	const url = await serve(t, compose(new MemoryStorage(), []));
	const response = await request(url, { brief: "试用装" });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "task draft extraction unavailable" });
});

test("task draft endpoint returns a generic unavailable error for upstream failure", async (t) => {
	const extract = createDeepSeekTaskDraftExtractor("synthetic-provider-key", async () =>
		Response.json({ error: "synthetic private provider error" }, { status: 401 }));
	assert.ok(extract);
	const url = await serve(t, { ...compose(new MemoryStorage(), []), extractTaskDraft: extract });
	const response = await request(url, { brief: "试用装" });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "task draft extraction unavailable" });
});
