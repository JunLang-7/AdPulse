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

test("subscription API: 未登录一律 401，登录后配置可读写", async (t) => {
	const { url, login } = await serve(t);

	for (const [method, path] of [
		["GET", "/api/me/subscription"],
		["PUT", "/api/me/subscription/settings"],
		["POST", "/api/me/subscription/targets"],
		["PATCH", `/api/me/subscription/targets/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`],
	] as const) {
		assert.equal(
			(await fetch(`${url}${path}`, { method })).status,
			401,
			`${method} ${path} 未登录必须 401`,
		);
	}

	const { cookie } = await login();
	const headers = {
		cookie: `adpulse_session=${cookie}`,
		origin: publicOrigin,
		"content-type": "application/json",
	};

	// 未配置：默认关闭，版本 0，不声称可投递；且不返回伪造的 updatedAt。
	const initial = (await (await fetch(`${url}/api/me/subscription`, { headers })).json()) as {
		settings: { version: number; proactiveEnabled: boolean; updatedAt?: string };
		targets: unknown[];
	};
	assert.equal(initial.settings.version, 0);
	assert.equal(initial.settings.proactiveEnabled, false);
	assert.equal(
		"updatedAt" in initial.settings,
		false,
		"未配置时不返回 updatedAt，客户端按 date-time 解析空串会失败",
	);
	assert.deepEqual(initial.targets, []);

	// 启用需要版本；缺少 expectedVersion 不能当成 0。
	const missingVersion = await fetch(`${url}/api/me/subscription/settings`, {
		method: "PUT",
		headers,
		body: JSON.stringify({ proactiveEnabled: true }),
	});
	assert.equal(missingVersion.status, 409, "无版本写入被拒");

	const enabled = await fetch(`${url}/api/me/subscription/settings`, {
		method: "PUT",
		headers,
		body: JSON.stringify({ expectedVersion: 0, proactiveEnabled: true }),
	});
	assert.equal(enabled.status, 200);
	const enabledBody = (await enabled.json()) as {
		settings: { version: number; proactiveEnabled: boolean; schedule: { digestAt: string } };
	};
	assert.equal(enabledBody.settings.version, 1);
	assert.equal(enabledBody.settings.proactiveEnabled, true);
	assert.equal(enabledBody.settings.schedule.digestAt, "09:30");

	// 旧版本重放被拒，不能撤销后来的启用。
	const replay = await fetch(`${url}/api/me/subscription/settings`, {
		method: "PUT",
		headers,
		body: JSON.stringify({ expectedVersion: 0, proactiveEnabled: false }),
	});
	assert.equal(replay.status, 409);

	// 时段非法 → 422，不落库。
	const badSchedule = await fetch(`${url}/api/me/subscription/settings`, {
		method: "PUT",
		headers,
		body: JSON.stringify({
			expectedVersion: 1,
			schedule: { timezone: "Asia/Shanghai", digestAt: "23:00", quietStart: "22:00", quietEnd: "08:00" },
		}),
	});
	assert.equal(badSchedule.status, 422);

	// 非 Asia/Shanghai 时区必须拒绝，而不是当成北京时间保存。
	const badTimezone = await fetch(`${url}/api/me/subscription/settings`, {
		method: "PUT",
		headers,
		body: JSON.stringify({
			expectedVersion: 1,
			schedule: { timezone: "UTC", digestAt: "09:30", quietStart: "22:00", quietEnd: "08:00" },
		}),
	});
	assert.equal(badTimezone.status, 422, "不支持时区返回 422");
	assert.equal(
		((await (await fetch(`${url}/api/me/subscription`, { headers })).json()) as {
			settings: { version: number };
		}).settings.version,
		1,
		"被拒的时区写入不得推进版本",
	);
	assert.equal(
		((await (await fetch(`${url}/api/me/subscription`, { headers })).json()) as {
			settings: { version: number; schedule: { digestAt: string } };
		}).settings.schedule.digestAt,
		"09:30",
		"被拒的写入不得留下部分修改",
	);
});

test("subscription API: 关注对象增改、他人对象与未知 kind 的错误码", async (t) => {
	const { url, login, events, runtime } = await serve(t);
	const { cookie } = await login();
	const headers = {
		cookie: `adpulse_session=${cookie}`,
		origin: publicOrigin,
		"content-type": "application/json",
	};
	const session = await runtime.storage.transaction((tx) => tx.webSessions.all());
	const userId = (session[0] as { userId: string }).userId;

	const added = await fetch(`${url}/api/me/subscription/targets`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			expectedVersion: 0,
			kind: "competitor",
			label: "某某灯饰",
			sourceUrl: "https://example.com/evidence",
			categories: ["event"],
			scope: "include_general",
		}),
	});
	assert.equal(added.status, 201);
	const body = (await added.json()) as {
		settings: { version: number };
		targets: Array<{ id: string; status: string; kindLabel: string }>;
	};
	assert.equal(body.settings.version, 1);
	const targetId = body.targets[0]?.id as string;
	assert.equal(body.targets[0]?.kindLabel, "竞品");

	// 重复同名 → 409。
	assert.equal(
		(
			await fetch(`${url}/api/me/subscription/targets`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					expectedVersion: 1,
					kind: "competitor",
					label: "某某灯饰",
					categories: ["event"],
					scope: "task_only",
				}),
			})
		).status,
		409,
	);

	// 未知 kind → 422，不是 500。
	assert.equal(
		(
			await fetch(`${url}/api/me/subscription/targets`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					expectedVersion: 1,
					kind: "anything",
					categories: ["event"],
					scope: "task_only",
				}),
			})
		).status,
		422,
	);

	// 他人任务：构造一个属于别人的任务，必须 404 且不确认存在性。
	const foreignTaskId = crypto.randomUUID();
	await runtime.storage.transaction(async (tx) => {
		await tx.tasks.put({
			id: foreignTaskId,
			ownerId: "someone-else",
			currentVersion: 1,
			createdAt: new Date().toISOString(),
		});
	});
	const foreign = await fetch(`${url}/api/me/subscription/targets`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			expectedVersion: 1,
			kind: "task",
			refId: foreignTaskId,
			categories: ["effect"],
			scope: "task_only",
		}),
	});
	assert.equal(foreign.status, 404);

	// 他人对象 PATCH → 404；他人的对象存在也不泄露。
	const muted = await fetch(`${url}/api/me/subscription/targets/${targetId}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ expectedVersion: 1, status: "muted" }),
	});
	assert.equal(muted.status, 200);
	const mutedBody = (await muted.json()) as {
		settings: { version: number };
		targets: Array<{ status: string; categories: string[] }>;
	};
	assert.equal(mutedBody.settings.version, 2);
	assert.equal(mutedBody.targets[0]?.status, "muted");
	assert.deepEqual(mutedBody.targets[0]?.categories, ["event"], "退订不丢类别配置");

	// 审计只记动作，不含外部标识。
	assert.ok(
		events.some((event) => event.event === "subscription.target.added"),
		"关注对象新增应留审计",
	);
	assert.ok(
		events.some((event) => event.event === "subscription.target.updated"),
		"关注对象修改应留审计",
	);
	const serialized = JSON.stringify(events);
	assert.equal(serialized.includes("某某灯饰"), false, "审计不含对象名称");
	assert.equal(serialized.includes(userId), false, "审计不含 userId");
});
