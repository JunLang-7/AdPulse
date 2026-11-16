import assert from "node:assert/strict";
import test from "node:test";
import { DigestScheduler, Worker, NotificationQueue, NotificationSelectionService, matchEffectTargets, type Storage } from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage, PostgresStorage } from "../packages/storage/dist/index.js";
import { selectionEvidence, selectionFixture } from "./selection-helpers.ts";

test("筛选生产者：领域告警原子入队，重复操作不改写历史，新证据提升 revision", async () => {
	const f = await selectionFixture(new MemoryStorage());
	const alert = await f.evaluate(); assert.ok(alert);
	const service = new NotificationSelectionService(f.storage);
	let page = await service.list(f.owner);
	assert.equal(page.records.length, 1);
	assert.equal(page.records[0].outcome, "queued");
	const original = structuredClone(page.records[0]);
	assert.equal(original.deliveryResult?.status, "queued");
	let items = await new NotificationQueue(f.storage).pending(f.owner);
	assert.equal(items.length, 1);
	assert.match(items[0].title, /模拟/);
	assert.match(items[0].summary, /不作跨期上涨结论/);
	assert.equal(items[0].effectRef?.alertId, alert.id);
	assert.ok(!JSON.stringify(original).includes("产品 A"), "最小筛选记录不复制业务原文");
	await f.evaluate();
	assert.deepEqual((await service.list(f.owner)).records, [original]);
	const duplicate = await f.compare();
	await f.alerts.evaluateComparison(f.owner, duplicate.id);
	page = await service.list(f.owner);
	assert.deepEqual(page.records.map((r) => r.outcome).sort(), ["duplicate", "queued"]);
	assert.equal((await new NotificationQueue(f.storage).pending(f.owner)).length, 1);
	assert.equal(original.input, "effect");
	const evidenceRef = original.evidenceRef; assert.ok(evidenceRef);
	// 早于事件阶段写入的历史记录没有 input 字段：查询时按效果告警返回，不伪造其他类别。
	const legacy = structuredClone(original) as unknown as Record<string, unknown>;
	legacy.id = "legacy-effect-record"; legacy.ownerId = f.owner; delete legacy.input;
	delete legacy.deliveryResult;
	await f.storage.transaction(async (tx) => {
		await tx.notificationSelections.put(legacy as unknown as Parameters<typeof tx.notificationSelections.put>[0]);
	});
	assert.equal((await service.list(f.owner)).records.find((record) => record.id === "legacy-effect-record")?.input, "effect");
	await f.storage.transaction((tx) => tx.notificationSelections.delete("legacy-effect-record"));
	f.setTime("2026-11-16T00:02:00.000Z");
	await f.evidence.revise(f.owner, evidenceRef.evidenceId, "revise", {
		expectedEvidenceVersion: 1, reason: "合成实质修订", record: selectionEvidence(2100),
	});
	const revised = await f.compare(2);
	await f.alerts.evaluateComparison(f.owner, revised.id);
	items = await new NotificationQueue(f.storage).pending(f.owner);
	assert.equal(items.length, 1); assert.equal(items[0].revision, 2);
	assert.match(items[0].summary, /新增或修订证据/);
	const { deliveryResult: _oldResult, ...originalSelection } = original;
	assert.deepEqual((await service.list(f.owner)).records.find((r) => r.id === original.id), originalSelection);
});

test("排查结果仅关联本人的同一提醒版本，并区分同批已发送与已取消的条目", async () => {
	const f = await selectionFixture(new MemoryStorage());
	await f.evaluate();
	const service = new NotificationSelectionService(f.storage);
	const update = async (status: "sent" | "cancelled" | "failed" | "queued", sameOwner = true) => {
		await f.storage.transaction(async (tx) => {
			const [item] = await tx.notificationItems.all();
			assert.ok(item);
			const batch = await tx.notificationBatches.get(item.batchId);
			assert.ok(batch);
			await tx.notificationItems.put({ ...item, status: status === "failed" ? "cancelled" : status });
			await tx.notificationBatches.put({
				...batch, ownerId: sameOwner ? f.owner : "other", status: status === "failed" ? "failed" : "sent",
				...(status === "failed" ? { statusReason: "recipient_unreachable" } : { sentAt: "2026-11-16T01:30:00.000Z" }),
			});
		});
	};

	await update("sent");
	assert.equal((await service.list(f.owner)).records[0]?.deliveryResult?.sentAt, "2026-11-16T01:30:00.000Z");
	await update("cancelled");
	assert.equal((await service.list(f.owner)).records[0]?.deliveryResult?.status, "cancelled");
	await update("failed");
	assert.equal((await service.list(f.owner)).records[0]?.deliveryResult?.statusReason, "recipient_unreachable");
	await update("queued");
	assert.equal((await service.list(f.owner)).records[0]?.deliveryResult, undefined);
	await update("sent", false);
	assert.equal((await service.list(f.owner)).records[0]?.deliveryResult, undefined);
});

test("筛选：显式任务关联才命中，名称/域名不能替代；关闭、退订、类别和授权有历史原因", async () => {
	for (const [variant, expected] of [["name_only", "no_target"], ["disabled", "push_disabled"], ["muted", "target_muted"], ["category", "category_excluded"], ["consent", "not_authorized"]] as const) {
		const f = await selectionFixture(new MemoryStorage());
		await f.storage.transaction(async (tx) => {
			const setting = await tx.subscriptionSettings.get(f.owner); assert.ok(setting);
			const targets = await tx.subscriptionTargets.all();
			const target = targets[0];
			if (variant === "disabled") await tx.subscriptionSettings.put({ ...setting, proactiveEnabled: false });
			if (variant === "muted") await tx.subscriptionTargets.put({ ...target, status: "muted" });
			if (variant === "category") await tx.subscriptionTargets.put({ ...target, categories: ["event", "evidence"] });
			if (variant === "name_only") await tx.subscriptionTargets.put({ ...target, kind: "brand", refId: "【模拟】产品 a", sourceUrl: "https://example.com" });
			if (variant === "consent") await tx.notificationConsents.delete(`${f.owner}:${f.destination.id}`);
		});
		await f.evaluate();
		const record = (await new NotificationSelectionService(f.storage).list(f.owner)).records[0];
		assert.equal(record.reason, expected, variant); assert.equal(record.outcome, "not_queued");
		assert.equal((await new NotificationQueue(f.storage).pending(f.owner)).length, 0);
		// 后来配置开启、恢复或补全，也不能改写原判断或补发原事件。
		const original = structuredClone(record);
		await f.storage.transaction(async (tx) => {
			const setting = await tx.subscriptionSettings.get(f.owner); assert.ok(setting);
			await tx.subscriptionSettings.put({ ...setting, proactiveEnabled: true, version: setting.version + 1 });
		});
		await f.evaluate();
		assert.deepEqual((await new NotificationSelectionService(f.storage).list(f.owner)).records[0], original);
	}
});

test("匹配与查询：多项命中汇总、范围、本人隔离、稳定分页、日期边界与资源失访", async () => {
	const f = await selectionFixture(new MemoryStorage());
	await f.evaluate();
	const targets = await f.storage.transaction((tx) => tx.subscriptionTargets.all());
	assert.equal(matchEffectTargets([...targets, { ...targets[0], id: "another", scope: "include_general" }, { ...targets[0], id: "other-owner", userId: "other" }], f.owner, f.task.taskId).length, 2);
	const duplicate = await f.compare(); await f.alerts.evaluateComparison(f.owner, duplicate.id);
	const service = new NotificationSelectionService(f.storage);
	const page = await service.list(f.owner, { limit: 1, dateFrom: "2026-11-16", dateTo: "2026-11-16" });
	assert.ok(page.nextBefore);
	const second = await service.list(f.owner, { limit: 1, before: page.nextBefore });
	assert.equal(second.records.length, 1); assert.notEqual(page.records[0].id, second.records[0].id);
	assert.equal((await service.list(f.owner, { outcome: "duplicate" })).records.length, 1);
	assert.equal((await service.list("other")).records.length, 0);
	assert.equal((await service.list(f.owner, { taskId: "other-task" })).records.length, 0);
	for (const query of [{ limit: 0 }, { limit: 51 }, { dateFrom: "2026-02-30" }, { dateFrom: "2026-11-17", dateTo: "2026-11-16" }, { before: "wrong" }, { outcome: "sent" }])
		await assert.rejects(service.list(f.owner, query));
	await f.storage.transaction((tx) => tx.tasks.delete(f.task.taskId));
	assert.equal((await service.list(f.owner)).records.length, 0, "对象删除后历史引用也不公开");
});

test("生产者：事务失败整体回滚，崩溃重试不漏入队", async () => {
	const base = new MemoryStorage(); let fail = false;
	const storage: Storage = {
		transaction: (work) => base.transaction((tx) => work({ ...tx, notificationSelections: {
			...tx.notificationSelections, put: async (record) => { if (fail) throw new Error("injected selection failure"); await tx.notificationSelections.put(record); },
		} })), claimJob: base.claimJob.bind(base), runExclusive: base.runExclusive.bind(base),
	};
	const f = await selectionFixture(storage); fail = true;
	await assert.rejects(f.evaluate(), /injected selection failure/);
	assert.deepEqual(await base.transaction(async (tx) => [await tx.investigationAlerts.all(), await tx.notificationItems.all(), await tx.notificationSelections.all()]), [[], [], []]);
	fail = false; await f.evaluate();
	assert.equal((await new NotificationSelectionService(storage).list(f.owner)).records[0].outcome, "queued");
});

test("生产者：旧批次按旧设置取消，新输入进入新批次；取消不复活", async () => {
	const f = await selectionFixture(new MemoryStorage()); await f.evaluate();
	const queue = new NotificationQueue(f.storage, () => new Date(f.clock()));
	await f.storage.transaction(async (tx) => {
		const settings = await tx.subscriptionSettings.get(f.owner); assert.ok(settings);
		await tx.subscriptionSettings.put({ ...settings, version: settings.version + 1 });
	});
	await queue.queue(f.owner, { logicalKey: "new-independent", kind: "effect_alert", title: "新内容", summary: "新内容", relevance: "合成", sources: [{ label: "合成" }], revision: 1 }, { settingsVersion: 3, enabled: true });
	const items = await f.storage.transaction((tx) => tx.notificationItems.all());
	assert.equal(items.find((item) => item.logicalKey.startsWith("effect:"))?.status, "cancelled");
	assert.ok(items.find((item) => item.logicalKey === "new-independent")?.batchId.endsWith("2026-11-17"));
	await f.evaluate();
	assert.equal((await queue.pending(f.owner)).length, 1);
});

test("PostgreSQL：生产告警并发幂等、历史记录持久化与用户隔离", { skip: !process.env.TEST_DATABASE_URL }, async () => {
	const storage = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	const reconnected = PostgresStorage.connect(process.env.TEST_DATABASE_URL!);
	try {
		await storage.initialize();
		const f = await selectionFixture(storage);
		await Promise.all([f.evaluate(), f.evaluate()]);
		const service = new NotificationSelectionService(reconnected);
		assert.equal((await service.list(f.owner)).records.length, 1);
		assert.equal((await new NotificationQueue(reconnected).pending(f.owner)).length, 1);
		const other = await selectionFixture(reconnected); await other.evaluate();
		assert.equal((await service.list(other.owner)).records.length, 1);
		assert.ok(!(JSON.stringify(await service.list(f.owner))).includes(other.owner));
		await assert.rejects(storage.transaction(async (tx) => {
			const record = (await tx.notificationSelections.all()).find((r) => r.ownerId === f.owner); assert.ok(record);
			await tx.notificationSelections.put({ ...record, id: "different-id" });
		}), /duplicate key/);
		let fail = true;
		const failing: Storage = {
			transaction: (work) => storage.transaction((tx) => work({ ...tx, notificationSelections: {
				...tx.notificationSelections, put: async (record) => { if (fail) throw new Error("injected PostgreSQL failure"); await tx.notificationSelections.put(record); },
			} })), claimJob: storage.claimJob.bind(storage), runExclusive: storage.runExclusive.bind(storage),
		};
		const recovery = await selectionFixture(failing);
		await assert.rejects(recovery.evaluate(), /injected PostgreSQL failure/);
		assert.equal((await new NotificationQueue(reconnected).pending(recovery.owner)).length, 0);
		assert.equal((await service.list(recovery.owner)).records.length, 0);
		fail = false; await recovery.evaluate();
		assert.equal((await service.list(recovery.owner)).records[0].outcome, "queued");
		const racing = await selectionFixture(storage);
		const settings = await racing.subscriptions.view(racing.owner);
		await Promise.all([racing.evaluate(), racing.subscriptions.updateSettings(racing.owner, { expectedVersion: settings.settings.version, proactiveEnabled: false })]);
		const history = (await service.list(racing.owner)).records[0];
		assert.ok(history);
		assert.ok(history.settingsVersion === settings.settings.version || history.settingsVersion === settings.settings.version + 1);
		assert.equal(history.outcome, history.settingsVersion === settings.settings.version ? "queued" : "not_queued");
	} finally { await storage.close(); await reconnected.close(); }
});

test("新证据更新不能绕过旧设置批次的取消终态", async () => {
	const f = await selectionFixture(new MemoryStorage()); const alert = await f.evaluate(); assert.ok(alert);
	await f.storage.transaction(async (tx) => {
		const settings = await tx.subscriptionSettings.get(f.owner); assert.ok(settings);
		await tx.subscriptionSettings.put({ ...settings, version: settings.version + 1 });
	});
	f.setTime("2026-11-16T00:02:00.000Z");
	await f.evidence.revise(f.owner, alert.current.evidence.evidenceId, "new-after-settings-change", { expectedEvidenceVersion: 1, reason: "合成修订", record: selectionEvidence(2100) });
	const comparison = await f.compare(2); await f.alerts.evaluateComparison(f.owner, comparison.id);
	assert.equal((await new NotificationQueue(f.storage).pending(f.owner)).length, 0);
	const history = await new NotificationSelectionService(f.storage).list(f.owner);
	assert.equal(history.records[0].reason, "previously_cancelled");
});

test("09:30 后的新输入进入下一次汇总，服务延迟处理旧输入仍用当天批次", async () => {
	const delayed = await selectionFixture(new MemoryStorage());
	delayed.setTime("2026-11-16T02:00:00.000Z");
	await delayed.evaluate();
	assert.ok((await new NotificationQueue(delayed.storage).pending(delayed.owner))[0].batchId.endsWith("2026-11-16"));
	const fresh = await selectionFixture(new MemoryStorage());
	fresh.setTime("2026-11-16T02:00:00.000Z");
	const comparison = await fresh.compare();
	await fresh.alerts.evaluateComparison(fresh.owner, comparison.id);
	const item = (await new NotificationQueue(fresh.storage).pending(fresh.owner))[0];
	assert.ok(item.batchId.endsWith("2026-11-17"));
	assert.equal(item.sources[0].observedAt, "2026-11-16T00:01:00.000Z", "来源获取时间保留实际导入时间，不冒充后来的评估时间");
});

test("效果告警→筛选→09:30 汇总；发送前拒绝已删除/修订/处理的输入", async () => {
	for (const variant of ["valid", "removed_task", "removed_source", "revised", "handled", "disabled"] as const) {
		const storage = new MemoryStorage(); const f = await selectionFixture(storage); const alert = await f.evaluate(); assert.ok(alert);
		const runtime = compose(storage, []);
		const queue = new NotificationQueue(storage, () => new Date(f.clock()));
		const scheduler = new DigestScheduler(storage, f.subscriptions, queue, () => new Date(f.clock()));
		let sent = 0;
		const worker = new Worker(storage, runtime.decisions, new Map([["controlled", { async send() { sent++; return { externalMessageId: "synthetic-receipt" }; } }]]), f.clock, 3, f.alerts, f.notifications, { scheduler, subscriptions: f.subscriptions, queue, accountIdForPlatform: () => "controlled" }, 0);
		await storage.transaction(async (tx) => { for (const job of await tx.jobs.all()) await tx.jobs.delete(job.id); });
		assert.equal((await scheduler.tick()).enqueued, 0, "北京时间 09:30 前不发送");
		if (variant === "removed_task") await storage.transaction((tx) => tx.tasks.delete(f.task.taskId));
		if (variant === "removed_source") await storage.transaction(async (tx) => { for (const source of await tx.evidenceSources.all()) await tx.evidenceSources.delete(source.id); });
		if (variant === "revised") await f.evidence.revise(f.owner, alert.current.evidence.evidenceId, "revision-before-send", { expectedEvidenceVersion: 1, reason: "合成修订", record: selectionEvidence(2100) });
		if (variant === "handled") await storage.transaction((tx) => tx.investigationAlerts.put({ ...alert, status: "handled" }));
		if (variant === "disabled") {
			const view = await f.subscriptions.view(f.owner);
			await f.subscriptions.updateSettings(f.owner, { expectedVersion: view.settings.version, proactiveEnabled: false });
		}
		f.setTime("2026-11-16T01:30:00.000Z");
		await scheduler.tick(); await worker.runOnce();
		assert.equal(sent, variant === "valid" ? 1 : 0, variant);
		const item = (await storage.transaction((tx) => tx.notificationItems.all()))[0];
		assert.equal(item.status, variant === "valid" ? "sent" : "cancelled", variant);
		const batch = await storage.transaction((tx) => tx.notificationBatches.get(item.batchId)); assert.ok(batch);
		if (!["valid", "disabled"].includes(variant)) assert.equal(batch.statusReason, "input_unavailable");
		if (variant === "valid") assert.equal((await new NotificationSelectionService(storage).list(f.owner)).records[0].outcome, "queued", "后续投递不覆盖历史筛选结果");
	}
});
