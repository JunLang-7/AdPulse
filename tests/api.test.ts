import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createApi } from "../apps/api/dist/server.js";
import {
  AuthenticationService,
  type PlatformIdentity,
} from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { proposal } from "./helpers.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ownerIdentity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: "ou-owner" };
async function serve(
  t: TestContext,
  options: {
    failReceive?: boolean;
    publicOrigin?: string;
    now?: () => Date;
    sessionIssuedAt?: string;
  } = {},
) {
  let webhookChoice = { actorExternalId: "user-a", actionRef: "ref" };
  const runtime = compose(new MemoryStorage(), [
    {
      id: "account-a",
      identityScope: {
        platform: "feishu",
        applicationId: "cli_test",
        tenantId: "tenant-a",
      },
      inbound: {
        identifyActor(actor) {
          return { ...ownerIdentity, externalId: actor.externalId };
        },
        async parse() {
          return {
            kind: "choice",
            command: {
              sourceId: "account-a",
              eventId: crypto.randomUUID(),
              actionRef: webhookChoice.actionRef,
              actor: {
                kind: "platform",
                accountId: "account-a",
                externalId: webhookChoice.actorExternalId,
              },
            },
            response: { status: 200, headers: { "content-type": "text/plain" }, body: "success" },
          };
        },
      },
      outbound: { async send(d) { return { externalMessageId: d.id }; } },
    },
  ], { propose: async () => structuredClone(proposal) });
  if (options.failReceive) runtime.decisions.receiveChoice = async () => { throw new Error("database offline"); };
  const storage = runtime.storage;
  const service = new AuthenticationService(storage);
  const issuedAt = options.sessionIssuedAt ?? new Date().toISOString();
  const ownerToken = randomBytes(32).toString("base64url");
  const strangerToken = randomBytes(32).toString("base64url");
  const ownerSession = await service.createWebSession(
    ownerIdentity,
    hash(ownerToken),
    issuedAt,
  );
  await service.createWebSession({ ...ownerIdentity, externalId: "ou-stranger" }, hash(strangerToken), issuedAt);
  const publicOrigin = options.publicOrigin ?? "http://localhost";
  const provider = {
    authorizationUrl(parameters: { state: string; codeChallenge: string; redirectUri: string }) {
      const target = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
      target.searchParams.set("state", parameters.state);
      target.searchParams.set("code_challenge", parameters.codeChallenge);
      target.searchParams.set("code_challenge_method", "S256");
      target.searchParams.set("redirect_uri", parameters.redirectUri);
      return target.toString();
    },
    async verifyAuthorizationCode() { return { identity: ownerIdentity }; },
  };
  const server = createApi(runtime, {
    service,
    provider,
    publicOrigin,
    ...(options.now ? { now: options.now } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const headers = {
    cookie: `adpulse_session=${ownerToken}`,
    origin: publicOrigin,
    "content-type": "application/json",
  };
  const strangerHeaders = {
    ...headers,
    cookie: `adpulse_session=${strangerToken}`,
  };
  return {
    runtime,
    url,
    headers,
    strangerHeaders,
    publicOrigin,
    service,
    ownerUserId: ownerSession.userId,
    setWebhook: (choice: { actorExternalId: string; actionRef: string }) => {
      webhookChoice = choice;
    },
  };
}
const startInput = () => ({
  recipient: { accountId: "account-a", kind: "user", externalId: "ou-owner" },
  allowedActorIds: ["ou-owner"],
  strategy: { objective: "leads", audience: [], channels: { ads: { bidCpc: 2 } }, sellingPoints: [] },
  limits: { maxBidChangeRatio: 0.2, maxBudgetChangeRatio: 0.2 },
  signal: { id: "sig", title: "成本变化", summary: "需要复核", evidence: proposal.card.evidence },
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

test("HTTP: proactive decision jobs remain owner-scoped and terminal deliveries cannot be revived", async (t) => {
  const { runtime, url, headers, strangerHeaders, ownerUserId } =
    await serve(t);
  const input = startInput();
  const session = await runtime.decisions.startSession({
    ...input,
    recipient: { ...input.recipient, kind: "user" },
    requestId: crypto.randomUUID(),
    ownerId: ownerUserId,
  });
  await runtime.decisions.prepareRound(session.id, 0);
  const delivery = (
    await runtime.storage.transaction((tx) => tx.deliveries.all())
  )[0];
  assert.ok(delivery);
  const job = (await runtime.storage.transaction((tx) => tx.jobs.all())).find(
    (item) => item.task.kind === "send_delivery",
  );
  assert.ok(job);
  await runtime.storage.transaction(async (tx) => {
    await tx.jobs.put({
      ...job,
      task: { kind: "send_investigation_decision", deliveryId: delivery.id },
      status: "failed",
    });
    await tx.deliveries.put({
      ...delivery,
      status: "suppressed",
      suppressionReason: "settings_changed",
    });
  });
  const route = `${url}/api/jobs/${encodeURIComponent(job.id)}/retry`;
  assert.equal(
    (await fetch(route, { method: "POST", headers: strangerHeaders })).status,
    404,
  );
  assert.equal((await fetch(route, { method: "POST", headers })).status, 409);
  assert.equal(
    (
      await runtime.storage.transaction((tx) =>
        tx.deliveries.get(delivery.id),
      )
    )?.status,
    "suppressed",
  );
  const detail: { jobs: Array<{ id: string; task: { kind: string } }> } =
    await (
      await fetch(`${url}/api/sessions/${encodeURIComponent(session.id)}`, {
        headers,
      })
    ).json();
  assert.ok(
    detail.jobs.some(
      (item) =>
        item.id === job.id &&
        item.task.kind === "send_investigation_decision",
    ),
  );
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
  const { url, headers, strangerHeaders } = await serve(t);
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
    headers: strangerHeaders,
  });
  assert.equal(stranger.status, 404);
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

test("saved comparison evaluates threshold alerts and task alert history is owner-scoped", async (t) => {
  const { runtime, url, headers } = await serve(t);
  const taskResponse = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      product: "产品 A",
      strategy: { objective: "咨询", audience: [], channels: {}, sellingPoints: [] },
      observation: {},
      rules: {
        metricDefinition: "单次咨询成本",
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
  const evidenceResponse = await fetch(`${url}/api/evidence/imports`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      schemaVersion: 1,
      taskRef: { taskId: task.taskId, taskVersion: 1 },
      records: [{
        source: { platform: "web-report", accountRef: "account-1", reportRef: "threshold-report" },
        scope: { planRef: "plan-1", campaignRefs: ["campaign-1"] },
        period: {
          startsAt: "2026-01-01T00:00:00+08:00",
          endsAt: "2026-01-02T00:00:00+08:00",
          timeZone: "Asia/Shanghai",
          completeness: "complete",
        },
        metricsContract: {
          spendMinor: { definition: "消耗", formula: "原始值换算为分", sourceField: "spend" },
          consultations: { definition: "咨询数", formula: "报表数", sourceField: "consultations" },
        },
        currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
        attribution: { model: "click", windowDays: 7 },
        callbackStatus: "complete",
        rawValues: { spend: "20.00", consultations: 10 },
        values: { spendMinor: 2_000, consultations: 10 },
      }],
    }),
  });
  assert.equal(evidenceResponse.status, 201);
  const evidence = (await evidenceResponse.json()).items[0];
  const comparisonResponse = await fetch(`${url}/api/comparisons/evaluate`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ current: { evidenceId: evidence.evidenceId, version: evidence.version } }),
  });
  assert.equal(comparisonResponse.status, 201);
  const comparison = await comparisonResponse.json();
  assert.equal(comparison.status, "missing_baseline");
  assert.equal(comparison.thresholdEvaluation.status, "exceeded");
  const response = await fetch(`${url}/api/tasks/${task.taskId}/investigation-alerts`, { headers });
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].current.comparisonResultId, comparison.id);
  assert.equal(listed.items[0].current.canComparePeriods, false);
  assert.equal(listed.items[0].status, "open");
  assert.equal((await fetch(`${url}/api/tasks/not-found/investigation-alerts`, { headers })).status, 404);
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

test("session detail exposes validation checks only to the owner", async (t) => {
  const { runtime, url, headers, strangerHeaders, ownerUserId } = await serve(t);
  assert.ok(ownerUserId);
  const created = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(startInput()),
  });
  assert.equal(created.status, 201);
  const session = await created.json();
  await runtime.storage.transaction((tx) => tx.validationChecks.put({
    id: `${session.id}:1`,
    ownerId: ownerUserId,
    taskId: "task-1",
    taskVersion: 1,
    sessionId: session.id,
    snapshotVersion: 1,
    validationPlan: "观察 7 天咨询成本",
    metricKey: "cost_per_consultation",
    dueAt: "2026-01-08T00:00:00.000Z",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  const detail = await (
    await fetch(`${url}/api/sessions/${session.id}`, { headers })
  ).json();
  assert.equal(detail.validationChecks.length, 1);
  assert.equal(detail.validationChecks[0].validationPlan, "观察 7 天咨询成本");
  const denied = await fetch(`${url}/api/sessions/${session.id}`, {
    headers: strangerHeaders,
  });
  assert.equal(denied.status, 404);
});

test("HTTP validates cookie authentication, same-origin mutations, unknown accounts and payloads", async (t) => {
  const { url, headers, publicOrigin } = await serve(t);
  assert.equal((await fetch(`${url}/api/sessions`)).status, 401);
  const duplicateCookie = await fetch(`${url}/api/me`, {
    headers: { cookie: `${headers.cookie}; ${headers.cookie}` },
  });
  assert.equal(duplicateCookie.status, 401);
  const missingOrigin = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { cookie: headers.cookie, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(startInput()),
  });
  assert.equal(missingOrigin.status, 403);
  const crossOrigin = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { ...headers, origin: "https://attacker.example", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(startInput()),
  });
  assert.equal(crossOrigin.status, 403);
  const invalidRes = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { ...headers, origin: publicOrigin, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ ...startInput(), ownerId: "spoof" }),
  });
  assert.equal(invalidRes.status, 400);
  const unknownRes = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ ...startInput(), recipient: { accountId: "unknown", kind: "user", externalId: "u" } }),
  });
  assert.equal(unknownRes.status, 400);
  const missingRes = await fetch(`${url}/api/sessions/nonexistent`, { headers });
  assert.equal(missingRes.status, 404);
});

test("HTTP enforces the twenty-four-hour idle session expiry without sliding on reads", async (t) => {
  const issuedAt = "2026-03-01T00:00:00.000Z";
  let clock = Date.parse(issuedAt);
  const { url, headers } = await serve(t, {
    sessionIssuedAt: issuedAt,
    now: () => new Date(clock),
  });
  const status = async () => (await fetch(`${url}/api/me`, { headers })).status;
  clock = Date.parse("2026-03-01T23:59:59.999Z");
  assert.equal(await status(), 200);
  clock = Date.parse("2026-03-02T00:00:00.000Z");
  assert.equal(await status(), 401, "expiry is inclusive at the twenty-four-hour boundary");
  clock = Date.parse("2026-03-02T00:00:00.001Z");
  assert.equal(await status(), 401);
  assert.equal(
    await status(),
    401,
    "requests before expiry did not slide the idle deadline",
  );
});

test("Feishu login binds one-time state to the browser and issues a revocable HttpOnly session", async (t) => {
  const { runtime, url, headers, publicOrigin } = await serve(t);
  const invalidTarget = await fetch(
    `${url}/auth/feishu/login?returnTo=${encodeURIComponent("https://attacker.example/")}`,
    { redirect: "manual" },
  );
  assert.equal(invalidTarget.status, 400);
  const oversizedTarget = await fetch(
    `${url}/auth/feishu/login?returnTo=${encodeURIComponent(`/${"a".repeat(2048)}`)}`,
    { redirect: "manual" },
  );
  assert.equal(oversizedTarget.status, 400);
  const normalizedExternalTarget = await fetch(
    `${url}/auth/feishu/login?returnTo=${encodeURIComponent("/%2e%2e//attacker.example")}`,
    { redirect: "manual" },
  );
  assert.equal(normalizedExternalTarget.status, 400);

  const begin = await fetch(
    `${url}/auth/feishu/login?returnTo=${encodeURIComponent("/sessions?sort=recent")}`,
    { headers: { cookie: headers.cookie }, redirect: "manual" },
  );
  assert.equal(begin.status, 302);
  const authorizationUrl = new URL(begin.headers.get("location")!);
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    authorizationUrl.searchParams.get("redirect_uri"),
    `${publicOrigin}/auth/feishu/callback`,
  );
  const nonceHeader = begin.headers.get("set-cookie") ?? "";
  const nonce = /adpulse_oauth_nonce=([A-Za-z0-9_-]{43})/.exec(nonceHeader)?.[1];
  assert.ok(nonce);
  assert.match(nonceHeader, /HttpOnly/);
  assert.match(nonceHeader, /SameSite=Lax/);

  const rejectedBrowser = await fetch(
    `${url}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
    { headers: { cookie: `adpulse_oauth_nonce=${"A".repeat(43)}` }, redirect: "manual" },
  );
  assert.equal(rejectedBrowser.status, 303);
  assert.equal(rejectedBrowser.headers.get("location"), "/login?error=authorization");

  const callback = await fetch(
    `${url}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
    {
      headers: { cookie: `${headers.cookie}; adpulse_oauth_nonce=${nonce}` },
      redirect: "manual",
    },
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/sessions?sort=recent");
  const cookies = callback.headers.get("set-cookie") ?? "";
  assert.match(cookies, /adpulse_session=[A-Za-z0-9_-]{43}/);
  assert.match(cookies, /adpulse_session=.*HttpOnly/);
  assert.match(cookies, /adpulse_session=.*SameSite=Lax/);
  const sessionToken = /adpulse_session=([A-Za-z0-9_-]{43})/.exec(cookies)?.[1];
  assert.ok(sessionToken);
  const loginTransactions = await runtime.storage.transaction((tx) => tx.loginTransactions.all());
  assert.equal(loginTransactions[0]?.status, "consumed");
  assert.equal(loginTransactions[0]?.codeVerifier, "");

  const me = await fetch(`${url}/api/me`, {
    headers: { cookie: `adpulse_session=${sessionToken}` },
  });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.ok(meBody.userId);
  assert.deepEqual(meBody.identities, [ownerIdentity]);
  assert.equal(
    (await fetch(`${url}/api/me`, { headers: { cookie: headers.cookie } })).status,
    401,
    "logging in revokes the previous browser session",
  );
  const blockedLogout = await fetch(`${url}/api/logout`, {
    method: "POST",
    headers: { cookie: `adpulse_session=${sessionToken}`, origin: "https://attacker.example" },
  });
  assert.equal(blockedLogout.status, 403);
  const logout = await fetch(`${url}/api/logout`, {
    method: "POST",
    headers: { cookie: `adpulse_session=${sessionToken}`, origin: publicOrigin },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /adpulse_session=;.*Max-Age=0/);
  assert.equal(
    (await fetch(`${url}/api/me`, { headers: { cookie: `adpulse_session=${sessionToken}` } })).status,
    401,
  );
});

test("production OAuth cookies are Secure and callback URI uses the shared HTTPS origin", async (t) => {
  const publicOrigin = "https://console.example.com";
  const { url } = await serve(t, { publicOrigin });
  const begin = await fetch(`${url}/auth/feishu/login`, { redirect: "manual" });
  assert.equal(begin.status, 302);
  assert.match(begin.headers.get("set-cookie") ?? "", /; Secure/);
  const location = new URL(begin.headers.get("location")!);
  assert.equal(
    location.searchParams.get("redirect_uri"),
    `${publicOrigin}/auth/feishu/callback`,
  );
});

test("webhook receives a verified actor resolver wired to internal users", async (t) => {
  const { runtime, url, ownerUserId } = await serve(t);
  const original = runtime.channels.handle.bind(runtime.channels);
  let resolveActor:
    | ((identity: PlatformIdentity) => Promise<string | null>)
    | undefined;
  runtime.channels.handle = async (accountId, request, decisions, resolver) => {
    resolveActor = resolver;
    return original(accountId, request, decisions, resolver);
  };
  await fetch(`${url}/webhooks/account-a`, { method: "POST", body: "{}" });
  assert.ok(resolveActor);
  assert.equal(await resolveActor(ownerIdentity), ownerUserId);
  assert.equal(
    await resolveActor({ ...ownerIdentity, externalId: "ou-unknown" }),
    null,
  );
});

test("webhook choices are processed only when the actor maps to the session owner", async (t) => {
  const { runtime, url, headers, setWebhook } = await serve(t);
  const create = async (externalId: string) => {
    const response = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        ...startInput(),
        recipient: { accountId: "account-a", kind: "user", externalId },
        allowedActorIds: [externalId],
      }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).id as string;
  };
  const openAction = async (sessionId: string) => {
    await runtime.worker.runOnce();
    await runtime.worker.runOnce();
    const detail = await (
      await fetch(`${url}/api/sessions/${sessionId}`, { headers })
    ).json();
    return detail.actions[0] as { id: string };
  };
  const inboxFor = async (actionRef: string) =>
    runtime.storage.transaction(async (tx) =>
      (await tx.inbox.all()).find(
        (inbox) => inbox.command.actionRef === actionRef,
      ),
    );
  const process = async (actionRef: string) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const inbox = await inboxFor(actionRef);
      if (inbox && inbox.status !== "pending") return inbox;
      await runtime.worker.runOnce();
    }
    return inboxFor(actionRef);
  };

  const ownerSession = await create("ou-owner");
  const ownerAction = await openAction(ownerSession);
  setWebhook({ actorExternalId: "ou-owner", actionRef: ownerAction.id });
  assert.equal(
    (await fetch(`${url}/webhooks/account-a`, { method: "POST", body: "{}" })).status,
    200,
  );
  assert.equal((await process(ownerAction.id))?.status, "processed");

  const strangerSession = await create("ou-owner");
  const strangerAction = await openAction(strangerSession);
  setWebhook({ actorExternalId: "ou-stranger", actionRef: strangerAction.id });
  assert.equal(
    (await fetch(`${url}/webhooks/account-a`, { method: "POST", body: "{}" })).status,
    200,
  );
  const rejected = await process(strangerAction.id);
  assert.equal(rejected?.status, "rejected");
  assert.equal(rejected?.reason, "forbidden");
});

test("Feishu sessions accept only the current user's verified identity", async (t) => {
  const { url, headers } = await serve(t);
  const create = (overrides: Record<string, unknown>) =>
    fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ ...startInput(), ...overrides }),
    });
  assert.equal(
    (await create({ allowedActorIds: ["ou-someone-else"] })).status,
    400,
    "actor lists cannot include another user",
  );
  assert.equal(
    (
      await create({
        recipient: {
          accountId: "account-a",
          kind: "user",
          externalId: "ou-someone-else",
        },
      })
    ).status,
    400,
    "a user recipient must be the current user",
  );
  const group = await create({ recipient: { accountId: "account-a", kind: "group", externalId: "oc-unapproved" } });
  assert.equal(group.status, 400);
  assert.equal((await group.json()).error, "personal sessions require a user recipient");
  assert.equal((await create({})).status, 201);
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

for (const invalidation of ["binding", "user"] as const) {
  test(`queued platform choices recheck ${invalidation} before execution`, async (t) => {
    const { runtime, service, url, headers, ownerUserId, setWebhook } = await serve(t);
    const created = await fetch(`${url}/api/sessions`, {
      method: "POST", headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(startInput()),
    });
    assert.equal(created.status, 201);
    const session = await created.json();
    await runtime.worker.runOnce();
    await runtime.worker.runOnce();
    const action = await runtime.storage.transaction(async (tx) => (await tx.actions.all())[0]);
    setWebhook({ actorExternalId: "ou-owner", actionRef: action.id });
    assert.equal((await fetch(`${url}/webhooks/account-a`, { method: "POST", body: "{}" })).status, 200);
    if (invalidation === "binding") {
      const bindings = await runtime.storage.transaction((tx) => tx.identityBindings.all());
      const binding = bindings.find((binding) => binding.userId === ownerUserId)!;
      await service.revokeIdentity(binding.id, new Date().toISOString());
    } else {
      await runtime.storage.transaction(async (tx) => {
        const user = await tx.users.get(ownerUserId);
        assert.ok(user);
        await tx.users.put({ ...user, status: "disabled" });
      });
    }
    await runtime.worker.runOnce();
    const result = await runtime.storage.transaction(async (tx) => ({
      session: await tx.sessions.get(session.id), inbox: (await tx.inbox.all())[0],
    }));
    assert.equal(result.inbox.status, "rejected");
    assert.equal(result.inbox.reason, "forbidden");
    assert.equal(result.session?.version, 0);
  });
}

test("source leads API: 只返回本人已开启来源的线索，未开启来源与非法查询被拒", async (t) => {
  const s = await serve(t);
  await s.runtime.storage.transaction(async (tx) => {
    await tx.sourceItems.put({
      id: "weichai_news:1", sourceKey: "weichai_news", itemKey: "https://www.weichai.com/news/1.html",
      title: "潍柴列表标题", itemUrl: "https://www.weichai.com/news/1.html", publishedAt: "2026-11-15",
      firstSeenAt: "2026-11-16T00:01:00.000Z", lastSeenAt: "2026-11-16T00:01:00.000Z",
      titleUpdatedAt: null, contentScope: "title_link_only", status: "active",
    });
    await tx.sourceItems.put({
      id: "haier_news:1", sourceKey: "haier_news", itemKey: "https://www.haier.com/news/1.html",
      title: "海尔列表标题", itemUrl: "https://www.haier.com/news/1.html", publishedAt: null,
      firstSeenAt: "2026-11-16T00:02:00.000Z", lastSeenAt: "2026-11-16T00:02:00.000Z",
      titleUpdatedAt: null, contentScope: "title_link_only", status: "active",
    });
  });

  const before = await fetch(`${s.url}/api/me/source-leads`, { headers: s.headers });
  assert.equal(before.status, 200);
  const closed = (await before.json()) as { leads: unknown[]; sources: Array<{ key: string; enabled: boolean }> };
  assert.equal(closed.leads.length, 0, "默认不采集也不返回线索");
  assert.deepEqual(closed.sources.map((source) => source.key), ["weichai_news", "haier_news"]);
  assert.ok(closed.sources.every((source) => !source.enabled));

  const enable = await fetch(`${s.url}/api/me/subscription/settings`, {
    method: "PUT",
    headers: s.headers,
    body: JSON.stringify({ expectedVersion: 0, sourceFeeds: ["weichai_news"] }),
  });
  assert.equal(enable.status, 200);
  const view = (await enable.json()) as { sources: Array<{ key: string; enabled: boolean; subject: { name: string } }> };
  assert.equal(view.sources.find((source) => source.key === "weichai_news")?.enabled, true);
  assert.equal(view.sources.find((source) => source.key === "weichai_news")?.subject.name, "潍柴");

  const opened = (await (await fetch(`${s.url}/api/me/source-leads`, { headers: s.headers })).json()) as {
    leads: Array<{ title: string; sourceKey: string; subject: { name: string } }>;
  };
  assert.equal(opened.leads.length, 1);
  assert.equal(opened.leads[0]?.title, "潍柴列表标题");
  assert.equal(opened.leads[0]?.subject.name, "潍柴");

  const stranger = (await (await fetch(`${s.url}/api/me/source-leads`, { headers: s.strangerHeaders })).json()) as { leads: unknown[] };
  assert.equal(stranger.leads.length, 0, "别人的开关不影响本人，也看不到本人来源");

  assert.equal((await fetch(`${s.url}/api/me/source-leads?sourceKey=haier_news`, { headers: s.headers })).status, 400);
  assert.equal((await fetch(`${s.url}/api/me/source-leads?limit=51`, { headers: s.headers })).status, 400);
  assert.equal((await fetch(`${s.url}/api/me/source-leads?limit=1&limit=2`, { headers: s.headers })).status, 400);
  assert.equal((await fetch(`${s.url}/api/me/source-leads`)).status, 401);

  const unknownFeed = await fetch(`${s.url}/api/me/subscription/settings`, {
    method: "PUT",
    headers: s.headers,
    body: JSON.stringify({ expectedVersion: 1, sourceFeeds: ["unknown_feed"] }),
  });
  assert.equal(unknownFeed.status, 422, "未声明的来源 key 不静默忽略");
});

test("任务生命周期 API: 返回锚点与到期时刻，到期后任务按不可访问处理", async (t) => {
  const s = await serve(t);
  const created = await fetch(`${s.url}/api/tasks`, {
    method: "POST",
    headers: { ...s.headers, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ product: "生命周期任务", strategy: { objective: "咨询", audience: [], channels: {}, sellingPoints: [] }, observation: {}, rules: {} }),
  });
  assert.equal(created.status, 201);
  const task = (await created.json()) as { taskId: string };

  const lifecycle = await fetch(`${s.url}/api/tasks/${task.taskId}/lifecycle`, { headers: s.headers });
  assert.equal(lifecycle.status, 200);
  const body = (await lifecycle.json()) as { state: string; retentionDays: number; expiresAt: string; anchorSource: string; expired: boolean };
  assert.equal(body.state, "active");
  assert.equal(body.retentionDays, 365);
  assert.equal(body.expired, false);
  assert.ok(Date.parse(body.expiresAt) > Date.now());
  assert.equal(body.anchorSource, "last_business_update");

  assert.equal((await fetch(`${s.url}/api/tasks/${task.taskId}/lifecycle`, { headers: s.strangerHeaders })).status, 404, "不是本人的任务不暴露到期信息");
  assert.equal((await fetch(`${s.url}/api/tasks/${task.taskId}/lifecycle`)).status, 401);
});

test("任务删除 API: 幂等、跨用户不可删、删除后任务与判定查询均不可访问", async (t) => {
  const s = await serve(t);
  const created = await fetch(`${s.url}/api/tasks`, {
    method: "POST",
    headers: { ...s.headers, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ product: "待删除任务", strategy: { objective: "咨询", audience: [], channels: {}, sellingPoints: [] }, observation: {}, rules: {} }),
  });
  assert.equal(created.status, 201);
  const task = (await created.json()) as { taskId: string };

  assert.equal((await fetch(`${s.url}/api/tasks/${task.taskId}`, { method: "DELETE" })).status, 401);
  assert.equal((await fetch(`${s.url}/api/tasks/${task.taskId}`, { method: "DELETE", headers: s.strangerHeaders })).status, 404);

  const deleted = await fetch(`${s.url}/api/tasks/${task.taskId}`, { method: "DELETE", headers: s.headers });
  assert.equal(deleted.status, 200);
  const first = (await deleted.json()) as { created: boolean; manifest: { id: string; taskId: string; status: string } };
  assert.equal(first.created, true);
  assert.equal(first.manifest.taskId, task.taskId);
  assert.equal(first.manifest.status, "pending");

  const again = await fetch(`${s.url}/api/tasks/${task.taskId}`, { method: "DELETE", headers: s.headers });
  assert.equal(again.status, 200);
  const second = (await again.json()) as { created: boolean; manifest: { id: string } };
  assert.equal(second.created, false, "重复提交幂等");
  assert.equal(second.manifest.id, first.manifest.id);

  assert.equal((await fetch(`${s.url}/api/tasks/${task.taskId}`, { headers: s.headers })).status, 404, "删除后任务不可读");
  assert.equal((await fetch(`${s.url}/api/tasks/${task.taskId}/lifecycle`, { headers: s.headers })).status, 200);
  const lifecycle = (await (await fetch(`${s.url}/api/tasks/${task.taskId}/lifecycle`, { headers: s.headers })).json()) as { state: string; deletedAt: string | null };
  assert.equal(lifecycle.state, "deleted");
  assert.ok(lifecycle.deletedAt);
  const list = (await (await fetch(`${s.url}/api/tasks`, { headers: s.headers })).json()) as { items: unknown[] };
  assert.equal(list.items.length, 0, "已删除任务不出现在列表里");

  // 重建同名任务：新任务可用，旧任务仍然不可访问。
  const recreated = await fetch(`${s.url}/api/tasks`, {
    method: "POST",
    headers: { ...s.headers, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ product: "待删除任务", strategy: { objective: "咨询", audience: [], channels: {}, sellingPoints: [] }, observation: {}, rules: {} }),
  });
  assert.equal(recreated.status, 201);
  const fresh = (await recreated.json()) as { taskId: string };
  assert.notEqual(fresh.taskId, task.taskId);
  assert.equal((await fetch(`${s.url}/api/tasks/${fresh.taskId}`, { headers: s.headers })).status, 200);
  assert.equal((await fetch(`${s.url}/api/tasks/${task.taskId}`, { headers: s.headers })).status, 404);
});

test("删除清单状态 API: 只返回本人的删除进度，不含业务正文", async (t) => {
  const s = await serve(t);
  const created = await fetch(`${s.url}/api/tasks`, {
    method: "POST",
    headers: { ...s.headers, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ product: "待删任务", strategy: { objective: "咨询", audience: [], channels: {}, sellingPoints: [] }, observation: {}, rules: {} }),
  });
  const task = (await created.json()) as { taskId: string };
  assert.equal((await fetch(`${s.url}/api/tasks/${task.taskId}`, { method: "DELETE", headers: s.headers })).status, 200);

  const mine = await fetch(`${s.url}/api/me/lifecycle-deletions`, { headers: s.headers });
  assert.equal(mine.status, 200);
  const body = (await mine.json()) as { items: Array<Record<string, unknown>> };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]?.taskId, task.taskId);
  assert.equal(body.items[0]?.status, "pending");
  assert.equal(body.items[0]?.reason, "owner_request");
  assert.ok(!JSON.stringify(body).includes("待删任务"), "状态里不含任务正文");

  const stranger = (await (await fetch(`${s.url}/api/me/lifecycle-deletions`, { headers: s.strangerHeaders })).json()) as { items: unknown[] };
  assert.equal(stranger.items.length, 0, "跨用户看不到别人的删除状态");
  assert.equal((await fetch(`${s.url}/api/me/lifecycle-deletions`)).status, 401);
});

test("来源状态 API: 未开启来源时为空，开启后只返回本人来源的采集状态", async (t) => {
  const s = await serve(t);
  const empty = await fetch(`${s.url}/api/me/source-status`, { headers: s.headers });
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()) as { items: unknown[] }, { items: [] });
  assert.equal((await fetch(`${s.url}/api/me/source-status`)).status, 401);

  await fetch(`${s.url}/api/me/subscription/settings`, {
    method: "PUT",
    headers: s.headers,
    body: JSON.stringify({ expectedVersion: 0, sourceFeeds: ["weichai_news"] }),
  });
  const opened = (await (await fetch(`${s.url}/api/me/source-status`, { headers: s.headers })).json()) as {
    items: Array<{ key: string; status: string; activeItems: number }>;
  };
  assert.equal(opened.items.length, 1);
  assert.equal(opened.items[0]?.key, "weichai_news");
  assert.equal(opened.items[0]?.status, "active");
  assert.equal(opened.items[0]?.activeItems, 0);
});
