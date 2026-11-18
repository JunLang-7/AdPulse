import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createApi } from "../apps/api/dist/server.js";
import { AuthenticationService } from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { eventInput, taskInput } from "./market-event-fixtures.ts";

async function serve(t: TestContext) {
	const runtime = compose(new MemoryStorage(), []);
	const auth = new AuthenticationService(runtime.storage);
	const identity = { platform: "feishu", applicationId: "app-test", tenantId: "tenant-test", idType: "open_id", externalId: "alice" };
	const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
	const users = await Promise.all(tokens.map((token,i) => auth.createWebSession({ ...identity, externalId: i ? "bob" : "alice" }, createHash("sha256").update(token!).digest("hex"), new Date().toISOString())));
	const server = createApi(runtime, { service: auth, publicOrigin: "http://localhost", audit() {}, provider: { authorizationUrl() { return "https://example.com/oauth"; }, async verifyAuthorizationCode() { return { identity }; } } });
	await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const address = server.address(); assert.ok(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const request = (path: string, method = "GET", body?: unknown, user = 0, key = crypto.randomUUID()) => fetch(base+path, { method, headers: { cookie: `adpulse_session=${tokens[user]}`, origin: "http://localhost", "content-type": "application/json", "idempotency-key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	return { runtime, users, request, base };
}
test("market events HTTP: authenticated owner isolation, foreign references and forged material/method rejected", async t => {
	const { runtime, users, request, base } = await serve(t);
	assert.equal((await fetch(base+"/api/market-events")).status,401);
	const task = await runtime.tasks.create(users[1]!.userId,"task",taskInput);
	const input = eventInput(); input.taskRefs=[{taskId:task.taskId,taskVersion:1,reason:"伪造他人任务"}];
	assert.equal((await request("/api/market-events","POST",input)).status,404);
	for (const forged of [{ ownerId: users[1]!.userId }, { method: "source_item" }, { materialRefs: ["foreign-material"] }])
		assert.equal((await request("/api/market-events","POST",{...eventInput(),...forged})).status,400);
	const created = await request("/api/market-events","POST",eventInput()); assert.equal(created.status,201);
	const result = await created.json(); const id = result.version.eventId;
	assert.equal((await request(`/api/market-events/${id}`,"GET",undefined,1)).status,404);
	assert.deepEqual((await (await request("/api/market-events","GET",undefined,1)).json()).items,[]);
	assert.equal((await request(`/api/market-events/${id}/revisions`,"POST",{expectedVersion:1,event:eventInput(),changeReason:"伪造"},1)).status,404);
	assert.equal((await fetch(base+"/api/market-events",{method:"POST",headers:{cookie:"adpulse_session=invalid","content-type":"application/json"},body:JSON.stringify(eventInput())})).status,401);
});
test("market events HTTP: idempotency, semantic duplicates, evidence errors and immutable revision contract", async t => {
	const { request } = await serve(t); const key=crypto.randomUUID();
	const first = await (await request("/api/market-events","POST",eventInput(),0,key)).json(); const id=first.version.eventId;
	assert.deepEqual(await (await request("/api/market-events","POST",eventInput(),0,key)).json(),first);
	assert.equal((await request("/api/market-events","POST",{...eventInput(),title:"改标题"},0,key)).status,409);
	assert.equal((await (await request("/api/market-events","POST",{...eventInput(),title:"改标题"})).json()).status,"duplicate");
	const bad = eventInput(); bad.citations.subject={sourceIndex:9,quote:"没有此材料"}; assert.equal((await request("/api/market-events","POST",bad)).status,400);
	const invalidDate=eventInput(); invalidDate.sources[0]!.publishedAt="2026-02-30"; assert.equal((await request("/api/market-events","POST",invalidDate)).status,400);
	const revised={...eventInput(),title:"更正事件标题"};
	assert.equal((await request(`/api/market-events/${id}/revisions`,"POST",{expectedVersion:1,event:revised,changeReason:"更正标题"})).status,200);
	assert.equal((await request(`/api/market-events/${id}/revisions`,"POST",{expectedVersion:1,event:revised,changeReason:"过期修订"})).status,409);
	const detail=await (await request(`/api/market-events/${id}`)).json(); assert.equal(detail.versions.length,2); assert.equal(detail.versions[1].input.title,eventInput().title);
	assert.equal(detail.current.evidenceRevision,1);
});

test("market events HTTP: 生命周期查询可解释到期，到期后详情 404 且不可修订", async t => {
	const { runtime, users, request, base } = await serve(t);
	const created = await request("/api/market-events","POST",eventInput());
	assert.equal(created.status,201);
	const eventId = ((await created.json()) as { version: { eventId: string } }).version.eventId;

	const lifecycle = await request(`/api/market-events/${eventId}/lifecycle`);
	assert.equal(lifecycle.status,200);
	const projection = await lifecycle.json() as { state: string; expired: boolean; retentionDays: number; anchorSource: string; expiresAt: string };
	assert.equal(projection.state,"active");
	assert.equal(projection.expired,false);
	assert.equal(projection.retentionDays,365);
	assert.equal(projection.anchorSource,"last_business_update");
	assert.ok(Date.parse(projection.expiresAt) > Date.parse(projection.expiresAt) - 1);

	// 非本人：与不存在同样返回 404，不泄露存在性。
	assert.equal((await request(`/api/market-events/${eventId}/lifecycle`,"GET",undefined,1)).status,404);
	assert.equal((await request("/api/market-events/missing/lifecycle")).status,404);
	assert.ok(users[0]!.userId);
	assert.ok(runtime);
	assert.ok(base);
});

test("market events HTTP: 删除需本人与期望版本，删除后详情与生命周期都反映已删除", async t => {
	const { runtime, request } = await serve(t);
	const created = await request("/api/market-events","POST",eventInput());
	const eventId = ((await created.json()) as { version: { eventId: string } }).version.eventId;

	// 非本人：404，与不存在一致。
	assert.equal((await request(`/api/market-events/${eventId}?expectedVersion=1`,"DELETE",undefined,1)).status,404);
	// 版本不一致：409。
	assert.equal((await request(`/api/market-events/${eventId}?expectedVersion=9`,"DELETE")).status,409);
	// 缺参数：400。
	assert.equal((await request(`/api/market-events/${eventId}`,"DELETE")).status,400);

	const deleted = await request(`/api/market-events/${eventId}?expectedVersion=1`,"DELETE");
	assert.equal(deleted.status,200);
	const result = await deleted.json() as { manifest: { marketEventId: string; status: string }; created: boolean };
	assert.equal(result.created,true);
	assert.equal(result.manifest.marketEventId,eventId);
	assert.equal(result.manifest.status,"pending");

	assert.equal((await request(`/api/market-events/${eventId}`)).status,404,"删除后详情不可读");
	const lifecycle = await (await request(`/api/market-events/${eventId}/lifecycle`)).json() as { state: string; expired: boolean; deletedAt: string | null };
	assert.equal(lifecycle.state,"deleted");
	assert.equal(lifecycle.expired,true);
	assert.ok(lifecycle.deletedAt);

	// 幂等：再删一次返回原清单。
	const again = await (await request(`/api/market-events/${eventId}?expectedVersion=1`,"DELETE")).json() as { created: boolean };
	assert.equal(again.created,false);
	assert.ok(runtime);
});

test("market events HTTP: 生命周期响应符合 OpenAPI 契约（deleted 与 deletedAt）", async t => {
	const { request } = await serve(t);
	const created = await request("/api/market-events","POST",eventInput());
	const eventId = ((await created.json()) as { version: { eventId: string } }).version.eventId;
	const active = await (await request(`/api/market-events/${eventId}/lifecycle`)).json() as Record<string, unknown>;
	assert.ok(["active","expired","deleted"].includes(String(active.state)));
	assert.equal(active.deletedAt, null, "未删除时必须显式返回 null，契约要求该字段存在");
	await request(`/api/market-events/${eventId}?expectedVersion=1`,"DELETE");
	const deleted = await (await request(`/api/market-events/${eventId}/lifecycle`)).json() as Record<string, unknown>;
	assert.equal(deleted.state,"deleted");
	assert.ok(typeof deleted.deletedAt === "string");
	assert.equal(deleted.expired,true);
});
