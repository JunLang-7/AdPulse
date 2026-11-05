import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
	ChannelRegistry,
	FeishuInbound,
	FeishuOutbound,
	toFeishuCard,
} from "../packages/channels/dist/index.js";
import { fixture } from "./helpers.ts";

const config = {
	accountId: "account-a",
	appId: "app",
	tenantKey: "tenant",
	verificationToken: "verify",
	encryptKey: "secret",
};
const time = Date.parse("2026-01-01T00:00:00.000Z");
const inbound = new FeishuInbound(config, () => time);
function request(payload, encrypt = false) {
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
function event(actionRef = "ref") {
	return {
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
		}),
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
	await registry.outbound().get("provider-b").send({});
	assert.equal(sends, 1);
});
test("Feishu JSON 2.0 contains opaque references, not mutable strategy data", () => {
	const delivery = {
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
	const card = toFeishuCard(delivery);
	assert.equal(card.schema, "2.0");
	assert.deepEqual(card.body.elements.at(-1).behaviors, [
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
	const calls = [];
	const outbound = new FeishuOutbound(
		{ ...config, appSecret: "app-secret" },
		async (url, options) => {
			calls.push({ url, body: JSON.parse(options.body) });
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
	const delivery = {
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
