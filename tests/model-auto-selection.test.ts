// 回归：AI 辅助功能应自动使用「模型配置」里保存的持久化连接，不逐处重选。
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
	AuthenticationService,
	ModelConnectionService,
	TaskService,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import {
	createModelCredentialCipher,
	createModelConnections,
	createPersistedJsonCaller,
	resolveDefaultModelRoute,
} from "../packages/runtime/dist/index.js";

const env = {
	MODEL_CREDENTIAL_KEYRING: `test:${createHash("sha256").update("key").digest("base64")}`,
};

const identity = {
	platform: "feishu",
	applicationId: "cli_test",
	tenantId: "tenant_test",
	idType: "open_id",
	externalId: "ou_test",
};

async function withConnection() {
	const storage = new MemoryStorage();
	const owner = (await new AuthenticationService(storage).createWebSession(
		identity,
		createHash("sha256").update("token").digest("hex"),
		new Date().toISOString(),
	)).userId;
	const models = createModelConnections(storage, env, async () =>
		new Response(JSON.stringify({ product: "连接测试" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}));
	assert.ok(models);
	const created = await models.service.create(owner, {
		providerId: "mimo",
		kind: "custom",
		displayName: "测试自定义连接",
		baseUrl: "https://api.mimo.example/v1",
		protocol: "openai-completions",
		models: [{ id: "mimo-v2-flash" }],
		apiKey: "synthetic-personal-key",
	}, { verified: true });
	return { models, owner, created };
}

test("统一模型解析：有偏好时自动使用保存的连接，不需要每次传 provider/model", async () => {
	const { models, owner, created } = await withConnection();
	await models.service.setPreference(owner, {
		expectedVersion: 0,
		connectionId: created.id,
		modelId: "mimo-v2-flash",
	});
	const route = await resolveDefaultModelRoute(models.service, owner);
	assert.ok(route);
	assert.equal(route.providerId, "mimo");
	assert.equal(route.modelId, "mimo-v2-flash");
	assert.equal(route.apiKey, "synthetic-personal-key");
	assert.equal(route.kind, "custom");
});

test("统一模型解析：没有显式偏好时自动取第一条可用连接", async () => {
	const { models, owner } = await withConnection();
	const route = await resolveDefaultModelRoute(models.service, owner);
	assert.ok(route);
	assert.equal(route.modelId, "mimo-v2-flash");
});

test("统一模型解析：没有连接时返回 null，由调用方决定回退或报错", async () => {
	const storage = new MemoryStorage();
	const models = createModelConnections(storage, env);
	assert.ok(models);
	assert.equal(await resolveDefaultModelRoute(models.service, "no-such-user"), null);
});

test("持久化连接的 JSON 调用出口走所选协议的原生适配", async () => {
	const { models, owner, created } = await withConnection();
	await models.service.setPreference(owner, {
		expectedVersion: 0,
		connectionId: created.id,
		modelId: "mimo-v2-flash",
	});
	const route = await resolveDefaultModelRoute(models.service, owner);
	assert.ok(route);
	// 用同一 baseUrl/协议构造 caller；请求只走已校验的出网层（这里注入假 fetch）。
	let sawAuth = false;
	const caller = createPersistedJsonCaller(route, async () => {
		sawAuth = true;
		return new Response(JSON.stringify({
			id: "chatcmpl-test", object: "chat.completion", created: 0, model: "mimo-v2-flash",
			choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}), { status: 200, headers: { "content-type": "application/json" } });
	});
	assert.ok(caller);
	await caller("system", "brief");
	assert.equal(sawAuth, true, "请求确实发到了所选连接的适配器");
});
