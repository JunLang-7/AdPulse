import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";

import { createApi } from "../apps/api/dist/server.js";
import type { AuthAuditEvent } from "../apps/api/dist/server.js";
import {
	AuthenticationService,
	type PlatformIdentity,
} from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identity: PlatformIdentity = {
	platform: "feishu",
	applicationId: "cli_test",
	tenantId: "tenant-a",
	idType: "open_id",
	externalId: "ou-owner",
};
const publicOrigin = "http://localhost";

/** 只搭认证相关端点：不注册渠道账户，避免把业务路径带进这组用例。 */
async function serve(
	t: TestContext,
	options: { rejectIdentity?: boolean } = {},
) {
	const runtime = compose(new MemoryStorage(), []);
	const service = new AuthenticationService(runtime.storage);
	const events: AuthAuditEvent[] = [];
	const provider = {
		authorizationUrl(parameters: {
			state: string;
			codeChallenge: string;
			redirectUri: string;
		}) {
			const target = new URL(
				"https://accounts.feishu.cn/open-apis/authen/v1/authorize",
			);
			target.searchParams.set("state", parameters.state);
			target.searchParams.set("code_challenge", parameters.codeChallenge);
			target.searchParams.set("redirect_uri", parameters.redirectUri);
			return target.toString();
		},
		async verifyAuthorizationCode() {
			if (options.rejectIdentity) throw new Error("tenant mismatch");
			return { identity, displayName: "江朗" };
		},
	};
	const server = createApi(runtime, {
		service,
		provider,
		publicOrigin,
		audit: (event: AuthAuditEvent) => events.push(event),
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address() as { port: number };
	return { url: `http://127.0.0.1:${address.port}`, events, service };
}

async function freshSessionToken(service: AuthenticationService) {
	const token = randomBytes(32).toString("base64url");
	await service.createWebSession(identity, hash(token), new Date().toISOString());
	return token;
}

test("auth audit: 会话缺失 / 无效 / 跨源分别留痕，且不含凭据", async (t) => {
	const { url, events, service } = await serve(t);

	await fetch(`${url}/api/me`);
	assert.deepEqual(events.at(-1), {
		event: "auth.reject",
		reason: "session_missing",
		method: "GET",
		path: "/api/me",
	});

	const unknown = randomBytes(32).toString("base64url");
	await fetch(`${url}/api/me`, { headers: { cookie: `adpulse_session=${unknown}` } });
	assert.equal(events.at(-1)?.reason, "session_invalid");

	const token = await freshSessionToken(service);
	const crossOrigin = await fetch(`${url}/api/sessions`, {
		method: "POST",
		headers: {
			cookie: `adpulse_session=${token}`,
			origin: "https://attacker.example",
			"content-type": "application/json",
		},
		body: "{}",
	});
	assert.equal(crossOrigin.status, 403);
	assert.equal(events.at(-1)?.reason, "origin_mismatch");

	// 日志里不得出现会话值：审计事件只有原因、方法与路径三个维度。
	const serialized = JSON.stringify(events);
	assert.ok(!serialized.includes(token), "审计日志泄露了会话凭据");
	for (const event of events) {
		assert.deepEqual(Object.keys(event).sort(), [
			"event",
			"method",
			"path",
			"reason",
		]);
	}
});

test("auth audit: 回调重放记为事务无效，平台身份失败记为 identity_rejected", async (t) => {
	const { url, events } = await serve(t);
	const code = `code-${randomBytes(8).toString("hex")}`;

	const login = await fetch(`${url}/auth/feishu/login`, { redirect: "manual" });
	assert.equal(login.status, 302);
	const location = new URL(login.headers.get("location") ?? "");
	const state = location.searchParams.get("state") ?? "";
	const nonce = (login.headers.getSetCookie?.() ?? [])
		.map((value) => /adpulse_oauth_nonce=([^;]+)/.exec(value)?.[1])
		.find((value) => value !== undefined);
	assert.ok(state && nonce, "登录入口应下发 state 与浏览器绑定 cookie");

	const callback = () =>
		fetch(
			`${url}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
			{ redirect: "manual", headers: { cookie: `adpulse_oauth_nonce=${nonce}` } },
		);

	assert.equal((await callback()).status, 303, "首次回调应完成登录");
	const replay = await callback();
	assert.equal(replay.status, 303);
	assert.equal(
		new URL(replay.headers.get("location") ?? "", publicOrigin).searchParams.get(
			"error",
		),
		"authorization",
	);
	assert.equal(events.at(-1)?.reason, "login_transaction_invalid");

	const serialized = JSON.stringify(events);
	assert.ok(!serialized.includes(code), "审计日志泄露了授权码");
	assert.ok(!serialized.includes(state), "审计日志泄露了 state");

	const rejecting = await serve(t, { rejectIdentity: true });
	const second = await fetch(`${rejecting.url}/auth/feishu/login`, {
		redirect: "manual",
	});
	const secondState = new URL(second.headers.get("location") ?? "").searchParams.get(
		"state",
	);
	const secondNonce = (second.headers.getSetCookie?.() ?? [])
		.map((value) => /adpulse_oauth_nonce=([^;]+)/.exec(value)?.[1])
		.find((value) => value !== undefined);
	const failed = await fetch(
		`${rejecting.url}/auth/feishu/callback?state=${secondState}&code=x`,
		{ redirect: "manual", headers: { cookie: `adpulse_oauth_nonce=${secondNonce}` } },
	);
	assert.equal(
		new URL(failed.headers.get("location") ?? "", publicOrigin).searchParams.get(
			"error",
		),
		"identity",
	);
	assert.equal(rejecting.events.at(-1)?.reason, "identity_rejected");
	assert.equal(rejecting.events.at(-1)?.path, "/auth/feishu/callback");
});

test("login carries the platform display name into the current-user payload", async (t) => {
	const { url, service } = await serve(t);
	const login = await fetch(`${url}/auth/feishu/login`, { redirect: "manual" });
	const location = new URL(login.headers.get("location") ?? "");
	const state = location.searchParams.get("state") ?? "";
	const nonce = (login.headers.getSetCookie?.() ?? [])
		.map((value) => /adpulse_oauth_nonce=([^;]+)/.exec(value)?.[1])
		.find((value) => value !== undefined);
	const callback = await fetch(
		`${url}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=one-time`,
		{ redirect: "manual", headers: { cookie: `adpulse_oauth_nonce=${nonce}` } },
	);
	const sessionCookie = (callback.headers.getSetCookie?.() ?? [])
		.map((value) => /adpulse_session=([^;]+)/.exec(value)?.[1])
		.find((value) => value !== undefined);
	assert.ok(sessionCookie, "登录成功应下发会话 cookie");

	const me = await fetch(`${url}/api/me`, {
		headers: { cookie: `adpulse_session=${sessionCookie}` },
	});
	const payload = (await me.json()) as { displayName?: string; identities?: unknown[] };
	assert.equal(payload.displayName, "江朗");
	// 显示名不进身份作用域：identities 里的字段保持不变。
	assert.deepEqual(Object.keys((payload.identities as Array<object>)[0] ?? {}).sort(), [
		"applicationId",
		"externalId",
		"idType",
		"platform",
		"tenantId",
	]);
	assert.ok(await service.authenticateSession !== undefined);
});
