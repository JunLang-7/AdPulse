import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../apps/api/dist/server.js";
import { createConsoleClient } from "../apps/console/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { proposal } from "./helpers.mjs";

const token = "xxxxxxxxxxxxxxxxxxxxxxxx";
async function serve(t, options = {}) {
	const runtime = compose(
		new MemoryStorage(),
		[
			{
				id: "account-a",
				inbound: {
					async parse() {
						return {
							kind: "choice",
							command: {
								sourceId: "account-a",
								eventId: "event1",
								actionRef: "ref",
								actor: {
									kind: "platform",
									accountId: "account-a",
									externalId: "user-a",
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
					async send(d) {
						return { externalMessageId: d.id };
					},
				},
			},
		],
		{ propose: async () => structuredClone(proposal) },
	);
	if (options.failReceive)
		runtime.decisions.receiveChoice = async () => {
			throw new Error("database offline");
		};
	const server = createApi(runtime, { token, userId: "owner" });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const url = `http://127.0.0.1:${server.address().port}`;
	return { runtime, url, client: createConsoleClient(url, token) };
}
const startInput = () => ({
	recipient: { accountId: "account-a", kind: "user", externalId: "user-a" },
	allowedActorIds: ["user-a"],
	strategy: {
		objective: "leads",
		audience: [],
		channels: { ads: { bidCpc: 2 } },
		sellingPoints: [],
	},
	limits: { maxBidChangeRatio: 0.2, maxBudgetChangeRatio: 0.2 },
	signal: {
		id: "sig",
		title: "成本变化",
		summary: "需要复核",
		evidence: proposal.card.evidence,
	},
	expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

test("generated SDK drives create -> card -> console choice -> strategy snapshot", async (t) => {
	const { runtime, client } = await serve(t);
	const key = crypto.randomUUID();
	const input = startInput();
	const created = await client.POST("/api/sessions", {
		body: input,
		params: { header: { "Idempotency-Key": key } },
	});
	assert.equal(created.response.status, 201);
	const duplicate = await client.POST("/api/sessions", {
		body: input,
		params: { header: { "Idempotency-Key": key } },
	});
	assert.equal(duplicate.data.id, created.data.id);
	await runtime.worker.runOnce();
	await runtime.worker.runOnce();
	const details = await client.GET("/api/sessions/{sessionId}", {
		params: { path: { sessionId: created.data.id } },
	});
	assert.equal(details.data.rounds.length, 1);
	assert.equal(details.data.deliveries[0].status, "sent");
	const action = details.data.actions.find((a) => a.optionId === "adjust");
	const receipt = await client.POST("/api/choices", {
		body: { actionRef: action.id },
		params: { header: { "Idempotency-Key": crypto.randomUUID() } },
	});
	assert.equal(receipt.response.status, 202);
	await runtime.worker.runOnce();
	const outcome = await client.GET("/api/choices/{inboxId}", {
		params: { path: { inboxId: receipt.data.inboxId } },
	});
	assert.equal(outcome.data.status, "processed");
	const final = await client.GET("/api/sessions/{sessionId}", {
		params: { path: { sessionId: created.data.id } },
	});
	assert.equal(final.data.session.strategy.channels.ads.bidCpc, 1.8);
	assert.equal(final.data.snapshots.length, 2);
});

test("HTTP validates authentication, unknown accounts and payloads", async (t) => {
	const { client, url } = await serve(t);
	assert.equal((await fetch(`${url}/api/sessions`)).status, 401);
	const invalid = await client.POST("/api/sessions", {
		body: { ...startInput(), ownerId: "spoof" },
		params: { header: { "Idempotency-Key": crypto.randomUUID() } },
	});
	assert.equal(invalid.response.status, 400);
	const unknown = await client.POST("/api/sessions", {
		body: {
			...startInput(),
			recipient: { accountId: "unknown", kind: "user", externalId: "u" },
		},
		params: { header: { "Idempotency-Key": crypto.randomUUID() } },
	});
	assert.equal(unknown.response.status, 400);
	const missing = await client.GET("/api/sessions/{sessionId}", {
		params: { path: { sessionId: "nonexistent" } },
	});
	assert.equal(missing.response.status, 404);
});

test("webhook returns failure instead of ACK if persistence fails", async (t) => {
	const { url } = await serve(t, { failReceive: true });
	const response = await fetch(`${url}/webhooks/account-a`, {
		method: "POST",
		body: "{}",
	});
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "temporarily unavailable" });
});

test("webhook is ACKed only after an inbox record exists and keeps provider response format", async (t) => {
	const { runtime, url } = await serve(t);
	const response = await fetch(`${url}/webhooks/account-a`, {
		method: "POST",
		body: "{}",
	});
	assert.equal(await response.text(), "success");
	assert.equal(
		(await runtime.storage.transaction((tx) => tx.inbox.all())).length,
		1,
	);
	assert.equal(
		(await fetch(`${url}/webhooks/missing`, { method: "POST", body: "{}" }))
			.status,
		404,
	);
});
