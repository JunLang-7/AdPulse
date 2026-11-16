import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import {
	NotificationQueue,
	NotificationSelectionService,
	notificationInputsStillCurrentIn,
	matchEventTargets,
} from "../packages/core/dist/index.js";
import { MemoryStorage, PostgresStorage } from "../packages/storage/dist/index.js";
import { eventSelectionFixture } from "./selection-helpers.ts";

const records = async (f: Awaited<ReturnType<typeof eventSelectionFixture>>) =>
	(await new NotificationSelectionService(f.storage, f.clock).list(f.owner)).records;

test("事件筛选：证据齐备 + 显式主体 + include_general 才入队，卡片不复制正文", async () => {
	const f = await eventSelectionFixture(new MemoryStorage());
	const created = await f.create();
	assert.equal(created.status, "created");
	const page = await records(f);
	assert.equal(page.length, 1);
	const record = page[0]!;
	assert.equal(record.input, "event");
	assert.equal(record.outcome, "queued");
	assert.equal(record.reason, "matched");
	assert.equal(record.marketEventRef?.eventId, created.version.eventId);
	assert.equal(record.marketEventRef?.version, 1);
	assert.equal(record.revision, 1);
	assert.equal(record.matchedTargetIds.length, 1);
	assert.ok(!("alertId" in record) || record.alertId === undefined);
	assert.ok(!JSON.stringify(record).includes("仅限试点地区"), "最小筛选记录不复制原文引用");
	assert.ok(!JSON.stringify(record).includes("测试品牌于"), "最小筛选记录不复制正文");

	const items = await new NotificationQueue(f.storage, () => new Date(f.clock())).pending(f.owner);
	assert.equal(items.length, 1);
	const item = items[0]!;
	assert.equal(item.kind, "market_event");
	assert.equal(item.logicalKey, `event:${created.version.eventId}`);
	assert.equal(item.revision, 1);
	assert.equal(item.marketEventRef?.eventId, created.version.eventId);
	assert.match(item.title, /测试品牌新品发布/);
	assert.match(item.summary, /产品发布：测试品牌/);
	assert.match(item.summary, /事件时间 2026-11-16/);
	assert.match(item.summary, /未经独立来源核验/);
	assert.match(item.relevance, /该事件明确标注的主体是你关注的品牌「测试品牌」/);
	assert.match(item.relevance, /名称、标题、摘要与域名不单独构成关联依据/);
	assert.equal(item.sources.length, 1);
	assert.equal(item.sources[0]?.url, "https://example.com/releases/1");
	assert.equal(item.sources[0]?.publishedAt, "2026-11-16");
	assert.equal(item.sources[0]?.observedAt, "2026-11-16T02:00:00Z");
});

test("事件筛选：未知时间与适用条件保持未知，不补造", async () => {
	const f = await eventSelectionFixture(new MemoryStorage());
	await f.create({
		eventTime: null, conditions: null,
		citations: { subject: { sourceIndex: 0, quote: "测试品牌" }, eventTime: null, conditions: null },
	});
	const page = await records(f);
	assert.equal(page[0]?.reason, "insufficient_evidence");
	assert.equal((await new NotificationQueue(f.storage).pending(f.owner)).length, 0, "缺时间的候选不冒充可推送信息");
});

test("事件筛选：准入、关联、退订、类别与范围各有可解释原因", async () => {
	const cases: Array<[string, () => Promise<{ reason: string; outcome: string }>]> = [];
	for (const variant of ["insufficient", "simulated", "no_association", "disabled", "muted", "category", "scope", "consent", "before"] as const) {
		cases.push([variant, async () => {
			const f = await eventSelectionFixture(new MemoryStorage());
			await f.storage.transaction(async (tx) => {
				const settings = await tx.subscriptionSettings.get(f.owner); assert.ok(settings);
				const target = (await tx.subscriptionTargets.all()).find((item) => item.userId === f.owner); assert.ok(target);
				if (variant === "disabled") await tx.subscriptionSettings.put({ ...settings, proactiveEnabled: false });
				if (variant === "before") await tx.subscriptionSettings.put({ ...settings, enabledAt: "2030-01-01T00:00:00.000Z" });
				if (variant === "muted") await tx.subscriptionTargets.put({ ...target, status: "muted" });
				if (variant === "category") await tx.subscriptionTargets.put({ ...target, categories: ["effect", "evidence"] });
				if (variant === "scope") await tx.subscriptionTargets.put({ ...target, scope: "task_only" });
				if (variant === "consent") await tx.notificationConsents.delete(`${f.owner}:${f.destination.id}`);
			});
			const input = variant === "insufficient"
				? { citations: { subject: null, eventTime: null, conditions: null } }
				: variant === "simulated"
					? { provenance: { simulated: true, reference: "fixture", transformation: "合成" } }
					: variant === "no_association"
						? { subject: { kind: "brand" as const, name: "未关注的品牌" } }
						: {};
			await f.create(input);
			const record = (await records(f))[0];
			assert.ok(record);
			assert.equal((await new NotificationQueue(f.storage).pending(f.owner)).length, 0, variant);
			return { reason: record.reason, outcome: record.outcome };
		}]);
	}
	const expected: Record<string, string> = {
		insufficient: "insufficient_evidence", simulated: "simulated_input", no_association: "no_association",
		disabled: "push_disabled", muted: "target_muted", category: "category_excluded",
		scope: "scope_excluded", consent: "not_authorized", before: "before_enabled",
	};
	for (const [variant, run] of cases) {
		const record = await run();
		assert.equal(record.reason, expected[variant], variant);
		if (record.reason !== "matched") assert.notEqual(record.outcome, "queued", variant);
	}
});

test("事件筛选：同一证据版本不重复入队，实质修订推进 revision，标题编辑不推进", async () => {
	const f = await eventSelectionFixture(new MemoryStorage());
	const created = await f.create();
	const first = (await records(f))[0]!;
	// 同内容重复提交：返回原版本，不新增判断，也不新增通知。
	assert.equal((await f.create({}, "same-input")).status, "duplicate");
	assert.equal((await records(f)).length, 1);
	// 只改标题：普通修订，证据版本不变，不重复推送。
	f.setTime("2026-11-16T00:05:00.000Z");
	const titleOnly = await f.revise(created.version.eventId, 1, { title: "测试品牌新品发布（更正标题）" });
	assert.equal(titleOnly.status, "revised");
	assert.equal(titleOnly.version.evidenceRevision, 1);
	assert.equal((await records(f)).length, 1);
	assert.equal((await new NotificationQueue(f.storage).pending(f.owner))[0]?.revision, 1);
	// 改来源原文引用：实质证据修订，按 revision 再次通知。
	f.setTime("2026-11-16T00:06:00.000Z");
	const revised = await f.revise(created.version.eventId, 2, {
		sources: [{
			url: "https://example.com/releases/1", publisher: "测试官网", content: "测试品牌于2026-11-16发布新品，仅限华东试点地区。",
			scope: "full_text", origin: "official", publishedAt: "2026-11-16", acquiredAt: "2026-11-16T03:00:00Z",
			limitations: "人造 fixture；官方性质由录入者声明",
		}],
		conditions: "仅限华东试点地区",
		citations: { subject: { sourceIndex: 0, quote: "测试品牌" }, eventTime: { sourceIndex: 0, quote: "2026-11-16" }, conditions: { sourceIndex: 0, quote: "仅限华东试点地区" } },
	});
	assert.equal(revised.version.evidenceRevision, 2);
	const page = await records(f);
	assert.equal(page.length, 2);
	assert.equal(page.find((record) => record.revision === 2)?.outcome, "queued");
	const items = await new NotificationQueue(f.storage, () => new Date(f.clock())).pending(f.owner);
	assert.equal(items.length, 1);
	assert.equal(items[0]?.revision, 2);
	assert.equal(items[0]?.marketEventRef?.evidenceRevision, 2);
	assert.equal(page.find((record) => record.id === first.id)?.revision, 1, "历史判断不被后续修订改写");
});

test("事件筛选：任务关联命中 task_only，跨用户不共享关注项与事件", async () => {
	const f = await eventSelectionFixture(new MemoryStorage());
	await f.addTarget({ kind: "task", refId: f.task.taskId, categories: ["event"], scope: "task_only" });
	await f.create({ taskRefs: [{ taskId: f.task.taskId, taskVersion: 1, reason: "该发布与本人任务的投放产品同类" }] });
	const record = (await records(f)).find((item) => item.taskId === f.task.taskId);
	assert.ok(record, "有显式任务关联的事件对 task_only 也命中");
	assert.equal(record.reason, "matched");
	assert.equal(record.outcome, "queued");

	// 另一用户：自己的关注项与事件互不可见，也不会因为别人的命中而入队。
	const other = await eventSelectionFixture(f.storage);
	await other.create();
	const otherRecord = (await records(other))[0]!;
	assert.equal(otherRecord.outcome, "queued", "另一用户按自己的品牌关注命中自己录入的同名事件");
	assert.notEqual(otherRecord.id, record.id, "两个用户的筛选记录互不复用");
	const fItems = await new NotificationQueue(f.storage).pending(f.owner);
	assert.equal(fItems.length, 1, "同一用户同一事件只有一条通知");
	assert.ok(fItems.every((item) => item.ownerId === f.owner));
	assert.ok((await new NotificationQueue(other.storage).pending(other.owner))
		.every((item) => item.ownerId === other.owner), "另一用户的通知只属于本人");
	assert.ok(!JSON.stringify(await records(f)).includes(other.owner));
	assert.equal((await new NotificationSelectionService(f.storage, f.clock).list(other.owner)).records.length, 1);
});

test("事件筛选：发送前复检当前证据版本，失效条目在投递前被取消", async () => {
	const f = await eventSelectionFixture(new MemoryStorage());
	const created = await f.create();
	const item = (await new NotificationQueue(f.storage).pending(f.owner))[0]!;
	assert.equal(await f.storage.transaction((tx) => notificationInputsStillCurrentIn(tx, item)), true);
	f.setTime("2026-11-16T00:05:00.000Z");
	await f.revise(created.version.eventId, 1, { title: "测试品牌新品发布（更正标题）" });
	const stale = await f.storage.transaction(async (tx) => {
		const current = (await tx.notificationItems.all()).find((row) => row.id === item.id);
		assert.ok(current);
		return notificationInputsStillCurrentIn(tx, current);
	});
	assert.equal(stale, false, "事件已进入新版本时不发送旧版本的卡片");
});

test("事件筛选：匹配只认显式主体或任务关联，名称标准化后比较", async () => {
	const f = await eventSelectionFixture(new MemoryStorage());
	const created = await f.create({ subject: { kind: "brand", name: "  测试品牌  " } });
	const targets = await f.storage.transaction((tx) => tx.subscriptionTargets.all());
	const matched = matchEventTargets(targets, f.owner, created.version);
	assert.equal(matched.matched.length, 1, "NFKC/折叠空白/lowercase 后仍命中同一关注对象");
	assert.equal(matched.scopeExcluded, false);
});

test("PostgreSQL：事件筛选与入队同事务落库，重连后仍按本人可见", { skip: !process.env.TEST_DATABASE_URL }, async () => {
	const url = process.env.TEST_DATABASE_URL!;
	const { Pool } = createRequire(new URL("../packages/storage/package.json", import.meta.url))("pg") as {
		Pool: new (options: { connectionString: string; options?: string }) => ConstructorParameters<typeof PostgresStorage>[0];
	};
	// 独立 schema：与并行运行的其他 PostgreSQL 用例共库时避免跨用例的序列化冲突干扰。
	const admin = new Pool({ connectionString: url }) as unknown as {
		query(sql: string): Promise<unknown>; end(): Promise<void>;
	};
	const schema = `event_selection_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE SCHEMA ${schema}`);
	const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
	const reconnectedPool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
	const storage = new PostgresStorage(pool);
	const reconnected = new PostgresStorage(reconnectedPool);
	try {
		await storage.initialize();
		const f = await eventSelectionFixture(storage);
		const created = await f.create();
		const page = await new NotificationSelectionService(reconnected).list(f.owner);
		assert.equal(page.records.length, 1);
		assert.equal(page.records[0]?.marketEventRef?.eventId, created.version.eventId);
		assert.equal((await new NotificationQueue(reconnected).pending(f.owner)).length, 1);
		const other = await eventSelectionFixture(reconnected);
		assert.equal((await new NotificationSelectionService(reconnected).list(other.owner)).records.length, 0);
		assert.equal((await new NotificationSelectionService(reconnected).list(f.owner)).records[0]?.reason, "matched");
		// 同一用户并发写入仍由事件写入锁与幂等键收口，不会给出第二条通知。
		await Promise.allSettled([f.create({ title: "并发 A" }, "race-a"), f.create({ title: "并发 B" }, "race-b")]);
		const items = await new NotificationQueue(reconnected).pending(f.owner);
		assert.equal(items.length, 1, "并发写入不制造第二条逻辑通知");
	} finally {
		await storage.close();
		await reconnected.close();
		await admin.query(`DROP SCHEMA ${schema} CASCADE`);
		await admin.end();
	}
});
