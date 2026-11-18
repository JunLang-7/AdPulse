import assert from "node:assert/strict";
import test from "node:test";
import {
	LifecycleCleanupService,
	LifecycleDeletionService,
	MarketEventService,
	NotificationRecordService,
	parseManifest,
	serializeManifest,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { eventInput, taskInput } from "./market-event-fixtures.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const clock = (iso: string) => {
	let at = iso;
	return { now: () => at, set: (next: string) => { at = next; } };
};

async function seed(at = T0) {
	const storage = new MemoryStorage();
	const time = clock(at);
	const service = new MarketEventService(storage, time.now);
	await storage.transaction(async (tx) => {
		await tx.tasks.put({ id: "task-1", ownerId: "owner", currentVersion: 1, createdAt: at });
		await tx.taskVersions.put({ id: "task-1:1", taskId: "task-1", ownerId: "owner", version: 1, input: taskInput as never, observation: { endsAt: null } as never, createdAt: at } as never);
	});
	const created = await service.create("owner", "key-1", {
		...eventInput(), taskRefs: [{ taskId: "task-1", taskVersion: 1, reason: "本人声明的任务关联" }],
	});
	return { storage, time, service, eventId: created.version.eventId, versionId: created.version.id };
}

test("事件清理：到期事件进清单并物理清理，head 骨架保留", async () => {
	const { storage, time, eventId, versionId } = await seed();
	// 到期：锚点 2026-01-01 + 365 天 = 2026-12-31 过后。
	time.set("2027-01-01T00:00:00.000Z");
	const cleanup = new LifecycleCleanupService(storage, time.now);
	const scheduled = await cleanup.runOnce();
	assert.equal((scheduled.removed.marketEventVersions ?? 0), 1, "版本被物理清理");
	assert.equal((scheduled.removed.marketEventAliases ?? 0) >= 1, true, "别名被清理");
	assert.equal((scheduled.removed.marketEventOperations ?? 0), 1, "操作幂等记录被清理");

	// head 保留骨架：生命周期仍可解释，记录页脱敏仍生效。
	const head = await storage.transaction((tx) => tx.marketEvents.get(eventId));
	assert.ok(head, "head 骨架保留");
	assert.equal(await storage.transaction((tx) => tx.marketEventVersions.get(versionId)), null, "正文版本已删");
	const lifecycle = await new MarketEventService(storage, time.now).lifecycle("owner", eventId);
	assert.equal(lifecycle?.state, "expired");
	assert.equal(lifecycle?.expired, true);

	// 清单已 cleaned；审计 event_deleted（到期）+ event_purged（清理）。
	const manifests = await storage.transaction((tx) => tx.lifecycleDeletions.all());
	const manifest = manifests.find((row) => row.marketEventId === eventId);
	assert.equal(manifest?.status, "cleaned");
	assert.equal(manifest?.reason, "retention_expired");
	const audits = await storage.transaction((tx) => tx.auditEvents.all());
	assert.ok(audits.some((row) => row.kind === "event_purged" && row.objectId === eventId));
	assert.ok(audits.some((row) => row.kind === "event_deleted" && row.objectId === eventId));
});

test("事件清理：本人删除的清单到期清理，取消的条目与筛选记录一并删除", async () => {
	const { storage, time, eventId } = await seed(T0);
	const service = new MarketEventService(storage, time.now);
	// 造一条引用该事件的待发条目与筛选记录。
	await storage.transaction(async (tx) => {
		await tx.notificationItems.put({
			id: `${"owner"}:event:${eventId}`, ownerId: "owner", batchId: "batch-1", logicalKey: `event:${eventId}`,
			kind: "market_event", marketEventRef: { eventId, version: 1, evidenceRevision: 1 },
			title: "待发条目", summary: "s", relevance: "r", sources: [], revision: 1, status: "cancelled",
			createdAt: T0, updatedAt: T0,
		} as never);
		await tx.notificationSelections.put({
			id: `sel:${eventId}`, ownerId: "owner", input: "event",
			marketEventRef: { eventId, version: 1, evidenceRevision: 1 }, revision: 1, settingsVersion: 1,
			matchedTargetIds: [], outcome: "not_queued", reason: "matched", evaluatedAt: T0,
		} as never);
	});
	await service.delete("owner", eventId, 1);
	time.set("2027-01-09T00:00:00.000Z"); // 删除清单 7 天截止之后
	const cleanup = new LifecycleCleanupService(storage, time.now);
	const result = await cleanup.runOnce();
	assert.equal((result.removed.marketEventVersions ?? 0), 1);
	assert.equal((result.removed.notificationItems ?? 0), 1, "该事件的条目被删");
	// 删除事务本身也会写一条筛选记录（S2），加上我们造的一条共两条；都按事件清理。
	assert.equal((result.removed.notificationSelections ?? 0), 2, "该事件的筛选记录都被删");

	// head 获得删除标记；记录页脱敏按 head 判定仍生效。
	const head = await storage.transaction((tx) => tx.marketEvents.get(eventId));
	assert.ok(head?.deletion);
});

test("事件清理：清理后通知记录不再回显该事件内容（脱敏靠 head 骨架）", async () => {
	const { storage, time, eventId } = await seed();
	// 已发送批次 + 冻结卡片条目带 marketEventRef。
	await storage.transaction(async (tx) => {
		await tx.notificationBatches.put({ id: "batch-1", ownerId: "owner", kind: "digest", localDate: "2026-01-01", status: "sent", settingsVersion: 1, scheduledAt: T0, createdAt: T0, updatedAt: T0 } as never);
		await tx.deliveries.put({
			id: "digest:batch-1", ownerId: "owner", batchId: "batch-1", purpose: "digest", status: "sent",
			card: { title: "信息汇总", items: [{ title: "测试品牌新品发布", summary: "s", relevance: "r", sources: [], marketEventRef: { eventId, version: 1, evidenceRevision: 1 } }] },
			expiresAt: T0, sentAt: T0,
		} as never);
	});
	await new MarketEventService(storage, time.now).delete("owner", eventId, 1);
	time.set("2027-01-09T00:00:00.000Z");
	await new LifecycleCleanupService(storage, time.now).runOnce();

	const page = await new NotificationRecordService(storage, time.now).list("owner");
	const item = page.records[0]?.items[0];
	assert.equal(item?.inputExpired, true, "物理清理后脱敏仍生效（head 骨架在）");
	assert.equal(item?.inputRemoved, "deleted");
	assert.equal(item?.title, "已删除的事件");
});

test("事件清单外置：序列化/解析往返，两者恰有一校验", async () => {
	const { storage, time, eventId } = await seed();
	await new MarketEventService(storage, time.now).delete("owner", eventId, 1);
	const rows = await storage.transaction((tx) => tx.lifecycleDeletions.all());
	const text = serializeManifest(rows.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)));
	const parsed = parseManifest(text);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0]?.marketEventId, eventId);
	assert.equal(parsed[0]?.taskId, undefined);

	// 坏行直接报错：都缺或都有。
	assert.throws(() => parseManifest(JSON.stringify({ id: "x", ownerId: "o", requestedAt: T0, deadlineAt: T0 }) + "\n"));
	assert.throws(() => parseManifest(JSON.stringify({ id: "x", ownerId: "o", taskId: "t", marketEventId: "e", requestedAt: T0, deadlineAt: T0 }) + "\n"));
});

test("事件清单重放：恢复出的备份立即限访并取消待发，幂等保留", async () => {
	// 模拟恢复：新库里事件存在但没有删除状态；重放外置清单后立即不可读。
	const { storage, time, eventId } = await seed();
	const deletion = new LifecycleDeletionService(storage, time.now);
	const manifest = (await new MarketEventService(storage, time.now).delete("owner", eventId, 1)).manifest;
	// 待发条目（模拟恢复后残留）。
	await storage.transaction(async (tx) => {
		await tx.notificationItems.put({
			id: `owner:event:${eventId}`, ownerId: "owner", batchId: "batch-1", logicalKey: `event:${eventId}`,
			kind: "market_event", marketEventRef: { eventId, version: 1, evidenceRevision: 1 },
			title: "待发", summary: "s", relevance: "r", sources: [], revision: 1, status: "queued",
			createdAt: T0, updatedAt: T0,
		} as never);
	});

	// 从外置清单构造重放条目（不带库内状态）。
	const entry = parseManifest(serializeManifest([manifest]))[0]!;
	// 恢复场景：清掉 head 的删除标记与库内清单，模拟旧备份。
	await storage.transaction(async (tx) => {
		const head = await tx.marketEvents.get(eventId);
		if (head) { const { deletion: _d, ...rest } = head; await tx.marketEvents.put(rest); }
		await tx.lifecycleDeletions.remove([manifest.id]);
	});

	const { status: _s, cleanedAt: _c, ...plain } = entry;
	const replayed = await deletion.replay([plain]);
	assert.equal(replayed.inserted, 1);
	const head = await storage.transaction((tx) => tx.marketEvents.get(eventId));
	assert.ok(head?.deletion, "重放即限访：head 获得删除标记");
	assert.equal(await new MarketEventService(storage, time.now).detail("owner", eventId), null);
	const item = await storage.transaction((tx) => tx.notificationItems.get(`owner:event:${eventId}`));
	assert.equal(item?.status, "cancelled", "恢复出的待发条目立即取消");

	const again = await deletion.replay([plain]);
	assert.equal(again.inserted, 0, "重复重放不重复插入");
	assert.equal(again.kept, 1);
});

test("事件清理回归：任务清单清理不受事件清单影响", async () => {
	const { storage, time, eventId } = await seed();
	const taskManifest = (await new LifecycleDeletionService(storage, time.now)
		.requestDelete("owner", "task-1")).manifest;
	await new MarketEventService(storage, time.now).delete("owner", eventId, 1);
	time.set("2027-01-09T00:00:00.000Z");
	const result = await new LifecycleCleanupService(storage, time.now).runOnce();
	assert.ok((result.removed.tasks ?? 0) + (result.removed.marketEventVersions ?? 0) >= 2, "任务与事件都清理");
	assert.equal(taskManifest.taskId, "task-1");
});
