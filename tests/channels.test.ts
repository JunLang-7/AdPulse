import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
	ChannelRegistry,
	FeishuInbound,
	FeishuOutbound,
	toFeishuCard,
} from "../packages/channels/dist/index.js";
import type {
	FeishuInboundConfig,
	WebhookRequest,
} from "../packages/channels/dist/index.js";
import type {
	CardDelivery,
	ChoiceCommand,
	Orchestrator,
} from "../packages/core/dist/index.js";
import { fixture } from "./helpers.ts";

const config: Omit<FeishuInboundConfig, "appSecret"> = {
	accountId: "account-a",
	appId: "app",
	tenantKey: "tenant",
	verificationToken: "verify",
	encryptKey: "secret",
};
const time = Date.parse("2026-01-01T00:00:00.000Z");
const inbound = new FeishuInbound(config, () => time);

interface TestRequest extends Omit<WebhookRequest, "headers"> {
	headers: Record<string, string>;
}
/** Drops the x-lark-* headers, as the platform does when it verifies a callback URL. */
function signed(request: TestRequest, keep: boolean): TestRequest {
	if (!keep)
		for (const name of [
			"x-lark-request-timestamp",
			"x-lark-request-nonce",
			"x-lark-signature",
		])
			delete request.headers[name];
	return request;
}
function request(payload: unknown, encrypt = false): TestRequest {
	if (encrypt) {
		const iv = randomBytes(16);
		const cipher = createCipheriv(
			"aes-256-cbc",
			createHash("sha256").update(config.encryptKey).digest(),
			iv,
		);
		payload = {
			encrypt: Buffer.concat([
				iv,
				cipher.update(JSON.stringify(payload)),
				cipher.final(),
			]).toString("base64"),
		};
	}
	const rawBody = Buffer.from(JSON.stringify(payload));
	const timestamp = String(time / 1000),
		nonce = "nonce";
	return {
		method: "POST",
		url: "/webhooks/account-a",
		rawBody,
		headers: {
			"x-lark-request-timestamp": timestamp,
			"x-lark-request-nonce": nonce,
			"x-lark-signature": createHash("sha256")
				.update(timestamp + nonce + config.encryptKey)
				.update(rawBody)
				.digest("hex"),
		},
	};
}
function event(actionRef = "ref") {	return {
		schema: "2.0",
		header: {
			event_id: "e1",
			token: "verify",
			app_id: "app",
			tenant_key: "tenant",
			event_type: "card.action.trigger",
		},
		event: {
			operator: { open_id: "user-a", tenant_key: "tenant" },
			action: { value: { actionRef } },
		},
	};
}
test("Feishu inbound verifies bytes, decrypts and normalizes a card action", async () => {
	const parsed = await inbound.parse(request(event(), true));
	assert.equal(parsed.kind, "choice");
	assert.deepEqual(parsed.command, {
		sourceId: "account-a",
		eventId: "e1",
		actionRef: "ref",
		actor: { kind: "platform", accountId: "account-a", externalId: "user-a" },
	});
	assert.equal(JSON.parse(parsed.response.body).toast.type, "info");
});
test("Feishu actor identity is scoped to the configured application and tenant", () => {
	assert.deepEqual(
		inbound.identifyActor({ accountId: "account-a", externalId: "user-a" }),
		{
			platform: "feishu",
			applicationId: config.appId,
			tenantId: config.tenantKey,
			idType: "open_id",
			externalId: "user-a",
		},
	);
	assert.equal(
		inbound.identifyActor({ accountId: "other", externalId: "user-a" }),
		null,
	);
	assert.equal(
		inbound.identifyActor({ accountId: "account-a", externalId: "" }),
		null,
	);
});

test("gateway maps a verified platform actor and leaves unverified actors unresolved", async () => {
	const received: ChoiceCommand[] = [];
	const registry = new ChannelRegistry([
		{
			id: "account-a",
			inbound: {
				async parse() {
					return {
						kind: "choice" as const,
						command: {
							sourceId: "untrusted",
							eventId: "e1",
							actionRef: "ref",
							actor: {
								kind: "platform" as const,
								accountId: "account-a",
								externalId: "open-1",
							},
						},
						response: { status: 200, headers: {}, body: "ok" },
					};
				},
				identifyActor(actor) {
					return {
						platform: "feishu",
						applicationId: "app",
						tenantId: "tenant",
						idType: "open_id",
						externalId: actor.externalId,
					};
				},
			},
			outbound: {
				async send() {
					return { externalMessageId: "x" };
				},
			},
		},
	]);
	const decisions = {
		async receiveChoice(command: ChoiceCommand) {
			received.push(command);
		},
	} as unknown as Orchestrator;

	await registry.handle("account-a", request({}), decisions, async (identity) => {
		assert.deepEqual(identity, {
			platform: "feishu",
			applicationId: "app",
			tenantId: "tenant",
			idType: "open_id",
			externalId: "open-1",
		});
		return "user-1";
	});
	assert.equal(received[0]?.sourceId, "account-a");
	assert.equal(
		received[0]?.actor.kind === "platform" ? received[0].actor.userId : null,
		"user-1",
	);

	await registry.handle("account-a", request({}), decisions, async () => null);
	assert.equal(
		received[1]?.actor.kind === "platform" ? received[1].actor.userId : null,
		undefined,
	);
});

test("Feishu verifies Go-format timestamps without weakening freshness or signatures", async () => {
	const make = (timestamp: string) => {
		const r = request(event(), true);
		r.headers["x-lark-request-timestamp"] = timestamp;
		r.headers["x-lark-signature"] = createHash("sha256")
			.update(timestamp + "nonce" + config.encryptKey)
			.update(r.rawBody)
			.digest("hex");
		return r;
	};
	const valid = "2026-01-01 08:00:00.000000000 +0800 CST m=+123.456";
	assert.equal((await inbound.parse(make(valid))).kind, "choice");
	assert.equal((await inbound.parse(make("2025-12-31 19:00:00 -0500 EST"))).kind, "choice");
	await assert.rejects(inbound.parse(make("2026-01-01 07:54:59 +0800 CST")), /timestamp/);
	await assert.rejects(inbound.parse(make("2026-01-01 08:05:01 +0800 CST")), /timestamp/);
	await assert.rejects(inbound.parse(make("2026-02-30 08:00:00 +0800 CST")), /timestamp/);
	await assert.rejects(inbound.parse(make(valid + " extra")), /timestamp/);
	const altered = make(valid);
	altered.headers["x-lark-signature"] = "0".repeat(64);
	await assert.rejects(inbound.parse(altered), /invalid signature/);
});
test("Feishu challenge is request-specific and never creates a business event", async () => {
	const parsed = await inbound.parse(
		request(
			{ type: "url_verification", token: "verify", challenge: "challenge-1" },
			true,
		),
	);
	assert.equal(parsed.kind, "response");
	assert.deepEqual(JSON.parse(parsed.response.body), {
		challenge: "challenge-1",
	});
});
test("Feishu rejects altered bodies, stale timestamps, wrong token and wrong tenant", async () => {
	const altered = request(event());
	altered.rawBody = Buffer.from(" {}");
	await assert.rejects(inbound.parse(altered), /invalid signature/);
	const stale = request(event());
	stale.headers["x-lark-request-timestamp"] = "1";
	await assert.rejects(inbound.parse(stale), /timestamp/);
	const wrongToken = event();
	wrongToken.header.token = "wrong";
	await assert.rejects(inbound.parse(request(wrongToken)), /identity mismatch/);
	const wrongTenant = event();
	wrongTenant.event.operator.tenant_key = "another";
	await assert.rejects(
		inbound.parse(request(wrongTenant)),
		/invalid card action/,
	);
});
test("Feishu answers the platform challenge that carries no signature headers", async () => {
	// The developer console verifies a callback URL with an encrypted body and no
	// x-lark-* headers, so rejecting unsigned requests blocked URL registration.
	const challenge = request(
		{ type: "url_verification", token: "verify", challenge: "challenge-2" },
		true,
	);
	signed(challenge, false);
	const parsed = await inbound.parse(challenge);
	assert.equal(parsed.kind, "response");
	assert.deepEqual(JSON.parse(parsed.response.body), {
		challenge: "challenge-2",
	});
});
test("Feishu still rejects unsigned plaintext challenges and unsigned card actions", async () => {
	const plaintext = request({
		type: "url_verification",
		token: "verify",
		challenge: "challenge-3",
	});
	signed(plaintext, false);
	await assert.rejects(inbound.parse(plaintext), /invalid verification token/);

	const action = request(event(), true);
	signed(action, false);
	await assert.rejects(inbound.parse(action), /missing signature/);

	const tampered = request(
		{ type: "url_verification", token: "wrong", challenge: "challenge-4" },
		true,
	);
	signed(tampered, false);
	await assert.rejects(inbound.parse(tampered), /invalid verification token/);
});
test("gateway commits inbound receipt before ACK; replay is deduplicated", async () => {
	const f = fixture();
	const registry = new ChannelRegistry([
		{
			id: "account-a",
			inbound,
			outbound: {
				async send() {
					return { externalMessageId: "x" };
				},
			},
		},
	]);
	const response = await registry.handle(
		"account-a",
		request(event()),
		f.decisions,
	);
	assert.equal(response.status, 200);
	assert.equal((await f.storage.transaction((tx) => tx.inbox.all())).length, 1);
	await registry.handle("account-a", request(event()), f.decisions);
	assert.equal((await f.storage.transaction((tx) => tx.inbox.all())).length, 1);
	await assert.rejects(
		registry.handle("account-a", request(event()), {
			async receiveChoice() {
				throw new Error("database offline");
			},
		} as unknown as Orchestrator),
		/database offline/,
	);
});
test("second provider plugs into the same registry and command service without provider branches", async () => {
	const f = fixture();
	let sends = 0;
	const registry = new ChannelRegistry([
		{
			id: "provider-b",
			inbound: {
				async parse() {
					return {
						kind: "choice",
						command: {
							sourceId: "untrusted",
							eventId: "e1",
							actionRef: "ref",
							actor: {
								kind: "platform",
								accountId: "provider-b",
								externalId: "u",
							},
						},
						response: {
							status: 200,
							headers: { "content-type": "text/plain" },
							body: "success",
						},
					};
				},
			},
			outbound: {
				async send() {
					sends++;
					return { externalMessageId: "b1" };
				},
			},
		},
	]);
	assert.equal(
		(await registry.handle("provider-b", request(event()), f.decisions)).body,
		"success",
	);
	const saved = await f.storage.transaction((tx) => tx.inbox.all());
	assert.equal(saved[0].command.sourceId, "provider-b");
	await registry.outbound().get("provider-b")!.send({} as CardDelivery);
	assert.equal(sends, 1);
});
test("Feishu JSON 2.0 contains opaque references, not mutable strategy data", () => {
	const delivery: CardDelivery = {
		id: crypto.randomUUID(),
		recipient: { accountId: "account-a", kind: "user", externalId: "u" },
		card: {
			title: "title",
			summary: "summary",
			evidence: [],
			options: [{ id: "a", label: "A" }],
		},
		actions: [{ optionId: "a", actionRef: "opaque" }],
	};
	const card = toFeishuCard(delivery) as {
		schema: string;
		body: {
			elements: Array<{
				tag?: string;
				behaviors?: Array<{ type: string; value: { actionRef: string } }>;
			}>;
		};
	};
	assert.equal(card.schema, "2.0");
	assert.deepEqual(card.body.elements.at(-1)!.behaviors, [
		{ type: "callback", value: { actionRef: "opaque" } },
	]);
	assert.ok(!JSON.stringify(card).includes("sessionId"));
	assert.ok(
		!card.body.elements.some((x) => x.tag === "action" || x.tag === "note"),
	);
	assert.throws(
		() => toFeishuCard({ ...delivery, actions: [] }),
		/missing action/,
	);
});
test("Feishu outbound uses correct recipient type, caches token and reuses delivery UUID", async () => {
	const calls: Array<{ url: string; body: any }> = [];
	const outbound = new FeishuOutbound(
		{ ...config, appSecret: "app-secret" },
		async (input, options) => {
			const url = String(input);
			calls.push({ url, body: JSON.parse(String(options?.body)) });
			return new Response(
				JSON.stringify(
					url.includes("/auth/")
						? { code: 0, tenant_access_token: "token", expire: 7200 }
						: { code: 0, data: { message_id: "message" } },
				),
				{ status: 200 },
			);
		},
	);
	const delivery: CardDelivery = {
		id: crypto.randomUUID(),
		recipient: { accountId: "account-a", kind: "user", externalId: "u" },
		card: { title: "title", summary: "summary", evidence: [], options: [] },
		actions: [],
	};
	await outbound.send(delivery);
	await outbound.send(delivery);
	assert.equal(calls.filter((c) => c.url.includes("/auth/")).length, 1);
	assert.equal(calls[1].body.uuid, delivery.id);
	assert.equal(calls[2].body.uuid, delivery.id);
	assert.match(calls[1].url, /receive_id_type=open_id/);
	assert.equal(calls[1].body.msg_type, "interactive");
});
