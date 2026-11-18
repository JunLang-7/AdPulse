import assert from "node:assert/strict";
import test from "node:test";
import createClient from "../apps/console/node_modules/openapi-fetch/dist/index.mjs";
import type { paths } from "../apps/console/src/generated/api.js";
import { selectionFixture } from "./selection-helpers.ts";
import type { TestContext } from "node:test";

import { createApi } from "../apps/api/dist/server.js";
import type { AuditEvent } from "../apps/api/dist/server.js";
import {
	AuthenticationService,
	type PlatformIdentity,
	NotificationQueue,
	NotificationRecordService,
	batchId,
	digestInstant,
	itemId,
} from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const publicOrigin = "http://localhost";
const identity: PlatformIdentity = {
	platform: "feishu",
	applicationId: "cli_test",
	tenantId: "tenant-a",
	idType: "open_id",
	externalId: "ou-owner",
};

test("筛选记录 API/SDK：本人历史、筛选分页、非法参数及无权输入", async (t) => {
	const storage = new MemoryStorage();
	const f = await selectionFixture(storage); await f.evaluate();
	const duplicate = await f.compare(); await f.alerts.evaluateComparison(f.owner, duplicate.id);
	const other = await selectionFixture(storage); await other.evaluate();
	const { url, login } = await serve(t, storage, f.identity);
	const endpoint = `${url}/api/me/notification-selections`;
	assert.equal((await fetch(endpoint)).status, 401);
	const cookie = await login();
	const client = createClient<paths>({ baseUrl: url, headers: { cookie: `adpulse_session=${cookie}` } });
	const first = await client.GET("/api/me/notification-selections", { params: { query: { limit: 1, taskId: f.task.taskId, dateFrom: "2026-11-16", dateTo: "2026-11-16" } } });
	assert.ok(first.data?.nextBefore); assert.equal(first.data.records.length, 1);
	const next = await client.GET("/api/me/notification-selections", { params: { query: { limit: 1, before: first.data.nextBefore } } });
	assert.equal(next.data?.records.length, 1);
	assert.notEqual(next.data?.records[0].id, first.data.records[0].id);
	assert.ok(!JSON.stringify(first.data).includes(other.task.taskId));
	const denied = await client.GET("/api/me/notification-selections", { params: { query: { taskId: other.task.taskId } } });
	assert.deepEqual(denied.data?.records, []);
	for (const query of ["limit=0", "limit=51", "limit=x", "before=wrong", "outcome=sent", "dateFrom=2026-02-30", "dateFrom=2026-11-17&dateTo=2026-11-16", "ownerId=other", "limit=1&limit=2", "taskId="])
		assert.equal((await fetch(`${endpoint}?${query}`, { headers: { cookie: `adpulse_session=${cookie}` } })).status, 400, query);
	await storage.transaction((tx) => tx.tasks.delete(f.task.taskId));
	const removed = await client.GET("/api/me/notification-selections");
	assert.deepEqual(removed.data?.records, []);
});

async function serve(t: TestContext, storage = new MemoryStorage(), verifiedIdentity: PlatformIdentity = identity) {
	const runtime = compose(storage, []);
	const service = new AuthenticationService(runtime.storage);
	const events: AuditEvent[] = [];
	const provider = {
		authorizationUrl(parameters: { state: string; codeChallenge: string; redirectUri: string }) {
			const target = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
			target.searchParams.set("state", parameters.state);
			target.searchParams.set("code_challenge", parameters.codeChallenge);
			target.searchParams.set("redirect_uri", parameters.redirectUri);
			return target.toString();
		},
		async verifyAuthorizationCode() {
			return { identity: verifiedIdentity, displayName: "小明" };
		},
	};
	const server = createApi(runtime, {
		service,
		provider,
		publicOrigin,
		audit: (event: AuditEvent) => events.push(event),
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address() as { port: number };
	const url = `http://127.0.0.1:${address.port}`;

	const login = async () => {
		const begin = await fetch(`${url}/auth/feishu/login`, { redirect: "manual" });
		const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state") ?? "";
		const nonce = (begin.headers.getSetCookie?.() ?? [])
			.map((value) => /adpulse_oauth_nonce=([^;]+)/.exec(value)?.[1])
			.find((value) => value !== undefined);
		const callback = await fetch(
			`${url}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=one-time`,
			{ redirect: "manual", headers: { cookie: `adpulse_oauth_nonce=${nonce}` } },
		);
		const cookie = (callback.headers.getSetCookie?.() ?? [])
			.map((value) => /adpulse_session=([^;]+)/.exec(value)?.[1])
			.find((value) => value !== undefined);
		return cookie as string;
	};

	return { url, runtime, login };
}

type RecordResponse = {
	records: Array<{
		id: string;
		localDate: string;
		status: string;
		statusReason?: string;
		sentAt?: string;
		catchUp?: boolean;
		itemsSource: "delivery" | "rows";
		items: Array<{ id?: string; title: string; status?: string }>;
		delivery: { status: string; sentAt?: string } | null;
	}>;
	nextBefore: string | null;
};

const batch = (
	ownerId: string,
	date: string,
	status: "queued" | "sent" | "cancelled",
	extra: { statusReason?: string; sentAt?: string } = {},
) => ({
	id: batchId(ownerId, "digest", date),
	ownerId,
	kind: "digest" as const,
	localDate: date,
	settingsVersion: 4,
	status,
	scheduledAt: digestInstant(date),
	createdAt: `${date}T01:00:00.000Z`,
	updatedAt: `${date}T01:30:00.000Z`,
	...extra,
});

const item = (
	ownerId: string,
	date: string,
	suffix: string,
	status: "queued" | "sent" | "cancelled",
	title: string,
) => ({
	id: itemId(ownerId, `effect|task:t1|alert-${suffix}|r1`),
	ownerId,
	batchId: batchId(ownerId, "digest", date),
	logicalKey: `effect|task:t1|alert-${suffix}|r1`,
	kind: "effect_alert" as const,
	taskId: "t1",
	title,
	summary: "近 3 天咨询成本上升 35%，超过阈值。",
	relevance: "与你关注的任务「护眼台灯」相关。",
	sources: [
		{ label: "投放后台", observedAt: `${date}T00:30:00.000Z`, publishedAt: null },
	],
	revision: 1,
	status,
	createdAt: `${date}T01:00:00.000Z`,
	updatedAt: `${date}T01:30:00.000Z`,
});

const digestDelivery = (ownerId: string, date: string) => ({
	id: `digest:${batchId(ownerId, "digest", date)}`,
	recipient: { accountId: "feishu-main", kind: "user" as const, externalId: "ou-owner" },
	card: {
		title: "每日汇总",
		items: [
			{
				title: "成本上升",
				summary: "近 3 天咨询成本上升 35%。",
				relevance: "与你关注的任务相关。",
				sources: [{ label: "投放后台" }],
			},
		],
	},
	actions: [],
	purpose: "digest" as const,
	ownerId,
	batchId: batchId(ownerId, "digest", date),
	expiresAt: `${date}T23:00:00.000Z`,
	status: "sent" as const,
	externalMessageId: "om_sent",
	sentAt: `${date}T01:30:00.000Z`,
});

test("通知记录: 只返回本人批次，分页与非法参数有明确边界", async (t) => {
	const { url, runtime, login } = await serve(t);

	assert.equal(
		(await fetch(`${url}/api/me/notifications`)).status,
		401,
		"未登录不能读通知记录",
	);

	const cookie = await login();
	const headers = { cookie: `adpulse_session=${cookie}` };
	const me = (await (await fetch(`${url}/api/me`, { headers })).json()) as {
		userId: string;
	};
	const ownerId = me.userId;
	const otherId = "user-someone-else";

	await runtime.storage.transaction(async (tx) => {
		// 本人：已发送（11-12）、已取消（11-11）、排队中（11-13）。
		await tx.notificationBatches.put(batch(ownerId, "2026-11-12", "sent", {
			sentAt: "2026-11-12T01:30:00.000Z",
		}));
		await tx.notificationItems.put(item(ownerId, "2026-11-12", "a", "sent", "成本上升"));
		await tx.deliveries.put(digestDelivery(ownerId, "2026-11-12"));

		await tx.notificationBatches.put(batch(ownerId, "2026-11-11", "cancelled", {
			statusReason: "push_disabled",
		}));
		await tx.notificationItems.put(
			item(ownerId, "2026-11-11", "b", "cancelled", "已取消的汇总"),
		);

		await tx.notificationBatches.put(batch(ownerId, "2026-11-13", "queued"));
		await tx.notificationItems.put(
			item(ownerId, "2026-11-13", "c", "queued", "等待发送的汇总"),
		);

		// 另一个用户：有记录、有投递，但不得出现在本人列表里。
		await tx.notificationBatches.put(batch(otherId, "2026-11-12", "sent", {
			sentAt: "2026-11-12T01:30:00.000Z",
		}));
		await tx.notificationItems.put(
			item(otherId, "2026-11-12", "x", "sent", "别人的汇总"),
		);
		await tx.deliveries.put(digestDelivery(otherId, "2026-11-12"));
	});

	const all = (await (
		await fetch(`${url}/api/me/notifications`, { headers })
	).json()) as RecordResponse;

	assert.deepEqual(
		all.records.map((record) => record.localDate),
		["2026-11-13", "2026-11-12", "2026-11-11"],
		"按北京时间日期倒序，只含本人批次",
	);
	assert.equal(all.nextBefore, null);

	// 跨用户隔离：内容与投递都不能泄漏。
	const raw = JSON.stringify(all);
	assert.ok(!raw.includes("别人的汇总"), "他人条目不可见");
	assert.ok(!raw.includes(otherId), "他人标识不可见");

	const sent = all.records[1]!;
	assert.equal(sent.status, "sent");
	assert.equal(sent.delivery?.status, "sent");
	assert.equal(sent.delivery?.sentAt, "2026-11-12T01:30:00.000Z");
	// 已发送批次读冻结卡片内容，而不是条目行（行可能已被后续版本移走）。
	assert.equal(sent.itemsSource, "delivery");
	assert.equal(sent.items[0]?.title, "成本上升");
	assert.equal(
		sent.items[0]?.status,
		undefined,
		"冻结卡片没有行级状态，不补造",
	);

	const cancelled = all.records[2]!;
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.statusReason, "push_disabled");
	assert.equal(cancelled.delivery, null, "从未投递时没有回执");
	assert.equal(cancelled.itemsSource, "rows");
	assert.equal(cancelled.items[0]?.status, "cancelled");

	// 分页：limit + 排他游标。
	const first = (await (
		await fetch(`${url}/api/me/notifications?limit=1`, { headers })
	).json()) as RecordResponse;
	assert.deepEqual(first.records.map((record) => record.localDate), ["2026-11-13"]);
	assert.equal(first.nextBefore, "2026-11-13");

	const second = (await (
		await fetch(
			`${url}/api/me/notifications?limit=1&before=${first.nextBefore}`,
			{ headers },
		)
	).json()) as RecordResponse;
	assert.deepEqual(second.records.map((record) => record.localDate), ["2026-11-12"]);

	// 边界：非法参数明确拒绝，不静默改写。
	for (const query of ["limit=0", "limit=51", "limit=abc", "limit=1.5", "before=2026/11/12", "before=20261112"]) {
		assert.equal(
			(await fetch(`${url}/api/me/notifications?${query}`, { headers })).status,
			400,
			`${query} 应被拒绝`,
		);
	}

	// 没有更早记录时返回空页，而不是重复上一页。
	const none = (await (
		await fetch(`${url}/api/me/notifications?before=2026-11-01`, { headers })
	).json()) as RecordResponse;
	assert.deepEqual(none.records, []);
	assert.equal(none.nextBefore, null);
});

test("通知记录: 实质更新移入后续批次后，已发送记录仍显示当时发出的内容", async () => {
	// 复现：queue() 在 revision 提升时复用同一行并改 batchId，
	// 若历史记录按条目「当前所属批次」拼装，已发送批次会变成空。
	const storage = new MemoryStorage();
	let clock = Date.parse("2026-11-11T01:00:00.000Z");
	const queue = new NotificationQueue(storage, () => new Date(clock));
	const ownerId = "user-a";
	const logicalKey = "effect|task:t1|alert-a|r1";
	const enqueue = (revision: number, title: string) =>
		queue.queue(
			ownerId,
			{
				logicalKey,
				kind: "effect_alert",
				taskId: "t1",
				title,
				summary: "咨询成本上升。",
				relevance: "与你关注的任务相关。",
				sources: [{ label: "投放后台", observedAt: "2026-11-11T00:30:00.000Z" }],
				revision,
			},
			{ settingsVersion: 1, enabled: true },
		);

	await enqueue(1, "成本上升（首版）");
	const first = await queue.ensureDigestBatch(ownerId, {
		settingsVersion: 1,
		enabled: true,
	});
	assert.ok(first);
	const deliveryId = `digest:${first.id}`;
	// 模拟 worker.sendDigest：投递里冻结了当时卡片实际展示的内容。
	await storage.transaction((tx) =>
		tx.deliveries.put({
			id: deliveryId,
			recipient: { accountId: "feishu-main", kind: "user", externalId: "ou-owner" },
			card: {
				title: "信息汇总 · 2026-11-11",
				items: [
					{
						title: "成本上升（首版）",
						summary: "咨询成本上升。",
						relevance: "与你关注的任务相关。",
						sources: [{ label: "投放后台", publishedAt: null }],
					},
				],
			},
			actions: [],
			purpose: "digest",
			ownerId,
			batchId: first.id,
			expiresAt: "2026-11-11T23:00:00.000Z",
			status: "sent",
			sentAt: "2026-11-11T01:30:00.000Z",
		}),
	);
	assert.equal(
		await queue.markSent(ownerId, logicalKey, { deliveryId, revision: 1 }),
		true,
	);
	await queue.setBatchStatus(first.id, "sent");

	// 次日同一逻辑事件出现实质更新：同一行被移入新批次。
	clock = Date.parse("2026-11-12T01:00:00.000Z");
	await enqueue(2, "成本上升（补充证据）");

	const page = await new NotificationRecordService(storage).list(ownerId);
	const sent = page.records.find((record) => record.localDate === "2026-11-11");
	assert.equal(sent?.status, "sent");
	assert.equal(sent?.itemsSource, "delivery", "已发送记录读取发送时的冻结内容");
	assert.equal(sent?.items.length, 1, "已发送记录不能因为条目移动变成空");
	assert.equal(
		sent?.items[0]?.title,
		"成本上升（首版）",
		"历史记录显示当时发出的版本，而不是更新后的版本",
	);

	const next = page.records.find((record) => record.localDate === "2026-11-12");
	assert.equal(next?.itemsSource, "rows");
	assert.equal(next?.items[0]?.title, "成本上升（补充证据）");
	assert.equal(next?.items[0]?.revision, 2);
});

test("通知记录：来源事件到期后不再返回标题、摘要与来源链接", async () => {
	const storage = new MemoryStorage();
	const ownerId = "owner-expired";
	const now = "2027-11-18T00:00:00.000Z";
	const eventCreatedAt = "2026-11-17T10:00:00.000Z";
	const item = {
		ownerId, logicalKey: "event:event-1", kind: "market_event" as const,
		title: "到期事件的标题", summary: "到期事件的摘要", relevance: "该事件明确标注的主体是你关注的品牌",
		sources: [{ label: "潍柴新闻与事件", url: "https://example.com/a", publishedAt: null }],
		revision: 1, marketEventRef: { eventId: "event-1", version: 1, evidenceRevision: 1 },
		status: "cancelled" as const, createdAt: eventCreatedAt, updatedAt: eventCreatedAt,
	};
	await storage.transaction(async (tx) => {
		await tx.marketEvents.put({ id: "event-1", ownerId, logicalKey: "logical", currentVersion: 1, createdAt: eventCreatedAt });
		await tx.marketEventVersions.put({
			id: "event-1:1", eventId: "event-1", ownerId, version: 1, evidenceRevision: 1,
			input: {} as never, method: "manual", sourceItemId: null, materials: [],
			createdAt: eventCreatedAt, changeReason: "录入", candidate: { status: "evidence_ready", reasons: [] },
		});
		// 未发送条目（行投影）+ 已发送批次（冻结卡片投影）都要覆盖。
		await tx.notificationBatches.put({ id: "batch-pending", ownerId, kind: "digest", localDate: "2026-11-17", status: "cancelled", settingsVersion: 1, scheduledAt: "2026-11-18T01:30:00Z", createdAt: eventCreatedAt, updatedAt: eventCreatedAt, statusReason: "input_unavailable" } as never);
		await tx.notificationItems.put({ ...item, id: "item-pending", batchId: "batch-pending" });
		await tx.notificationBatches.put({ id: "batch-sent", ownerId, kind: "digest", localDate: "2026-11-18", status: "sent", settingsVersion: 1, scheduledAt: "2026-11-19T01:30:00Z", createdAt: eventCreatedAt, updatedAt: eventCreatedAt } as never);
		await tx.notificationItems.put({ ...item, id: "item-sent", batchId: "batch-sent", status: "sent" });
		await tx.deliveries.put({
			id: "digest:batch-sent", ownerId, batchId: "batch-sent", purpose: "digest", status: "sent",
			card: { title: "信息汇总", items: [{ title: "冻结的标题", summary: "冻结的摘要", relevance: "冻结的关联", sources: item.sources, marketEventRef: item.marketEventRef }] },
			expiresAt: "2026-11-19T02:00:00Z", sentAt: "2026-11-19T01:30:00Z",
		} as never);
	});

	const page = await new NotificationRecordService(storage, () => now).list(ownerId);
	const pending = page.records.find((record) => record.localDate === "2026-11-17");
	const sent = page.records.find((record) => record.localDate === "2026-11-18");
	assert.equal(pending?.itemsSource, "rows");
	assert.equal(pending?.items[0]?.inputExpired, true, "未发送条目到期后标记为已到期");
	assert.equal(pending?.items[0]?.title, "已到期的事件");
	assert.equal(pending?.items[0]?.summary, "这条事件已过保留期（365 天），内容不再展示。");
	assert.deepEqual(pending?.items[0]?.sources, [], "不返回来源链接");
	assert.equal(sent?.itemsSource, "delivery");
	assert.equal(sent?.items[0]?.inputExpired, true, "冻结卡片同样按到期抹掉内容");
	assert.equal(sent?.items[0]?.title, "已到期的事件");
	assert.equal(sent?.items[0]?.summary, "这条事件已过保留期（365 天），内容不再展示。");
	assert.deepEqual(sent?.items[0]?.sources, []);
});

test("通知记录：早期冻结卡片没有事件引用时，按来源地址识别并抹掉已删内容", async () => {
	const storage = new MemoryStorage();
	const ownerId = "owner-legacy";
	const now = "2026-11-18T00:00:00.000Z";
	const url = "https://www.weichai.com/group/weichai/cn/media-hub/news2/a/2026110421125786644/index.html";
	await storage.transaction(async (tx) => {
		await tx.marketEvents.put({ id: "event-legacy", ownerId, logicalKey: "logical", currentVersion: 1, createdAt: "2026-11-17T10:00:00.000Z", deletion: { at: "2026-11-17T12:00:00.000Z", by: "owner", manifestId: "m" } });
		await tx.marketEventVersions.put({
			id: "event-legacy:1", eventId: "event-legacy", ownerId, version: 1, evidenceRevision: 1,
			input: { sources: [{ url, publisher: "潍柴", content: "标题", scope: "title_only", origin: "official", publishedAt: null, acquiredAt: "2026-11-17T10:00:00.000Z", limitations: "" }], taskRefs: [] } as never,
			method: "manual", sourceItemId: null, materials: [], createdAt: "2026-11-17T10:00:00.000Z",
			changeReason: "录入", candidate: { status: "evidence_ready", reasons: [] },
		});
		await tx.notificationBatches.put({ id: "batch-legacy", ownerId, kind: "digest", localDate: "2026-11-17", status: "sent", settingsVersion: 1, scheduledAt: "2026-11-18T01:30:00Z", createdAt: "2026-11-17T10:00:00.000Z", updatedAt: "2026-11-17T10:00:00.000Z" } as never);
		// 旧格式冻结卡片：条目上没有 marketEventRef，只有来源地址。
		await tx.deliveries.put({
			id: "digest:batch-legacy", ownerId, batchId: "batch-legacy", purpose: "digest", status: "sent",
			card: { title: "信息汇总", items: [{ title: "潍柴发布新品", summary: "潍柴发布新品，仅限试点地区。", relevance: "该事件明确标注的主体是你关注的品牌", sources: [{ label: "潍柴", url, publishedAt: null }] }] },
			expiresAt: "2026-11-18T02:00:00Z", sentAt: "2026-11-18T01:30:00Z",
		} as never);
	});

	const page = await new NotificationRecordService(storage, () => now).list(ownerId);
	const item = page.records[0]?.items[0];
	assert.equal(item?.inputExpired, true, "没有引用的旧快照也要按地址识别");
	assert.equal(item?.inputRemoved, "deleted");
	assert.equal(item?.title, "已删除的事件");
	assert.equal(item?.summary, "这条事件已被删除，内容不再展示。");
	assert.deepEqual(item?.sources, []);
});
