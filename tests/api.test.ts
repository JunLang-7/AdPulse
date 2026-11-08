import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../apps/api/dist/server.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { proposal } from "./helpers.ts";

const token = "xxxxxxxxxxxxxxxxxxxxxxxx";
async function serve(
  t: TestContext,
  options: { failReceive?: boolean } = {},
) {
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
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
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
  const action = details.actions.find(
    (a: { optionId: string }) => a.optionId === "adjust",
  );
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

test("task API preserves unknown versus zero, enforces idempotency/versioning, and scopes access", async (t) => {
  const { url, headers } = await serve(t);
  const body = {
    product: "产品 A",
    strategy: {
      objective: "咨询",
      audience: ["小企业"],
      channels: { ads: {} },
      sellingPoints: [],
    },
    observation: {},
    rules: { minimumSpendMinor: 0 },
  };
  const createKey = crypto.randomUUID();
  const create = async (input: unknown, key = createKey) => fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": key },
    body: JSON.stringify(input),
  });
  const firstResponse = await create(body);
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  assert.equal(first.rules.minimumSpendMinor, 0);
  assert.equal(first.rules.alertThresholdMinor, undefined);
  assert.equal(first.strategy.channels.ads.budget, undefined);
  assert.equal((await (await create(body)).json()).taskId, first.taskId);
  assert.equal((await create({ ...body, product: "不同内容" })).status, 409);

  const revisionKey = crypto.randomUUID();
  const revisionBody = { ...body, product: "产品 B" };
  const revise = (expectedTaskVersion: number, input: unknown, key = revisionKey) => fetch(`${url}/api/tasks/${first.taskId}`, {
    method: "PATCH",
    headers: { ...headers, "idempotency-key": key },
    body: JSON.stringify({ expectedTaskVersion, task: input }),
  });
  const secondResponse = await revise(1, revisionBody);
  assert.equal(secondResponse.status, 200);
  assert.equal((await secondResponse.json()).version, 2);
  assert.equal((await revise(1, revisionBody)).status, 200);
  assert.equal((await revise(1, { ...body, product: "过期写入" }, crypto.randomUUID())).status, 409);

  const detailResponse = await fetch(`${url}/api/tasks/${first.taskId}`, { headers });
  const detail = await detailResponse.json();
  assert.equal(detail.task.version, 2);
  assert.deepEqual(detail.versions.map((version: { version: number }) => version.version), [1, 2]);
  const stranger = await fetch(`${url}/api/tasks/${first.taskId}`, {
    headers: { ...headers, authorization: "Bearer yyyyyyyyyyyyyyyyyyyyyyyy" },
  });
  assert.equal(stranger.status, 401);
  const invalid = await create({ ...body, rules: { maxPushRounds: 0 } }, crypto.randomUUID());
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /rules.maxPushRounds/);

  const invalidPeriod = {
    ...body,
    observation: {
      startsAt: "2026-02-02T00:00:00.000Z",
      endsAt: "2026-02-01T00:00:00.000Z",
    },
  };
  const invalidCreate = await create(invalidPeriod, crypto.randomUUID());
  assert.equal(invalidCreate.status, 400);
  assert.match((await invalidCreate.json()).error, /observation.startsAt/);
  const invalidRevision = await revise(2, invalidPeriod, crypto.randomUUID());
  assert.equal(invalidRevision.status, 400);
  assert.match((await invalidRevision.json()).error, /observation.startsAt/);
});

test("evidence JSON imports preserve provenance, deduplicate, revise immutably, and validate atomically", async (t) => {
  const { url, headers } = await serve(t);
  const taskResponse = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      product: "产品 A",
      strategy: { objective: "咨询", audience: [], channels: {}, sellingPoints: [] },
      observation: {},
      rules: {},
    }),
  });
  const task = await taskResponse.json();
  const makeRecord = (overrides = {}) => ({
    source: { platform: "web-report", accountRef: "account-1", reportRef: "report-1" },
    scope: { planRef: "plan-1", campaignRefs: ["campaign-1"] },
    period: {
      startsAt: "2026-01-01T00:00:00+08:00",
      endsAt: "2026-01-02T00:00:00+08:00",
      timeZone: "Asia/Shanghai",
      completeness: "complete",
    },
    metricsContract: {
      spendMinor: { definition: "消耗", formula: "原始值换算为分", sourceField: "spend" },
      consultations: { definition: "咨询数", formula: "报表咨询数", sourceField: "consultations" },
    },
    currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
    attribution: { model: "click", windowDays: 7 },
    callbackStatus: "complete",
    rawValues: { spend: "0.00", consultations: null },
    values: { spendMinor: 0 },
    ...overrides,
  });
  const body = {
    schemaVersion: 1,
    taskRef: { taskId: task.taskId, taskVersion: 1 },
    records: [makeRecord()],
  };
  const importEvidence = (input: unknown, key = crypto.randomUUID()) => fetch(`${url}/api/evidence/imports`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": key },
    body: JSON.stringify(input),
  });
  const key = crypto.randomUUID();
  const createdResponse = await importEvidence(body, key);
  assert.equal(createdResponse.status, 201);
  const [created] = (await createdResponse.json()).items;
  const retryResponse = await importEvidence(body, key);
  assert.equal(retryResponse.status, 201);
  assert.deepEqual((await retryResponse.json()).items[0], created);

  const duplicateBody = {
    ...body,
    records: [makeRecord({
      source: { platform: "web-report", accountRef: "account-1", reportRef: "report-2" },
    })],
  };
  const duplicateResponse = await importEvidence(duplicateBody);
  assert.equal(duplicateResponse.status, 200);
  assert.equal((await duplicateResponse.json()).items[0].evidenceId, created.evidenceId);

  const conflictBody = {
    ...body,
    records: [makeRecord({ values: { spendMinor: 10 } })],
  };
  assert.equal((await importEvidence(conflictBody)).status, 409);

  const listResponse = await fetch(`${url}/api/tasks/${task.taskId}/evidence`, { headers });
  const list = await listResponse.json();
  assert.equal(list.items.length, 1);
  const detailResponse = await fetch(`${url}/api/evidence/${created.evidenceId}`, { headers });
  const detail = await detailResponse.json();
  assert.equal(detail.current.values.spendMinor, 0);
  assert.equal("consultations" in detail.current.values, false);
  assert.equal(detail.sources.length, 2);

  const revisionResponse = await fetch(`${url}/api/evidence/${created.evidenceId}/revisions`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      expectedEvidenceVersion: 1,
      reason: "报表修正",
      record: makeRecord({
        source: { platform: "web-report", accountRef: "account-1", reportRef: "report-1-fixed" },
        values: { spendMinor: 5000, consultations: 5 },
        rawValues: { spend: "50.00", consultations: "5" },
      }),
    }),
  });
  assert.equal(revisionResponse.status, 201);
  assert.equal((await revisionResponse.json()).version, 2);
  const finalDetail = await (await fetch(`${url}/api/evidence/${created.evidenceId}`, { headers })).json();
  assert.equal(finalDetail.versions.length, 2);
  assert.equal(finalDetail.versions[0].values.spendMinor, 0);
  assert.equal(finalDetail.current.values.spendMinor, 5000);

  const invalidBatch = {
    ...body,
    records: [
      makeRecord(),
      makeRecord({
        period: {
          startsAt: "2026-01-02T00:00:00+08:00",
          endsAt: "2026-01-03T00:00:00+08:00",
          timeZone: "Asia/Shanghai",
          completeness: "complete",
        },
        values: { spendMinor: -1 },
      }),
    ],
  };
  assert.equal((await importEvidence(invalidBatch)).status, 400);
  assert.equal((await (await fetch(`${url}/api/tasks/${task.taskId}/evidence`, { headers })).json()).items.length, 1);
});

test("comparison API requires explicit evidence versions and exposes immutable results and verified follow-ups", async (t) => {
  const { url, headers } = await serve(t);
  const taskResponse = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      product: "产品 A",
      strategy: { objective: "咨询", audience: [], channels: {}, sellingPoints: [] },
      observation: {},
      rules: {
        metricKey: "cost_per_consultation",
        currency: "CNY",
        unit: "分",
        statWindowDays: 1,
        alertThresholdMinor: 100,
        minimumSpendMinor: 0,
        minimumConsultations: 0,
      },
    }),
  });
  const task = await taskResponse.json();
  const makeRecord = (startsAt: string, endsAt: string) => ({
    source: { platform: "web-report", accountRef: "account-1", reportRef: `${startsAt}-report` },
    scope: { planRef: "plan-1", campaignRefs: ["campaign-1"] },
    period: { startsAt, endsAt, timeZone: "Asia/Shanghai", completeness: "complete" },
    metricsContract: {
      spendMinor: { definition: "消耗", formula: "原始值换算为分", sourceField: "spend" },
      consultations: { definition: "咨询数", formula: "报表咨询数", sourceField: "consultations" },
    },
    currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
    attribution: { model: "click", windowDays: 7 },
    callbackStatus: "complete",
    rawValues: { spend: "10.00", consultations: "10" },
    values: { spendMinor: 1000, consultations: 10 },
  });
  const importRecord = async (item: ReturnType<typeof makeRecord>) => {
    const response = await fetch(`${url}/api/evidence/imports`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        schemaVersion: 1,
        taskRef: { taskId: task.taskId, taskVersion: 1 },
        records: [item],
      }),
    });
    assert.equal(response.status, 201);
    const imported = (await response.json()).items[0] as { evidenceId: string; version: number };
    return { evidenceId: imported.evidenceId, version: imported.version };
  };
  const current = await importRecord(
    makeRecord("2026-01-02T00:00:00+08:00", "2026-01-03T00:00:00+08:00"),
  );
  const compare = (body: unknown, key = crypto.randomUUID()) => fetch(`${url}/api/comparisons/evaluate`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": key },
    body: JSON.stringify(body),
  });
  const key = crypto.randomUUID();
  const body = { current, baseline: undefined };
  const firstResponse = await compare(body, key);
  assert.equal(firstResponse.status, 201, await firstResponse.clone().text());
  const first = await firstResponse.json();
  assert.equal(first.status, "missing_baseline");
  assert.equal(first.canEvaluateCurrentThreshold, true);
  assert.equal((await compare(body, key)).status, 201);
  assert.equal((await compare({ current: { evidenceId: current.evidenceId, version: 99 } })).status, 404);
  assert.equal((await fetch(`${url}/api/tasks/${task.taskId}/comparisons`, { headers })).status, 200);
  const followUpResponse = await fetch(`${url}/api/tasks/${task.taskId}/comparison-follow-ups`, { headers });
  const followUps = (await followUpResponse.json()).items;
  const missingBaseline = followUps.find((item: { reasonCode: string }) => item.reasonCode === "NO_BASELINE");
  assert.ok(missingBaseline);
  const baseline = await importRecord(
    makeRecord("2026-01-01T00:00:00+08:00", "2026-01-02T00:00:00+08:00"),
  );
  const resolve = await fetch(`${url}/api/comparison-follow-ups/${missingBaseline.id}/resolve`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ material: { kind: "evidence", ...baseline } }),
  });
  assert.equal(resolve.status, 200);
  assert.equal((await resolve.json()).status, "completed");
});

test("sessions freeze the referenced task version and incomplete rules disable monetary suggestions", async (t) => {
  const { runtime, url, headers } = await serve(t);
  const taskBody = {
    product: "产品 A",
    strategy: startInput().strategy,
    observation: {},
    rules: {},
  };
  const taskResponse = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(taskBody),
  });
  const task = await taskResponse.json();
  const taskRef = { taskId: task.taskId, taskVersion: 1 };
  const mismatchedResponse = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ ...startInput(), strategy: { ...startInput().strategy, objective: "别的策略" }, taskRef }),
  });
  assert.equal(mismatchedResponse.status, 400);
  const sessionBody = { ...startInput(), taskRef };
  const sessionResponse = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(sessionBody),
  });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json();
  assert.deepEqual(session.taskRef, { taskId: task.taskId, taskVersion: 1 });
  assert.equal(session.monetarySuggestionsAllowed, false);
  const saved = await runtime.storage.transaction((tx) => tx.sessions.get(session.id));
  assert.deepEqual(saved?.taskRef, { taskId: task.taskId, taskVersion: 1 });
  const revision = await fetch(`${url}/api/tasks/${task.taskId}`, {
    method: "PATCH",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      expectedTaskVersion: 1,
      task: {
        ...taskBody,
        rules: {
          metricDefinition: "咨询成本",
          currency: "CNY",
          unit: "分",
          statWindowDays: 7,
          alertThresholdMinor: 10000,
          minimumSpendMinor: 50000,
          minimumConsultations: 3,
        },
      },
    }),
  });
  assert.equal(revision.status, 200);
  await runtime.worker.runOnce();
  const rounds = await runtime.storage.transaction((tx) => tx.rounds.all());
  assert.equal(rounds.length, 0, "unconfirmed task rules must block monetary proposals");
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
