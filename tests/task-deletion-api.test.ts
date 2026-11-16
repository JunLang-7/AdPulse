import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { createApi } from "../apps/api/dist/server.js";
import { AuthenticationService } from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { proposal } from "./helpers.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = {
	platform: "feishu",
	applicationId: "cli_test",
	tenantId: "tenant-a",
	idType: "open_id",
	externalId: "ou-owner",
};

async function serve(t: TestContext) {
	const runtime = compose(
		new MemoryStorage(),
		[
			{
				id: "account-a",
				identityScope: {
					platform: "feishu",
					applicationId: "cli_test",
					tenantId: "tenant-a",
				},
				inbound: {
					identifyActor() {
						return identity;
					},
					async parse() {
						throw new Error("not used");
					},
				},
				outbound: {
					async send(delivery) {
						return { externalMessageId: delivery.id };
					},
				},
			},
		],
		{ propose: async () => structuredClone(proposal) },
	);
	const service = new AuthenticationService(runtime.storage);
	const issuedAt = new Date().toISOString();
	const ownerToken = randomBytes(32).toString("base64url");
	const strangerToken = randomBytes(32).toString("base64url");
	await service.createWebSession(identity, hash(ownerToken), issuedAt);
	await service.createWebSession(
		{ ...identity, externalId: "ou-stranger" },
		hash(strangerToken),
		issuedAt,
	);
	const publicOrigin = "http://localhost";
	const server = createApi(runtime, {
		service,
		provider: {
			authorizationUrl() {
				throw new Error("not used");
			},
			async verifyAuthorizationCode() {
				return { identity };
			},
		},
		publicOrigin,
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	t.after(
		() => new Promise<void>((resolve) => server.close(() => resolve())),
	);
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const url = `http://127.0.0.1:${address.port}`;
	const headers = {
		cookie: `adpulse_session=${ownerToken}`,
		origin: publicOrigin,
		"content-type": "application/json",
	};
	return {
		url,
		headers,
		strangerHeaders: { ...headers, cookie: `adpulse_session=${strangerToken}` },
	};
}

const taskBody = {
	product: "产品 A",
	strategy: {
		objective: "获取咨询",
		audience: ["山东企业"],
		channels: { ads: {} },
		sellingPoints: [],
	},
	observation: { scope: "山东地区" },
	rules: { minimumSpendMinor: 0 },
};

test("HTTP: 确认删除需要本人会话，删除后立即 404 且重复确认幂等", async (t) => {
	const { url, headers, strangerHeaders } = await serve(t);

	const unauthenticated = await fetch(`${url}/api/tasks/any/deletion`, {
		method: "POST",
		origin: "http://localhost",
	});
	assert.equal(unauthenticated.status, 401);

	const created = await fetch(`${url}/api/tasks`, {
		method: "POST",
		headers: { ...headers, "idempotency-key": crypto.randomUUID() },
		body: JSON.stringify(taskBody),
	});
	assert.equal(created.status, 201);
	const task = (await created.json()) as { taskId: string };

	const foreign = await fetch(`${url}/api/tasks/${task.taskId}/deletion`, {
		method: "POST",
		headers: strangerHeaders,
	});
	assert.equal(foreign.status, 404);
	assert.equal(
		(await fetch(`${url}/api/tasks/${task.taskId}`, { headers })).status,
		200,
	);

	const first = await fetch(`${url}/api/tasks/${task.taskId}/deletion`, {
		method: "POST",
		headers,
	});
	assert.equal(first.status, 200);
	const view = (await first.json()) as {
		newlyRequested: boolean;
		state: string;
		cleanupDueAt: string;
		requestedAt: string;
		suppressed: Record<string, number>;
	};
	assert.equal(view.newlyRequested, true);
	assert.equal(view.state, "restricted");
	assert.equal(
		Date.parse(view.cleanupDueAt) - Date.parse(view.requestedAt),
		7 * 86_400_000,
	);
	assert.equal(view.suppressed.items, 0);

	const second = await fetch(`${url}/api/tasks/${task.taskId}/deletion`, {
		method: "POST",
		headers,
	});
	assert.equal(second.status, 200);
	assert.equal(((await second.json()) as { newlyRequested: boolean }).newlyRequested, false);

	const deletedTask = await fetch(`${url}/api/tasks/${task.taskId}`, {
		headers,
	});
	assert.equal(deletedTask.status, 404);
	const list = (await (
		await fetch(`${url}/api/tasks`, { headers })
	).json()) as { items: unknown[] };
	assert.deepEqual(list.items, []);

	const status = await fetch(`${url}/api/tasks/${task.taskId}/deletion`, {
		headers,
	});
	assert.equal(status.status, 200);
	assert.equal(((await status.json()) as { state: string }).state, "restricted");
	const foreignStatus = await fetch(
		`${url}/api/tasks/${task.taskId}/deletion`,
		{ headers: strangerHeaders },
	);
	assert.equal(foreignStatus.status, 404);
});
