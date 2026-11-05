import test from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../apps/api/dist/server.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { proposal } from "./helpers.mjs";

const token = "xxxxxxxxxxxxxxxxxxxxxxxx";
async function serve(t, options = {}) {
  const runtime = compose(new MemoryStorage(), [
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
              actor: { kind: "platform", accountId: "account-a", externalId: "user-a" },
            },
            response: { status: 200, headers: { "content-type": "text/plain" }, body: "success" },
          };
        },
      },
      outbound: { async send(d) { return { externalMessageId: d.id }; } },
    },
  ], { propose: async () => structuredClone(proposal) });
  if (options.failReceive) runtime.decisions.receiveChoice = async () => { throw new Error("database offline"); };
  const server = createApi(runtime, { token, userId: "owner" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return { runtime, url, headers };
}
const startInput = () => ({
  recipient: { accountId: "account-a", kind: "user", externalId: "user-a" },
  allowedActorIds: ["user-a"],
  strategy: { objective: "leads", audience: [], channels: { ads: { bidCpc: 2 } }, sellingPoints: [] },
  limits: { maxBidChangeRatio: 0.2, maxBudgetChangeRatio: 0.2 },
  signal: { id: "sig", title: "成本变化", summary: "需要复核", evidence: proposal.card.evidence },
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

test("HTTP flow drives create -> card -> console choice -> strategy snapshot", async (t) => {
  const { runtime, url, headers } = await serve(t);
  const key = crypto.randomUUID();
  const createdRes = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": key },
    body: JSON.stringify(startInput()),
  });
  assert.equal(createdRes.status, 201);
  const created = await createdRes.json();
  const duplicateRes = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": key },
    body: JSON.stringify(startInput()),
  });
  const duplicate = await duplicateRes.json();
  assert.equal(duplicate.id, created.id);
  await runtime.worker.runOnce();
  await runtime.worker.runOnce();
  const detailsRes = await fetch(`${url}/api/sessions/${created.id}`, { headers });
  const details = await detailsRes.json();
  assert.equal(details.rounds.length, 1);
  assert.equal(details.deliveries[0].status, "sent");
  const action = details.actions.find((a) => a.optionId === "adjust");
  const choiceRes = await fetch(`${url}/api/choices`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ actionRef: action.id }),
  });
  assert.equal(choiceRes.status, 202);
  const receipt = await choiceRes.json();
  await runtime.worker.runOnce();
  const outcomeRes = await fetch(`${url}/api/choices/${receipt.inboxId}`, { headers });
  const outcome = await outcomeRes.json();
  assert.equal(outcome.status, "processed");
  const finalRes = await fetch(`${url}/api/sessions/${created.id}`, { headers });
  const final = await finalRes.json();
  assert.equal(final.session.strategy.channels.ads.bidCpc, 1.8);
  assert.equal(final.snapshots.length, 2);
});

test("HTTP validates authentication, unknown accounts and payloads", async (t) => {
  const { url } = await serve(t);
  assert.equal((await fetch(`${url}/api/sessions`)).status, 401);
  const invalidRes = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ ...startInput(), ownerId: "spoof" }),
  });
  assert.equal(invalidRes.status, 400);
  const unknownRes = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ ...startInput(), recipient: { accountId: "unknown", kind: "user", externalId: "u" } }),
  });
  assert.equal(unknownRes.status, 400);
  const missingRes = await fetch(`${url}/api/sessions/nonexistent`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(missingRes.status, 404);
});

test("webhook returns failure instead of ACK if persistence fails", async (t) => {
  const { url } = await serve(t, { failReceive: true });
  const response = await fetch(`${url}/webhooks/account-a`, { method: "POST", body: "{}" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "temporarily unavailable" });
});

test("webhook is ACKed only after an inbox record exists and keeps provider response format", async (t) => {
  const { runtime, url } = await serve(t);
  const response = await fetch(`${url}/webhooks/account-a`, { method: "POST", body: "{}" });
  assert.equal(await response.text(), "success");
  assert.equal((await runtime.storage.transaction((tx) => tx.inbox.all())).length, 1);
  assert.equal((await fetch(`${url}/webhooks/missing`, { method: "POST", body: "{}" })).status, 404);
});
