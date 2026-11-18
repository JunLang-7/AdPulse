import assert from "node:assert/strict";
import test from "node:test";
import { MarketEventService, cleanTaskReferencesIn } from "../packages/core/dist/index.js";
import { LifecycleDeletionService } from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { eventInput, taskInput } from "./market-event-fixtures.ts";

const now = () => "2026-11-17T10:00:00.000Z";

async function seed() {
	const storage = new MemoryStorage();
	const service = new MarketEventService(storage, now);
	// 两个任务都真实存在（事件录入会校验 taskRefs 指向本人任务与版本）。
	await storage.transaction(async (tx) => {
		for (const [taskId, version] of [["task-1", 1], ["task-2", 1]] as const) {
			await tx.tasks.put({ id: taskId, ownerId: "owner", currentVersion: version, createdAt: now() });
			await tx.taskVersions.put({ id: `${taskId}:${version}`, taskId, ownerId: "owner", version, input: taskInput as never, createdAt: now() } as never);
		}
	});
	const input = { ...eventInput(), taskRefs: [{ taskId: "task-1", taskVersion: 1, reason: "本人声明的任务关联" }] };
	const created = await service.create("owner", "key-1", input);
	const another = {
		...eventInput(), occurrenceKey: "other-key",
		// 同 URL 会被判定为同一事件（语义重复）；这里换一条来源，才是独立事件。
		sources: [{ ...eventInput().sources[0]!, url: "https://example.com/releases/2" }],
		taskRefs: [{ taskId: "task-2", taskVersion: 1, reason: "另一个任务" }],
	};
	await service.create("owner", "key-2", another);
	return { storage, service, taskId: "task-1", eventId: created.version.eventId };
}

test("任务删除引用清理：清掉该任务的 taskRefs，保留事件与其他任务的关联", async () => {
	const { storage, taskId, eventId } = await seed();
	let sessionsCleaned = 0;
	await storage.transaction(async (tx) => {
		await tx.sessions.put({ id: "session-1", ownerId: "owner", taskRef: { taskId, taskVersion: 1 }, allowedActorIds: [], strategy: {} as never, limits: {} as never } as never);
		const result = await cleanTaskReferencesIn(tx, "owner", taskId, now(), "audit-key-1");
		assert.equal(result.events, 1, "只有一个事件引用了该任务");
		sessionsCleaned = result.sessions;
	});
	assert.equal(sessionsCleaned, 1);

	// 事件仍在且可读；该任务的引用消失，另一任务的关联保留。
	const detail = await new MarketEventService(storage, now).detail("owner", eventId);
	assert.ok(detail, "事件本体保留");
	assert.equal(detail.current.input.taskRefs.length, 0, "该任务的引用被清掉");

	const other = (await new MarketEventService(storage, now).list("owner"))
		.find((v) => v.input.taskRefs.some((ref) => ref.taskId === "task-2"));
	assert.ok(other, "其他任务的关联不受影响");

	// 会话指针按设计在任务物理清理时随会话一起消失（清理定位依赖它）；删除阶段只计数。
	const session = await storage.transaction((tx) => tx.sessions.get("session-1"));
	assert.ok(session, "会话本体保留");
	assert.ok(session.taskRef, "删除阶段保留指针，供物理清理定位无 ownerId 的投递");

	// 审计记录了清理。
	const audits = await storage.transaction((tx) => tx.auditEvents.all());
	assert.ok(audits.some((row) => row.kind === "task_refs_cleaned" && row.objectId === taskId));
});

test("任务删除引用清理：不推进事件版本与 evidenceRevision，避免触发通知", async () => {
	const { storage, taskId, eventId } = await seed();
	const before = await new MarketEventService(storage, now).detail("owner", eventId);
	assert.ok(before);
	await storage.transaction((tx) => cleanTaskReferencesIn(tx, "owner", taskId, now(), "audit-key-2"));
	const after = await new MarketEventService(storage, now).detail("owner", eventId);
	assert.ok(after);
	assert.equal(after.current.version, before.current.version, "不写新版本");
	assert.equal(after.current.evidenceRevision, before.current.evidenceRevision, "证据版本不变");
	assert.equal(after.versions.length, before.versions.length, "历史版本不多不少");
});

test("任务删除引用清理：幂等，重复执行不重复审计", async () => {
	const { storage, taskId } = await seed();
	const at = now();
	await storage.transaction((tx) => cleanTaskReferencesIn(tx, "owner", taskId, at, "audit-key-3"));
	await storage.transaction((tx) => cleanTaskReferencesIn(tx, "owner", taskId, at, "audit-key-3"));
	const audits = await storage.transaction((tx) => tx.auditEvents.all());
	assert.equal(audits.filter((row) => row.kind === "task_refs_cleaned").length, 1, "同 key 只留一条审计");
	// 第二次执行已无引用可清：审计 id 相同，覆盖写入而非新增。
});

test("任务删除（LifecycleDeletionService）在同一事务里清理事件与会话引用", async () => {
	const { storage, taskId, eventId } = await seed();
	await storage.transaction(async (tx) => {
		await tx.sessions.put({ id: "session-1", ownerId: "owner", taskRef: { taskId, taskVersion: 1 }, allowedActorIds: [], strategy: {} as never, limits: {} as never } as never);
	});
	// requestDelete 走完整事务（seed 已建好任务与版本）。
	const service = new LifecycleDeletionService(storage, now);
	const result = await service.requestDelete("owner", taskId);
	assert.equal(result.created, true);

	const detail = await new MarketEventService(storage, now).detail("owner", eventId);
	assert.ok(detail);
	assert.equal(detail.current.input.taskRefs.length, 0, "删除任务的同事务里清掉了事件引用");
	const session = await storage.transaction((tx) => tx.sessions.get("session-1"));
	assert.ok(session?.taskRef, "会话指针保留到物理清理（清理靠它定位无 ownerId 的投递）");
});

test("任务删除引用清理：只清自己的引用，别的用户的事件不受影响", async () => {
	const { storage, taskId } = await seed();
	// 另一用户的事件引用同一个 taskId 字符串（实际不可能指向他人，这里只验证边界）。
	const otherService = new MarketEventService(storage, now);
	await storage.transaction(async (tx) => {
		await tx.marketEvents.put({ id: "event-other", ownerId: "other", logicalKey: "lo", currentVersion: 1, createdAt: now() });
		await tx.marketEventVersions.put({ id: "event-other:1", eventId: "event-other", ownerId: "other", version: 1, evidenceRevision: 1, input: { ...eventInput(), taskRefs: [{ taskId, taskVersion: 1, reason: "他人事件" }] } as never, method: "manual", sourceItemId: null, materials: [], createdAt: now(), changeReason: "x", candidate: { status: "insufficient", reasons: [] } });
	});
	await storage.transaction((tx) => cleanTaskReferencesIn(tx, "owner", taskId, now(), "audit-key-5"));
	const otherVersion = await storage.transaction((tx) => tx.marketEventVersions.get("event-other:1"));
	assert.equal(otherVersion?.input.taskRefs.length, 1, "他人事件不在清理范围");
	assert.ok(otherService);
});
