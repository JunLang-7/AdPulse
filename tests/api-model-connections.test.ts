// 个人模型连接的 HTTP 契约（#86 PR2）：鉴权、归属、密钥只写、版本冲突、
// 测试通过才落库、缺少主密钥时失败关闭，以及抽取只走本人连接。

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createApi } from "../apps/api/dist/server.js";
import { AuthenticationService } from "../packages/core/dist/index.js";
import { compose, createModelConnections, type Runtime } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { responsesReply } from "./fixtures/openai-responses.ts";
import { anthropicReply } from "./fixtures/anthropic-messages.ts";

const cipherEnv = () => ({
	MODEL_CREDENTIAL_KEYRING: `v1:${randomBytes(32).toString("base64")}`,
	MODEL_CREDENTIAL_ACTIVE_KEY: "v1",
});

function providerReply(content: string): Response {
	const chunk = { id: "synthetic-completion", object: "chat.completion.chunk", created: 1, model: "synthetic" };
	const frames = [
		{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
		{ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	];
	const stream = frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n";
	return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

const customInput = (overrides: Record<string, unknown> = {}) => ({
	providerId: "mimo",
	kind: "custom" as const,
	displayName: "MiMo",
	baseUrl: "https://api.mimotest.example/v1",
	protocol: "openai-completions" as const,
	models: [{ id: "mimo-v2-flash", label: "MiMo Flash" }],
	apiKey: "synthetic-personal-key",
	...overrides,
});

type Fixture = {
	runtime: Runtime;
	storage: MemoryStorage;
	requests: { url: string; auth: string | null; model: string }[];
};

function withModels(options: { env?: Record<string, string>; reply?: () => Response; storage?: MemoryStorage } = {}) {
	const storage = options.storage ?? new MemoryStorage();
	const requests: Fixture["requests"] = [];
	const modelConnections = createModelConnections(storage, options.env ?? cipherEnv(), async (input, init) => {
		const sent = new Request(input, init);
		const body = sent.method === "GET" ? {} : await sent.json() as { model?: string };
		requests.push({ url: sent.url, auth: sent.headers.get("authorization"), model: body.model ?? "" });
		return options.reply?.() ?? providerReply(JSON.stringify({ product: "产品" }));
	});
	const runtime: Runtime = { ...compose(storage, []), modelConnections };
	return { runtime, storage, requests };
}

async function serve(
	t: TestContext,
	runtime: Runtime,
	verifiedAt = new Date().toISOString(),
	externalId = "ou-model-owner",
	audit?: (event: { event: string; path: string; result: string; connectionId?: string; version?: number; status?: number }) => void,
) {
	const service = new AuthenticationService(runtime.storage);
	const publicOrigin = "http://localhost";
	const token = randomBytes(32).toString("base64url");
	const session = await service.createWebSession({
		platform: "feishu",
		applicationId: "cli_model_test",
		tenantId: "tenant-model-test",
		idType: "open_id",
		externalId,
	}, createHash("sha256").update(token).digest("hex"), verifiedAt);
	const server = createApi(runtime, {
		service,
		publicOrigin,
		provider: {
			authorizationUrl() { throw new Error("unexpected OAuth request"); },
			async verifyAuthorizationCode() { throw new Error("unexpected OAuth callback"); },
		},
		...(audit ? { audit: audit as never } : {}),
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		url: `http://127.0.0.1:${address.port}`,
		userId: session.userId,
		headers: {
			cookie: `adpulse_session=${token}`,
			origin: publicOrigin,
			"content-type": "application/json",
		},
	};
}

const call = (server: Awaited<ReturnType<typeof serve>>, path: string, method = "GET", body?: unknown, headers: HeadersInit = server.headers) =>
	fetch(server.url + path, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

test("model connections API: unavailable without a valid master keyring", async (t) => {
	const storage = new MemoryStorage();
	const runtime: Runtime = { ...compose(storage, []), modelConnections: createModelConnections(storage, {}) };
	assert.equal(runtime.modelConnections, undefined);
	const server = await serve(t, runtime);
	assert.equal((await call(server, "/api/me/model-connections")).status, 503);
	assert.equal((await call(server, "/api/me/model-connections", "POST", customInput())).status, 503);
	assert.equal((await call(server, "/api/me/model-preferences", "PUT", { expectedVersion: 0 })).status, 503);
});

test("model connections API: authentication, origin and validation failures", async (t) => {
	const { runtime } = withModels();
	const server = await serve(t, runtime);
	assert.equal((await call(server, "/api/me/model-connections", "GET", undefined, { "content-type": "application/json" })).status, 401);
	assert.equal(
		(await call(server, "/api/me/model-connections", "POST", customInput(), { ...server.headers, origin: "https://other.example" })).status,
		403,
	);
	for (const invalid of [
		{ ...customInput(), providerId: "__proto__" },
		{ ...customInput(), baseUrl: "http://api.mimotest.example/v1" },
		{ ...customInput(), baseUrl: "https://user:pass@api.mimotest.example/v1" },
		{ ...customInput(), models: [] },
		{ ...customInput(), apiKey: "short" },
		{ ...customInput(), kind: "catalog" },
		{ ...customInput(), extra: true },
	]) {
		assert.equal((await call(server, "/api/me/model-connections", "POST", invalid)).status, 400, JSON.stringify(invalid));
	}
	// 未接通的协议明确拒绝，不假装可用也不降级成 Chat Completions。
	assert.equal(
		(await call(server, "/api/me/model-connections", "POST", { ...customInput(), protocol: "google-generative-ai" })).status,
		422,
	);
	assert.equal((await call(server, "/api/me/model-connections/test", "POST", { ...customInput(), protocol: "google-generative-ai" })).status, 422);
});

test("model connections API: empty JSON cannot verify or save a connection", async (t) => {
	const { runtime } = withModels({ reply: () => providerReply("{}") });
	const server = await serve(t, runtime);
	assert.deepEqual(await (await call(server, "/api/me/model-connections/test", "POST", customInput())).json(), { ok: false });
	assert.equal((await call(server, "/api/me/model-connections", "POST", customInput())).status, 503);
	assert.deepEqual((await runtime.modelConnections?.service.view(server.userId))?.connections, []);
});

test("model connections API: Responses tests, persists and extracts through the native adapter", async (t) => {
	const { runtime, requests } = withModels({ reply: () => responsesReply(JSON.stringify({ product: "连接测试" })) });
	const server = await serve(t, runtime);
	const input = { ...customInput(), protocol: "openai-responses" };
	assert.deepEqual(await (await call(server, "/api/me/model-connections/test", "POST", input)).json(), { ok: true });
	const created = await call(server, "/api/me/model-connections", "POST", input);
	assert.equal(created.status, 201);
	const connection = await created.json() as { id: string; protocol: string };
	assert.equal(connection.protocol, "openai-responses");
	const extraction = await call(server, "/api/task-drafts/extract", "POST", {
		connectionId: connection.id, brief: "产品：连接测试", stage: "overview",
	});
	assert.equal(extraction.status, 200);
	assert.deepEqual(await extraction.json(), { product: "连接测试" });
	assert.equal(requests.length, 3);
	for (const request of requests) {
		assert.equal(request.url, "https://api.mimotest.example/v1/responses");
		assert.equal(request.auth, "Bearer synthetic-personal-key");
	}
	const stale = await serve(t, runtime, new Date(Date.now() - 20 * 60_000).toISOString());
	assert.equal((await call(stale, "/api/me/model-connections/test", "POST", input)).status, 401);
	assert.equal(requests.length, 3);
});

test("model connections API: catalog Responses cannot be mislabeled as Chat Completions", async (t) => {
	const { runtime, requests } = withModels({ reply: () => responsesReply(JSON.stringify({ product: "连接测试" })) });
	const server = await serve(t, runtime);
	const input = { ...customInput(), kind: "catalog", catalogId: "openai", providerId: "openai", baseUrl: "https://api.openai.com/v1", models: [{ id: "gpt-4" }] };
	assert.equal((await call(server, "/api/me/model-connections", "POST", input)).status, 503);
	assert.equal(requests.length, 0);
	assert.equal((await call(server, "/api/me/model-connections", "POST", { ...input, protocol: "openai-responses" })).status, 201);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.url, "https://api.openai.com/v1/responses");
});

test("model connections API: Anthropic Messages tests, persists and extracts with header auth", async (t) => {
	const seen: { url: string; apiKey: string | null; authorization: string | null }[] = [];
	const storage = new MemoryStorage();
	const modelConnections = createModelConnections(storage, cipherEnv(), async (input, init) => {
		const sent = new Request(input, init);
		if (sent.method !== "GET") seen.push({ url: sent.url, apiKey: sent.headers.get("x-api-key"), authorization: sent.headers.get("authorization") });
		return anthropicReply(JSON.stringify({ product: "连接测试" }));
	});
	const server = await serve(t, { ...compose(storage, []), modelConnections });
	const input = { ...customInput(), providerId: "claude-gateway", baseUrl: "https://claude.example", protocol: "anthropic-messages" };
	assert.deepEqual(await (await call(server, "/api/me/model-connections/test", "POST", input)).json(), { ok: true });
	const created = await call(server, "/api/me/model-connections", "POST", input);
	assert.equal(created.status, 201);
	const connection = await created.json() as { id: string; protocol: string };
	assert.equal(connection.protocol, "anthropic-messages");
	const extraction = await call(server, "/api/task-drafts/extract", "POST", {
		connectionId: connection.id, brief: "产品：连接测试", stage: "overview",
	});
	assert.equal(extraction.status, 200);
	assert.deepEqual(await extraction.json(), { product: "连接测试" });
	assert.equal(seen.length, 3);
	for (const request of seen) {
		assert.ok(request.url.startsWith("https://claude.example/v1/messages"));
		assert.equal(request.apiKey, "synthetic-personal-key");
		assert.equal(request.authorization, null);
	}
});

test("model connections API: rejected model writes get a minimal audit record with only a status code", async (t) => {
	const events: { event: string; path: string; result: string; status?: number }[] = [];
	const { runtime } = withModels();
	const server = await serve(t, runtime, new Date().toISOString(), "ou-model-owner", (event) => events.push(event));
	const created = await (await call(server, "/api/me/model-connections", "POST", customInput())).json() as { id: string; version: number };
	// 旧 expectedVersion 触发 409；被拒绝的请求也必须有审计结果代码。
	const conflict = await call(server, `/api/me/model-connections/${created.id}`, "PUT", {
		expectedVersion: created.version + 1, models: [{ id: "mimo-v2-flash" }],
	});
	assert.equal(conflict.status, 409);
	const rejected = events.find((event) => event.event === "model.request.rejected");
	assert.equal(rejected?.status, 409);
	assert.equal(rejected?.result, "rejected");
	assert.match(rejected?.path ?? "", /^\/api\/me\/model-connections\//u);
	assert.doesNotMatch(JSON.stringify(events), /synthetic-personal-key|ciphertext|nonce|authTag/u);
});

test("model connections API: minimal audit records actions without keys or bodies", async (t) => {
	const events: { event: string; path: string; result: string; connectionId?: string; version?: number; status?: number }[] = [];
	const { runtime } = withModels();
	const server = await serve(t, runtime, new Date().toISOString(), "ou-model-owner", (event) => events.push(event));
	const created = await (await call(server, "/api/me/model-connections", "POST", customInput())).json() as { id: string; version: number };
	await call(server, "/api/me/model-preferences", "PUT", { expectedVersion: 0, connectionId: created.id, modelId: "mimo-v2-flash" });
	await call(server, "/api/me/model-connections/test", "POST", customInput());
	await call(server, "/api/me/model-connections/models", "POST", {
		baseUrl: "https://api.mimotest.example/v1", protocol: "openai-completions", apiKey: "synthetic-personal-key",
	});
	assert.equal((await call(server, `/api/me/model-connections/${created.id}/credential?expectedVersion=${created.version}`, "DELETE")).status, 200);
	assert.equal((await call(server, `/api/me/model-connections/${created.id}?expectedVersion=${created.version + 1}`, "DELETE")).status, 200);

	const names = events.map((event) => event.event);
	for (const expected of [
		"model.connection.created", "model.preference.updated", "model.connection.probed",
		"model.discovery.requested", "model.credential.removed", "model.connection.deleted",
	]) assert.ok(names.includes(expected), expected);
	const createdEvent = events.find((event) => event.event === "model.connection.created");
	assert.equal(createdEvent?.connectionId, created.id);
	assert.equal(createdEvent?.version, created.version);
	// 最小审计：不含密钥、密文、请求体或上游文本。
	const serialized = JSON.stringify(events);
	assert.doesNotMatch(serialized, /synthetic-personal-key|ciphertext|authTag|nonce|产品/u);
	for (const event of events) {
		assert.ok(["ok", "rejected", "unavailable"].includes(event.result), event.event);
		assert.ok(event.path.startsWith("/api/me/"), event.path);
	}
});

test("model connections API: Responses failures are sanitized and never saved", async (t) => {
	const { runtime } = withModels({ reply: () => responsesReply("not JSON containing synthetic-secret") });
	const server = await serve(t, runtime);
	const failed = await call(server, "/api/me/model-connections", "POST", { ...customInput(), protocol: "openai-responses" });
	assert.equal(failed.status, 503);
	assert.deepEqual(await failed.json(), { error: "model connection unavailable" });
	assert.deepEqual((await runtime.modelConnections?.service.view(server.userId))?.connections, []);
});

test("model connections API: verification gates storage and never echoes the key", async (t) => {
	const failing = withModels({ reply: () => new Response("nope", { status: 500 }) });
	const failingServer = await serve(t, failing.runtime);
	assert.equal((await call(failingServer, "/api/me/model-connections/test", "POST", customInput())).status, 200);
	const failureBody = await (await call(failingServer, "/api/me/model-connections/test", "POST", customInput())).json() as { ok: boolean };
	assert.equal(failureBody.ok, false);
	assert.equal((await call(failingServer, "/api/me/model-connections", "POST", customInput())).status, 503);
	const failedView = await (await call(failingServer, "/api/me/model-connections")).json() as { connections: unknown[] };
	assert.deepEqual(failedView.connections, [], "a failed test must not leave a connection behind");

	const { runtime, requests } = withModels();
	const server = await serve(t, runtime);
	const created = await call(server, "/api/me/model-connections", "POST", customInput());
	assert.equal(created.status, 201);
	const createdText = await created.text();
	assert.doesNotMatch(createdText, /synthetic-personal-key/);
	assert.doesNotMatch(createdText, /ciphertext|authTag|nonce/);
	const view = JSON.parse(createdText) as { id: string; hasCredential: boolean; status: string; version: number; verifiedVersion: number };
	assert.equal(view.hasCredential, true);
	assert.equal(view.status, "active");
	assert.equal(view.verifiedVersion, view.version);
	assert.equal(requests[0]?.url, "https://api.mimotest.example/v1/chat/completions");
	assert.equal(requests[0]?.auth, "Bearer synthetic-personal-key");
	assert.equal(requests[0]?.model, "mimo-v2-flash");

	const list = await (await call(server, "/api/me/model-connections")).json() as {
		connections: { id: string; providerId: string }[];
		preference: { version: number; connectionId: string | null };
	};
	assert.equal(list.connections.length, 1);
	assert.equal(list.preference.version, 0);
	assert.equal(list.preference.connectionId, null);

	// 同一用户重复 Provider ID 冲突；目录连接的主机必须与目录一致。
	assert.equal((await call(server, "/api/me/model-connections", "POST", customInput({ displayName: "重复" }))).status, 409);
	assert.equal(
		(await call(server, "/api/me/model-connections", "POST", {
			providerId: "deepseek",
			kind: "catalog",
			catalogId: "deepseek",
			baseUrl: "https://evil.example/v1",
			protocol: "openai-completions",
			models: [{ id: "deepseek-flash" }],
			apiKey: "synthetic-personal-key",
		})).status,
		503,
	);
});

test("model connections API: updates require versions and re-verify target changes", async (t) => {
	const { runtime, requests } = withModels();
	const server = await serve(t, runtime);
	const created = await (await call(server, "/api/me/model-connections", "POST", customInput())).json() as { id: string };
	requests.length = 0;

	const renamed = await call(server, `/api/me/model-connections/${created.id}`, "PUT", { expectedVersion: 1, displayName: "改名" });
	assert.equal(renamed.status, 200);
	assert.equal(requests.length, 0, "metadata-only updates must not call the provider");
	assert.equal(((await renamed.json()) as { version: number }).version, 2);

	assert.equal(
		(await call(server, `/api/me/model-connections/${created.id}`, "PUT", { expectedVersion: 99, displayName: "旧版本" })).status,
		409,
	);
	assert.equal(
		(await call(server, `/api/me/model-connections/${created.id}`, "PUT", {
			expectedVersion: 2,
			baseUrl: "https://api.other.example/v1",
		})).status,
		400,
		"changing the target without a new key must be refused",
	);
	const moved = await call(server, `/api/me/model-connections/${created.id}`, "PUT", {
		expectedVersion: 2,
		baseUrl: "https://api.other.example/v1",
		credential: { action: "replace", apiKey: "synthetic-other-key" },
	});
	assert.equal(moved.status, 200);
	assert.equal(requests.at(-1)?.url, "https://api.other.example/v1/chat/completions");
	assert.equal(requests.at(-1)?.auth, "Bearer synthetic-other-key");
	const movedView = await moved.json() as { version: number; baseUrl: string; hasCredential: boolean };
	assert.equal(movedView.version, 3);
	assert.equal(movedView.baseUrl, "https://api.other.example/v1");
	assert.equal(movedView.hasCredential, true);

	// 删除密钥后停用、默认选择清空，也不能再激活。
	assert.equal(
		(await call(server, `/api/me/model-connections/${created.id}/credential?expectedVersion=${movedView.version}`, "DELETE")).status,
		200,
	);
	const disabled = await (await call(server, "/api/me/model-connections")).json() as {
		connections: { status: string; hasCredential: boolean; version: number }[];
	};
	assert.equal(disabled.connections[0]?.status, "disabled");
	assert.equal(disabled.connections[0]?.hasCredential, false);
	assert.equal(
		(await call(server, `/api/me/model-connections/${created.id}`, "PUT", {
			expectedVersion: disabled.connections[0]?.version,
			status: "active",
		})).status,
		400,
	);
	assert.equal(
		(await call(server, `/api/me/model-connections/${created.id}?expectedVersion=${disabled.connections[0]?.version}`, "DELETE")).status,
		200,
	);
	assert.deepEqual((await (await call(server, "/api/me/model-connections")).json() as { connections: unknown[] }).connections, []);
});

test("model connections API: two users cannot see, use or default each other's connections", async (t) => {
	const { runtime } = withModels();
	const storage = runtime.storage as MemoryStorage;
	const server = await serve(t, runtime);
	const created = await (await call(server, "/api/me/model-connections", "POST", customInput())).json() as { id: string };

	// 第二个用户：同一存储，另一个会话。
	const service = new AuthenticationService(storage);
	const token = randomBytes(32).toString("base64url");
	await service.createWebSession({
		platform: "feishu",
		applicationId: "cli_model_other",
		tenantId: "tenant-model-other",
		idType: "open_id",
		externalId: "ou-model-other",
	}, createHash("sha256").update(token).digest("hex"), new Date().toISOString());
	const other = { cookie: `adpulse_session=${token}`, origin: "http://localhost", "content-type": "application/json" };
	assert.deepEqual((await (await call(server, "/api/me/model-connections", "GET", undefined, other)).json() as { connections: unknown[] }).connections, []);
	assert.equal((await call(server, `/api/me/model-connections/${created.id}`, "PUT", { expectedVersion: 1, displayName: "偷" }, other)).status, 404);
	assert.equal((await call(server, `/api/me/model-connections/${created.id}?expectedVersion=1`, "DELETE", undefined, other)).status, 404);
	assert.equal((await call(server, "/api/me/model-preferences", "PUT", { expectedVersion: 0, connectionId: created.id, modelId: "mimo-v2-flash" }, other)).status, 404);
	assert.equal((await call(server, "/api/task-drafts/extract", "POST", { brief: "产品", connectionId: created.id }, other)).status, 404);
});

test("model connections API: preferences only accept owned active connections", async (t) => {
	const { runtime } = withModels();
	const server = await serve(t, runtime);
	const created = await (await call(server, "/api/me/model-connections", "POST", customInput())).json() as { id: string };
	const set = await call(server, "/api/me/model-preferences", "PUT", {
		expectedVersion: 0,
		connectionId: created.id,
		modelId: "mimo-v2-flash",
	});
	assert.equal(set.status, 200);
	assert.deepEqual(await set.json(), { connectionId: created.id, modelId: "mimo-v2-flash", version: 1 });
	assert.equal(
		(await call(server, "/api/me/model-preferences", "PUT", { expectedVersion: 1, connectionId: created.id, modelId: "unknown" })).status,
		400,
	);
	assert.deepEqual(
		await (await call(server, "/api/me/model-preferences", "PUT", { expectedVersion: 1, connectionId: null })).json(),
		{ connectionId: null, modelId: null, version: 2 },
	);
});

test("model connections API: discovery lists models but never stores or guesses", async (t) => {
	const seen: { url: string; auth: string | null }[] = [];
	const storage = new MemoryStorage();
	const modelConnections = createModelConnections(storage, cipherEnv(), async (request, init) => {
		const sent = new Request(request, init);
		seen.push({ url: sent.url, auth: sent.headers.get("authorization") });
		return Response.json({ data: [{ id: "mimo-v2-flash" }, { id: "mimo-v2-pro" }, { id: "mimo-v2-flash" }] });
	});
	const server = await serve(t, { ...compose(storage, []), modelConnections });
	const discovered = await call(server, "/api/me/model-connections/models", "POST", {
		baseUrl: "https://api.mimotest.example/v1",
		protocol: "openai-completions",
		apiKey: "synthetic-personal-key",
	});
	assert.equal(discovered.status, 200);
	assert.deepEqual(await discovered.json(), { models: ["mimo-v2-flash", "mimo-v2-pro"] });
	assert.deepEqual(seen, [{
		url: "https://api.mimotest.example/v1/models",
		auth: "Bearer synthetic-personal-key",
	}]);
	// 发现不写库。
	assert.deepEqual((await (await call(server, "/api/me/model-connections")).json() as { connections: unknown[] }).connections, []);

	assert.equal(
		(await call(server, "/api/me/model-connections/models", "POST", {
			baseUrl: "https://api.mimotest.example/v1",
			protocol: "google-generative-ai",
			apiKey: "synthetic-personal-key",
		})).status,
		422,
	);
	assert.equal(
		(await call(server, "/api/me/model-connections/models", "POST", {
			baseUrl: "http://api.mimotest.example/v1",
			protocol: "openai-completions",
			apiKey: "synthetic-personal-key",
		})).status,
		400,
	);
});

test("model connections API: discovery failure is reported, not treated as an empty list", async (t) => {
	const failing = withModels({ reply: () => new Response("nope", { status: 500 }) });
	const server = await serve(t, failing.runtime);
	const response = await call(server, "/api/me/model-connections/models", "POST", {
		baseUrl: "https://api.mimotest.example/v1",
		protocol: "openai-completions",
		apiKey: "synthetic-personal-key",
	});
	assert.equal(response.status, 503);
});

test("model connections API: extraction uses the owned connection and fails closed otherwise", async (t) => {
	const { runtime, requests } = withModels();
	const server = await serve(t, runtime);
	const created = await (await call(server, "/api/me/model-connections", "POST", customInput())).json() as { id: string; version: number };
	requests.length = 0;

	const extracted = await call(server, "/api/task-drafts/extract", "POST", {
		brief: "产品：连接测试",
		stage: "overview",
		connectionId: created.id,
	});
	assert.equal(extracted.status, 200);
	assert.deepEqual(await extracted.json(), { product: "产品" });
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.auth, "Bearer synthetic-personal-key");

	// 删除密钥后同一连接不能再抽取。
	await call(server, `/api/me/model-connections/${created.id}/credential?expectedVersion=${created.version}`, "DELETE");
	assert.equal(
		(await call(server, "/api/task-drafts/extract", "POST", { brief: "产品", connectionId: created.id })).status,
		409,
	);

	// 不存在或未归属的连接同样 not found，不泄露存在性。
	assert.equal((await call(server, "/api/task-drafts/extract", "POST", { brief: "产品", connectionId: crypto.randomUUID() })).status, 404);
});

test("model connections API: stale authentication cannot send probes or change credentials and preferences", async (t) => {
	const { runtime, requests } = withModels();
	const server = await serve(t, runtime, new Date(Date.now() - 20 * 60_000).toISOString());
	const id = crypto.randomUUID();
	for (const [path, method, body] of [
		["/api/me/model-connections", "POST", customInput()],
		["/api/me/model-connections/test", "POST", customInput()],
		["/api/me/model-connections/models", "POST", { baseUrl: "https://api.mimotest.example/v1", protocol: "openai-completions", apiKey: "synthetic-personal-key" }],
		[`/api/me/model-connections/${id}`, "PUT", {}],
		[`/api/me/model-connections/${id}`, "DELETE", undefined],
		[`/api/me/model-connections/${id}/credential`, "DELETE", undefined],
		["/api/me/model-preferences", "PUT", {}],
		["/api/task-drafts/models/test", "POST", {}],
	] as const) {
		const result = await call(server, path, method, body);
		assert.equal(result.status, 401, path);
		assert.deepEqual(await result.json(), { error: "reauth_required" });
	}
	assert.equal((await call(server, "/api/me/model-connections")).status, 200);
	assert.equal(requests.length, 0);
});

test("model connections API: discovery shares the per-user budget", async (t) => {
	const { runtime, requests } = withModels({ reply: () => Response.json({ data: [{ id: "mimo-v2-flash" }] }) });
	const server = await serve(t, runtime);
	const body = { baseUrl: "https://api.mimotest.example/v1", protocol: "openai-completions", apiKey: "synthetic-personal-key" };
	// 单用户上限 6 次/分钟，比实例的 8 次/分钟更小。
	for (let attempt = 0; attempt < 6; attempt++)
		assert.equal((await call(server, "/api/me/model-connections/models", "POST", body)).status, 200);
	assert.equal((await call(server, "/api/me/model-connections/models", "POST", body)).status, 503);
	assert.equal(requests.length, 6);
});

test("model connections API: per-user budgets stop one user from exhausting the instance", async (t) => {
	const { runtime, requests } = withModels();
	const owner = await serve(t, runtime);
	const other = await serve(t, runtime, new Date().toISOString(), "ou-model-other");
	const created = await (await call(owner, "/api/me/model-connections", "POST", customInput())).json() as { id: string };
	assert.equal(requests.length, 1);
	const route = "/api/task-drafts/extract";
	const body = { connectionId: created.id, brief: "产品：连接测试", stage: "overview" };
	for (let attempt = 0; attempt < 5; attempt++)
		assert.equal((await call(owner, route, "POST", body)).status, 200);
	// 第 7 次网络动作：该用户自己的窗口已满，实例预算还有余量。
	assert.equal((await call(owner, route, "POST", body)).status, 503);
	assert.equal(requests.length, 6);
	// 另一个用户不受影响，但总量仍受实例 8 次/分钟约束。
	const otherCreated = await call(other, "/api/me/model-connections", "POST", customInput({ providerId: "other-mimo" }));
	assert.equal(otherCreated.status, 201);
	const otherId = (await otherCreated.json() as { id: string }).id;
	assert.equal((await call(other, route, "POST", { ...body, connectionId: otherId })).status, 200);
	assert.equal(requests.length, 8);
	assert.equal((await call(other, route, "POST", { ...body, connectionId: otherId })).status, 503);
	assert.equal(requests.length, 8);
});

test("model connections API: default, legacy and explicit personal selection share the request budget", async (t) => {
	const { runtime, requests } = withModels();
	const server = await serve(t, runtime);
	const noChoice = { brief: "产品", stage: "overview" };
	const route = "/api/task-drafts/extract";
	assert.equal((await call(server, route, "POST", noChoice)).status, 409);
	const created = await (await call(server, "/api/me/model-connections", "POST", customInput())).json() as { id: string };
	const preference = await call(server, "/api/me/model-preferences", "PUT", {
		expectedVersion: 0, connectionId: created.id, modelId: "mimo-v2-flash",
	});
	assert.equal(preference.status, 200);
	assert.equal((await call(server, route, "POST", noChoice)).status, 200);
	assert.equal((await call(server, route, "POST", { ...noChoice, provider: "mimo" })).status, 200);
	assert.equal((await call(server, route, "POST", { ...noChoice, provider: "deepseek" })).status, 409);
	// create(1) + 默认(2) + provider(3) 之后，该用户还剩 3 次预算。
	for (let n = 0; n < 3; n++)
		assert.equal((await call(server, route, "POST", { ...noChoice, connectionId: created.id })).status, 200);
	assert.equal((await call(server, route, "POST", noChoice)).status, 503);
	assert.equal(requests.length, 6);
});
