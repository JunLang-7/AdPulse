import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createApi } from "../apps/api/dist/server.js";
import { AuthenticationService, Worker } from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { createFeishuAccount } from "../packages/channels/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { createFailureRuntime } from "../scripts/acceptance/failure-runtime.mjs";
import { createConsoleClient } from "../scripts/acceptance/console-api.mjs";
import { FAULT_HEADER, FAULT_MARKER } from "../scripts/acceptance/fault-injection.mjs";
import { actionPayload, signedRequest } from "../scripts/acceptance/feishu-crypto.mjs";
import { createChecks, EVIDENCE } from "../scripts/acceptance/checks.mjs";
import { runScenario } from "../scripts/acceptance/scenario.mjs";
import { groupScenario } from "../scripts/acceptance/scenarios/group.mjs";
import { rejectScenario } from "../scripts/acceptance/scenarios/reject.mjs";
import { failureScenario } from "../scripts/acceptance/scenarios/failure.mjs";
import { prepareDbDownSession } from "../scripts/acceptance/scenarios/db-down.mjs";

const config = { accountId: "feishu-test", appId: "cli_test", appSecret: "synthetic-secret", tenantKey: "tenant-test", verificationToken: "synthetic-token", encryptKey: "synthetic-key" };
const identity = { platform: "feishu", applicationId: config.appId, tenantId: config.tenantKey, idType: "open_id", externalId: "ou_owner" };

async function fixture(t: TestContext, markFault = true, failOutbound = true) {
	const storage = new MemoryStorage();
	const runtime = failOutbound ? createFailureRuntime(storage, config) : compose(storage, [{ ...createFeishuAccount(config), outbound: { async send(delivery) { return { externalMessageId: `synthetic:${delivery.id}` }; } } }]);
	const service = new AuthenticationService(storage);
	const token = "A".repeat(43);
	await service.createWebSession(identity, createHash("sha256").update(token).digest("hex"), new Date().toISOString());
	// 第二用户也有真实服务中的独立绑定；外部 OAuth 及飞书网络未调用。
	await service.createWebSession({ ...identity, externalId: "ou_other" }, createHash("sha256").update("other").digest("hex"), new Date().toISOString());
	const server = createApi(runtime, {
		service, publicOrigin: "http://localhost", audit() {},
		provider: { authorizationUrl() { throw new Error("unused"); }, async verifyAuthorizationCode() { return identity; } },
	});
	if (markFault) server.prependListener("request", (_req, res) => res.setHeader(FAULT_HEADER, FAULT_MARKER));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const client = createConsoleClient({ baseUrl, auth: { sessionCookie: token, origin: "http://localhost" } });
	let workerTime = Date.now();
	const worker = new Worker(storage, runtime.decisions, runtime.channels.outbound(), () => new Date(workerTime).toISOString(), 2);
	let paused = false;
	async function drain() {
		if (paused) return;
		for (let i = 0; i < 30; i++) {
			const pending = await storage.transaction(async (tx) => (await tx.jobs.all()).some((j) => j.status === "pending"));
			if (!pending) return;
			await worker.runOnce();
			workerTime += 10_000;
		}
		throw new Error("worker did not drain");
	}
	let time = Date.now();
	const checks = createChecks({ defaultEvidence: EVIDENCE.synthetic });
	const ctx = {
		env: { FEISHU_ACCOUNT_ID: config.accountId },
		options: { openId: identity.externalId, otherOpenId: "ou_other", chatId: "oc_group" },
		vars: {} as Record<string, unknown>, record: checks.record,
		now: () => time, sleep: async (ms: number) => { time += ms; }, log: (_line: string) => {},
		client: { ...client, async getSession(id: string) { await drain(); return client.getSession(id); } },
	};
	async function click(actor: string, optionId: string) {
		const detail = await client.getSession(String(ctx.vars.sessionId));
		const action = detail.actions.find((a) => a.optionId === optionId);
		assert.ok(action);
		const request = signedRequest(actionPayload(config, { eventId: crypto.randomUUID(), actor, actionRef: action.id }), { encryptKey: config.encryptKey, encrypt: true });
		const response = await fetch(`${baseUrl}/webhooks/${config.accountId}`, { method: "POST", headers: request.headers, body: request.rawBody });
		assert.equal(response.status, 200);
	}
	return { client, ctx, checks, storage, click, pause: () => { paused = true; } };
}

test("acceptance API: group 验证真实个人权限拒绝，库中不创建会话", async (t) => {
	const { ctx, checks, storage } = await fixture(t);
	await runScenario(groupScenario, ctx);
	assert.equal(checks.results[0]?.status, "ok");
	assert.equal((await storage.transaction((tx) => tx.sessions.all())).length, 0);
});

test("acceptance API: reject 在本人单聊中验证第二用户拒绝及 owner 生效", async (t) => {
	const { ctx, checks, click } = await fixture(t, false, false);
	// 模拟的是合成签名回调，不记录为平台真机证据；API/入站适配/身份映射/worker 均为真实实现。
	ctx.log = (line) => {
		if (line.includes("reject.forbidden")) pendingClick = click("ou_other", "observe");
		if (line.includes("reject.authorized")) pendingClick = click("ou_owner", "observe");
	};
	let pendingClick = Promise.resolve();
	const getSession = ctx.client.getSession;
	ctx.client.getSession = async (id) => { await pendingClick; return getSession(id); };
	const result = await runScenario(rejectScenario, ctx);
	assert.equal(result.matched, true);
	assert.equal(checks.counts().fail, 0);
	assert.equal(checks.counts().ok, 6);
});

test("acceptance API: failure 使用本人收件人与出站故障，真实 worker 重试同一投递", async (t) => {
	const { ctx, checks } = await fixture(t);
	const result = await runScenario(failureScenario, ctx);
	assert.equal(result.matched, true);
	assert.equal(checks.counts().fail, 0);
	assert.equal(checks.counts().ok, 6);
	assert.ok(checks.results.every((r) => r.evidence === EVIDENCE.synthetic));
});

test("acceptance API: retry 仅排队而 worker 停止，场景必须 blocked", async (t) => {
	const { ctx, checks, pause } = await fixture(t);
	const retry = ctx.client.retryJob;
	ctx.client.retryJob = async (id) => { pause(); return retry(id); };
	const result = await runScenario({ ...failureScenario, timeoutMs: 3000 }, ctx);
	assert.equal(result.matched, false);
	assert.equal(checks.results.at(-1)?.status, "blocked");
	assert.ok(!checks.results.some((r) => r.id === "failure.retry-restarted" && r.status === "ok"));
});

test("acceptance API: 未标记的正式 API 在建会话前被故障场景拒绝", async (t) => {
	const { ctx, checks, storage } = await fixture(t, false);
	const result = await runScenario(failureScenario, ctx);
	assert.equal(result.matched, false);
	assert.equal(checks.results[0]?.status, "blocked");
	assert.equal((await storage.transaction((tx) => tx.sessions.all())).length, 0);
});

test("acceptance API: db-down 的准备输入使用本人而非虚构收件人", async (t) => {
	const { client, ctx } = await fixture(t);
	await client.assertFaultInjection();
	const created = await prepareDbDownSession(ctx);
	assert.ok(created.id);
});
