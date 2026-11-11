import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";

import { createApi } from "../apps/api/dist/server.js";
import type { AuditEvent } from "../apps/api/dist/server.js";
import {
	AuthenticationService,
	type PlatformIdentity,
} from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const publicOrigin = "http://localhost";
const identity: PlatformIdentity = {
	platform: "feishu",
	applicationId: "cli_test",
	tenantId: "tenant-a",
	idType: "open_id",
	externalId: "ou-owner",
};

async function serve(t: TestContext) {
	const runtime = compose(new MemoryStorage(), []);
	const service = new AuthenticationService(runtime.storage);
	const events: AuditEvent[] = [];
	const provider = {
		authorizationUrl(parameters: { state: string; codeChallenge: string; redirectUri: string }) {
			const target = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
			target.searchParams.set("state", parameters.state);
			target.searchParams.set("code_challenge", parameters.codeChallenge);
			target.searchParams.set("redirect_uri", parameters.redirectUri);
			return target.toString();
		},
		async verifyAuthorizationCode() {
			return { identity, displayName: "小明" };
		},
	};
	const server = createApi(runtime, {
		service,
		provider,
		publicOrigin,
		audit: (event: AuditEvent) => events.push(event),
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address() as { port: number };
	const url = `http://127.0.0.1:${address.port}`;

	/** 走完整 OAuth 回调拿会话 cookie：避免测试绕过真实登录路径。 */
	const login = async () => {
		const begin = await fetch(`${url}/auth/feishu/login`, { redirect: "manual" });
		const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state") ?? "";
		const nonce = (begin.headers.getSetCookie?.() ?? [])
			.map((value) => /adpulse_oauth_nonce=([^;]+)/.exec(value)?.[1])
			.find((value) => value !== undefined);
		const callback = await fetch(
			`${url}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=one-time`,
			{ redirect: "manual", headers: { cookie: `adpulse_oauth_nonce=${nonce}` } },
		);
		const cookie = (callback.headers.getSetCookie?.() ?? [])
			.map((value) => /adpulse_session=([^;]+)/.exec(value)?.[1])
			.find((value) => value !== undefined);
		return { cookie: cookie as string, replay: { state, nonce } };
	};

	return { url, events, service, runtime, login };
}

test("notification API: 未登录被拒，登录后确认目的地并走完授权状态机", async (t) => {
	const { url, events, login } = await serve(t);

	assert.equal(
		(await fetch(`${url}/api/me/notification-status`)).status,
		401,
		"未登录不能读状态",
	);
	assert.equal(
		(await fetch(`${url}/api/me/notification-destination`, { method: "PUT" })).status,
		401,
	);

	const { cookie } = await login();
	const headers = {
		cookie: `adpulse_session=${cookie}`,
		origin: publicOrigin,
		"content-type": "application/json",
	};

	// 身份来自会话绑定：请求体即使带别人的 externalId 也不影响。
	const verified = await fetch(`${url}/api/me/notification-destination`, {
		method: "PUT",
		headers,
		// 真正的伪造请求体：服务端必须忽略它，只用会话身份。
		body: JSON.stringify({ externalId: "ou-someone-else" }),
	});
	assert.equal(verified.status, 200);
	const destination = (await verified.json()) as {
		id: string;
		externalId: string;
		status: string;
	};
	assert.equal(destination.externalId, "ou-owner", "目的地必须取会话身份");
	assert.equal(destination.status, "verified");

	// 未授权时闸门关闭。
	let status = (await (
		await fetch(`${url}/api/me/notification-status`, { headers })
	).json()) as { consent: unknown; canSendProactive: boolean };
	assert.equal(status.consent, null);
	assert.equal(status.canSendProactive, false);

	const granted = await fetch(`${url}/api/me/notification-consent`, {
		method: "POST",
		headers,
		body: JSON.stringify({ action: "grant", expectedVersion: 0 }),
	});
	assert.equal(granted.status, 200);
	assert.equal(((await granted.json()) as { status: string }).status, "active");

	status = (await (
		await fetch(`${url}/api/me/notification-status`, { headers })
	).json()) as { consent: unknown; canSendProactive: boolean };
	assert.equal(status.canSendProactive, true);

	const revoked = await fetch(`${url}/api/me/notification-consent`, {
		method: "POST",
		headers,
		body: JSON.stringify({ action: "revoke", expectedVersion: 1 }),
	});
	assert.equal(((await revoked.json()) as { status: string }).status, "revoked");
	const afterRevoke = (await (
		await fetch(`${url}/api/me/notification-status`, { headers })
	).json()) as {
		destination: { id: string } | null;
		canSendProactive: boolean;
	};
	assert.equal(afterRevoke.canSendProactive, false, "撤销后不得主动发送");
	assert.equal(afterRevoke.destination?.id, destination.id, "撤销不等于删除目的地");

	// 审阅复现：撤销后重放「原样」的 grant 请求（同会话、同请求体）不得重新打开授权。
	const replayedGrant = await fetch(`${url}/api/me/notification-consent`, {
		method: "POST",
		headers,
		body: JSON.stringify({ action: "grant", expectedVersion: 0 }),
	});
	assert.equal(replayedGrant.status, 409, "旧 grant 重放必须被版本校验拒绝");
	const afterReplay = (await (
		await fetch(`${url}/api/me/notification-status`, { headers })
	).json()) as { canSendProactive: boolean; consent: { status: string; version: number } };
	assert.equal(afterReplay.canSendProactive, false);
	assert.equal(afterReplay.consent.status, "revoked");
	assert.equal(afterReplay.consent.version, 2);

	// 显式恢复：带当前版本才允许重新授权。
	const restored = await fetch(`${url}/api/me/notification-consent`, {
		method: "POST",
		headers,
		body: JSON.stringify({ action: "grant", expectedVersion: 2 }),
	});
	assert.equal(restored.status, 200);
	assert.equal(
		((await (
			await fetch(`${url}/api/me/notification-status`, { headers })
		).json()) as { canSendProactive: boolean }).canSendProactive,
		true,
	);

	// 审计只留动作，不带外部标识。
	assert.deepEqual(
		events.filter((event) => event.event.startsWith("notification.")).map((event) => event.event),
		[
			"notification.destination.verified",
			"notification.consent.granted",
			"notification.consent.revoked",
			"notification.consent.granted",
		],
	);
	const serialized = JSON.stringify(events);
	assert.ok(!serialized.includes("ou-owner"), "审计日志不得包含 open_id");
});

test("notification API: 非法动作、缺目的地与跨源请求被拒", async (t) => {
	const { url, login } = await serve(t);
	const { cookie } = await login();
	const headers = {
		cookie: `adpulse_session=${cookie}`,
		origin: publicOrigin,
		"content-type": "application/json",
	};

	// 还没有目的地时的授权请求：404，不静默成功。
	const noDestination = await fetch(`${url}/api/me/notification-consent`, {
		method: "POST",
		headers,
		body: JSON.stringify({ action: "grant", expectedVersion: 0 }),
	});
	assert.equal(noDestination.status, 404);

	await fetch(`${url}/api/me/notification-destination`, { method: "PUT", headers });

	const invalid = await fetch(`${url}/api/me/notification-consent`, {
		method: "POST",
		headers,
		body: JSON.stringify({ action: "subscribe", expectedVersion: 0 }),
	});
	assert.equal(invalid.status, 400);

	// 跨源副作用请求被同源校验拦下。
	const crossOrigin = await fetch(`${url}/api/me/notification-consent`, {
		method: "POST",
		headers: { ...headers, origin: "https://attacker.example" },
		body: JSON.stringify({ action: "grant", expectedVersion: 0 }),
	});
	assert.equal(crossOrigin.status, 403);

	// 未授权状态下撤销：409（没有可撤销的授权），不伪装成功。
	const revokeWithoutGrant = await fetch(`${url}/api/me/notification-consent`, {
		method: "POST",
		headers,
		body: JSON.stringify({ action: "revoke", expectedVersion: 1 }),
	});
	assert.equal(revokeWithoutGrant.status, 409);

	// 缺版本直接 400：没有版本就无法区分「再次确认」与「重放」。
	const missingVersion = await fetch(`${url}/api/me/notification-consent`, {
		method: "POST",
		headers,
		body: JSON.stringify({ action: "grant" }),
	});
	assert.equal(missingVersion.status, 400);
});
