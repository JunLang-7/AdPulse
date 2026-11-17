import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import {
	AuthenticationService,
	SourceLeadError,
	SourceLeadService,
	SubscriptionService,
	SubscriptionError,
} from "../packages/core/dist/index.js";
import { MemoryStorage, PostgresStorage } from "../packages/storage/dist/index.js";
import type { SourceItem, Storage } from "../packages/core/dist/index.js";

const item = (sourceKey: string, index: number, overrides: Partial<SourceItem> = {}): SourceItem => ({
	id: `${sourceKey}:${index}`,
	sourceKey,
	itemKey: `https://example.com/${sourceKey}/${index}`,
	title: `${sourceKey} 标题 ${index}`,
	itemUrl: `https://www.${sourceKey === "weichai_news" ? "weichai.com" : "haier.com"}/news/${index}.html`,
	publishedAt: "2026-11-15",
	firstSeenAt: `2026-11-16T00:0${index}:00.000Z`,
	lastSeenAt: `2026-11-16T00:0${index}:00.000Z`,
	titleUpdatedAt: null,
	contentScope: "title_link_only",
	status: "active",
	...overrides,
});

async function fixture(storage: Storage) {
	const identity = { platform: "feishu", applicationId: "cli_test", tenantId: "tenant-a", idType: "open_id", externalId: randomUUID() };
	const auth = new AuthenticationService(storage);
	const session = await auth.createWebSession(identity, createHash("sha256").update(randomUUID()).digest("hex"), "2026-11-16T00:00:00.000Z");
	const subscriptions = new SubscriptionService(storage);
	const initial = await subscriptions.view(session.userId);
	return {
		storage, owner: session.userId, subscriptions,
		view: initial,
		async enable(feeds: string[], expectedVersion = initial.settings.version) {
			return subscriptions.updateSettings(session.userId, { expectedVersion, sourceFeeds: feeds });
		},
		async seed(items: SourceItem[]) {
			await storage.transaction(async (tx) => { for (const row of items) await tx.sourceItems.put(row); });
		},
	};
}

test("自动来源线索：默认关闭时为空，开启后只列本人已开启来源的 active 条目", async () => {
	const f = await fixture(new MemoryStorage());
	await f.seed([item("weichai_news", 1), item("haier_news", 1), item("weichai_news", 2, { status: "purged" })]);
	const leads = new SourceLeadService(f.storage);
	const closed = await leads.list(f.owner);
	assert.equal(closed.leads.length, 0, "未开启任何来源时不返回线索");
	assert.deepEqual(closed.sources.map((source) => source.enabled), [false, false]);

	await f.enable(["weichai_news"]);
	const opened = await leads.list(f.owner);
	assert.deepEqual(opened.leads.map((lead) => lead.itemId), ["weichai_news:1"]);
	assert.deepEqual(opened.leads[0]?.subject, { kind: "brand", name: "潍柴" }, "主体取自声明的站点映射");
	assert.equal(opened.leads[0]?.sourceLabel, "潍柴新闻与事件");
	assert.equal(opened.leads[0]?.publishedAt, "2026-11-15");
	assert.ok(!("convertedEventId" in (opened.leads[0] ?? {})), "未录入时不伪造已转换标记");
	assert.deepEqual(opened.sources.filter((source) => source.enabled).map((source) => source.key), ["weichai_news"]);
});

test("自动来源线索：未开启的来源不可查询，未知 key 与非法 limit 被拒", async () => {
	const f = await fixture(new MemoryStorage());
	await f.seed([item("weichai_news", 1), item("haier_news", 1)]);
	const leads = new SourceLeadService(f.storage);
	await f.enable(["weichai_news"]);
	await assert.rejects(leads.list(f.owner, { sourceKey: "haier_news" }), (error: unknown) =>
		error instanceof SourceLeadError && error.reason === "invalid_query");
	await assert.rejects(leads.list(f.owner, { limit: 51 }), (error: unknown) =>
		error instanceof SourceLeadError && error.reason === "invalid_query");
	// 未知来源 key 直接拒绝（版本取自当前值，避免把版本冲突误当成 key 校验）。
	await assert.rejects(
		f.enable(["unknown_feed"], (await f.subscriptions.view(f.owner)).settings.version),
		(error: unknown) => error instanceof SubscriptionError && error.reason === "invalid_target",
	);
	const all = await leads.list(f.owner, { limit: 1 });
	assert.equal(all.leads.length, 1);
});

test("自动来源线索：已录入同 URL 事件时标记已转换，旧修订不冒充当前事实", async () => {
	const f = await fixture(new MemoryStorage());
	await f.seed([item("weichai_news", 1)]);
	await f.enable(["weichai_news"]);
	const url = "https://www.weichai.com/news/1.html";
	await f.storage.transaction(async (tx) => {
		await tx.marketEvents.put({ id: "event-1", ownerId: f.owner, logicalKey: "k", currentVersion: 1, createdAt: "2026-11-16T01:00:00.000Z" });
		await tx.marketEventVersions.put({
			id: "event-1:1", eventId: "event-1", ownerId: f.owner, version: 1, evidenceRevision: 1,
			input: {
				occurrenceKey: "k", title: "线索转事件", type: "announcement", subject: { kind: "brand", name: "潍柴" },
				eventTime: null, conditions: null,
				sources: [{ url, publisher: "潍柴新闻与事件", content: null, scope: "title_only", origin: "official", publishedAt: "2026-11-15", acquiredAt: "2026-11-16T01:00:00.000Z", limitations: "仅标题" }],
				citations: { subject: null, eventTime: null, conditions: null }, taskRefs: [],
				provenance: { simulated: false, reference: null, transformation: null },
			},
			method: "manual", sourceItemId: null, materials: [], createdAt: "2026-11-16T01:00:00.000Z",
			changeReason: "线索转事件", candidate: { status: "insufficient", reasons: ["缺少官方原文引用"] },
		});
	});
	const leads = new SourceLeadService(f.storage);
	const converted = await leads.list(f.owner);
	assert.equal(converted.leads[0]?.convertedEventId, "event-1", "同 URL 已有事件时提示已录入");

	// 事件被修订成不含该链接的新版本：旧链接不再算「已录入」。
	await f.storage.transaction(async (tx) => {
		const head = await tx.marketEvents.get("event-1"); assert.ok(head);
		await tx.marketEvents.put({ ...head, currentVersion: 2 });
		await tx.marketEventVersions.put({
			id: "event-1:2", eventId: "event-1", ownerId: f.owner, version: 2, evidenceRevision: 2,
			input: {
				occurrenceKey: "k", title: "线索转事件（改）", type: "announcement", subject: { kind: "brand", name: "潍柴" },
				eventTime: null, conditions: null,
				sources: [{ url: "https://www.weichai.com/news/other.html", publisher: "潍柴新闻与事件", content: null, scope: "title_only", origin: "official", publishedAt: null, acquiredAt: "2026-11-16T02:00:00.000Z", limitations: "仅标题" }],
				citations: { subject: null, eventTime: null, conditions: null }, taskRefs: [],
				provenance: { simulated: false, reference: null, transformation: null },
			},
			method: "manual", sourceItemId: null, materials: [], createdAt: "2026-11-16T02:00:00.000Z",
			changeReason: "换链接", candidate: { status: "insufficient", reasons: [] },
		});
	});
	assert.equal((await leads.list(f.owner)).leads[0]?.convertedEventId, undefined);
});

test("自动来源线索：跨用户隔离，各自只看到自己开启的来源", async () => {
	const storage = new MemoryStorage();
	const a = await fixture(storage);
	const b = await fixture(storage);
	await a.seed([item("weichai_news", 1), item("haier_news", 1)]);
	await a.enable(["weichai_news"]);
	await b.enable(["haier_news"]);
	const leads = new SourceLeadService(storage);
	assert.deepEqual((await leads.list(a.owner)).leads.map((lead) => lead.sourceKey), ["weichai_news"]);
	assert.deepEqual((await leads.list(b.owner)).leads.map((lead) => lead.sourceKey), ["haier_news"]);
	await assert.rejects(leads.list(b.owner, { sourceKey: "weichai_news" }), (error: unknown) =>
		error instanceof SourceLeadError, "不能借查询参数看别人开启的来源");
});

test("PostgreSQL：来源线索按本人开关过滤并与事件转换状态一致", { skip: !process.env.TEST_DATABASE_URL }, async () => {
	const url = process.env.TEST_DATABASE_URL!;
	const { Pool } = createRequire(new URL("../packages/storage/package.json", import.meta.url))("pg") as {
		Pool: new (options: { connectionString: string; options?: string }) => ConstructorParameters<typeof PostgresStorage>[0];
	};
	const admin = new Pool({ connectionString: url }) as unknown as {
		query(sql: string): Promise<unknown>; end(): Promise<void>;
	};
	const schema = `source_leads_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE SCHEMA ${schema}`);
	const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
	const reconnected = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
	const storage = new PostgresStorage(pool);
	const other = new PostgresStorage(reconnected);
	try {
		await storage.initialize();
		const f = await fixture(storage);
		await f.seed([item("weichai_news", 1)]);
		assert.equal((await new SourceLeadService(other).list(f.owner)).leads.length, 0);
		await f.enable(["weichai_news"]);
		const leads = await new SourceLeadService(other).list(f.owner);
		assert.equal(leads.leads.length, 1);
		assert.equal(leads.leads[0]?.sourceKey, "weichai_news");
		assert.equal(leads.sources.filter((source) => source.enabled).length, 1);
		// 关掉来源后立即回到空列表，不需要任何缓存失效。
		await f.enable([], (await f.subscriptions.view(f.owner)).settings.version);
		assert.equal((await new SourceLeadService(other).list(f.owner)).leads.length, 0);
	} finally {
		await other.close();
		await storage.close();
		await admin.query(`DROP SCHEMA ${schema} CASCADE`);
		await admin.end();
	}
});

test("来源状态：只返回本人已开启来源，含最近结果与条目计数", async () => {
	const f = await fixture(new MemoryStorage());
	await f.seed([item("weichai_news", 1), item("weichai_news", 2, { status: "purged" })]);
	const leads = new SourceLeadService(f.storage);
	assert.deepEqual(await leads.status(f.owner), [], "未开启来源时为空");

	await f.enable(["weichai_news"]);
	await f.storage.transaction(async (tx) => {
		await tx.sourceRuns.put({
			id: "run-1", sourceKey: "weichai_news", startedAt: "2026-11-17T00:00:00.000Z",
			finishedAt: "2026-11-17T00:00:01.000Z", httpStatus: 200, robotsState: "absent", bytes: 100,
			itemCount: 2, outcome: "ok", snapshotComplete: true, configVersion: "2026-11-07.1", errorReason: null,
		});
		await tx.sourceStates.put({ id: "state-1", sourceKey: "weichai_news", status: "active", stoppedAt: null, stoppedReason: null, resumedAt: null, resumedBy: null, lastPrunedAt: null });
	});
	const [status] = await leads.status(f.owner);
	assert.ok(status);
	assert.equal(status.key, "weichai_news");
	assert.equal(status.status, "active");
	assert.equal(status.lastOutcome, "ok");
	assert.equal(status.lastRun, "2026-11-17T00:00:00.000Z");
	assert.equal(status.activeItems, 1);
	assert.equal(status.purgedItems, 1);
});
