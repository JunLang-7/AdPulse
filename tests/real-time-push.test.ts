import assert from "node:assert/strict";
import test from "node:test";
import {
	SubscriptionService,
	type MarketEventVersion,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { runRealTimePush } from "../packages/runtime/dist/index.js";

let counter = 0;
const event = (ownerId: string, createdAt: string, ready = true): MarketEventVersion => {
	counter += 1;
	return {
		id: `event-${counter}:1`,
		eventId: `event-${counter}`,
		ownerId,
		version: 1,
		evidenceRevision: 1,
		input: {
			occurrenceKey: `key-${counter}`,
			title: `事件 ${counter}`,
			type: "announcement",
			subject: { kind: "brand", name: "海尔" },
			eventTime: "2026-11-19",
			conditions: "全国",
			sources: [{
				url: "https://www.haier.com/news/1.shtml",
				publisher: "海尔",
				content: "正文",
				scope: "excerpt",
				origin: "official",
				publishedAt: "2026-11-19",
				acquiredAt: "2026-11-19T00:00:00.000Z",
				limitations: "",
			}],
			citations: {
				subject: { sourceIndex: 0, quote: "正文" },
				eventTime: { sourceIndex: 0, quote: "正文" },
				conditions: { sourceIndex: 0, quote: "正文" },
			},
			taskRefs: [],
			provenance: { simulated: false, reference: null, transformation: null },
		},
		method: "manual",
		sourceItemId: null,
		materials: [{ id: "m1", method: "manual", sourceItemId: null }],
		createdAt,
		changeReason: "创建",
		candidate: ready
			? { status: "evidence_ready", reasons: [] }
			: { status: "insufficient", reasons: ["事件时间未知"] },
	};
};

const fakeChannel = () => {
	const sent: string[] = [];
	return {
		sent,
		channel: {
			channel: "feishu" as const,
			label: "飞书单聊",
			configured: true,
			async send(message: { title: string; body: string }) {
				sent.push(message.body);
				return { channel: "feishu" as const, label: "飞书单聊", status: "ok" as const, detail: null };
			},
		},
	};
};

test("实时推送：未开启时什么都不推", async () => {
	const storage = new MemoryStorage();
	const subscriptions = new SubscriptionService(storage);
	await storage.transaction(async (tx) => {
		await tx.marketEventVersions.put(event("u1", "2026-11-19T01:00:00.000Z"));
	});
	const result = await runRealTimePush("u1", {
		storage,
		env: { FEISHU_APP_ID: "cli", FEISHU_APP_SECRET: "s" },
		resolveFeishuOpenId: async () => "ou_1",
	});
	assert.equal(result.eventCount, 0);
	assert.equal(result.reason, "real_time_push_disabled");
	void subscriptions;
});

test("实时推送：开启后推 watermark 之后的新事件，且只推一次", async () => {
	const storage = new MemoryStorage();
	const subscriptions = new SubscriptionService(storage);
	const initial = await subscriptions.view("u1");
	await subscriptions.updateSettings("u1", { expectedVersion: initial.settings.version, realTimePushEnabled: true });
	const settings = await storage.transaction((tx) => tx.subscriptionSettings.get("u1"));
	assert.equal(settings?.realTimePush?.enabled, true);
	assert.ok(settings?.realTimePush?.watermark, "开启时写入起点水位线");

	// 水位线之前的事件不该被推（开启时不补发历史）。
	const oldEvent = event("u1", "2026-11-19T00:00:00.000Z");
	const newEvent = event("u1", new Date(Date.parse(settings!.realTimePush!.watermark!) + 1000).toISOString());
	await storage.transaction(async (tx) => {
		await tx.marketEventVersions.put(oldEvent);
		await tx.marketEventVersions.put(newEvent);
	});

	const fake = fakeChannel();
	const first = await runRealTimePush("u1", {
		storage,
		env: {},
		resolveFeishuOpenId: async () => "ou_1",
		// 注入假渠道，避免真实网络
		pushChannelsOverride: [fake.channel],
	} as never);
	assert.equal(first.eventCount, 1, "只推新事件，不补发历史");
	assert.equal(first.sent, 1);
	assert.match(fake.sent[0] ?? "", /事件/);

	// 水位线已推进，同一批事件不再重复推。
	const second = await runRealTimePush("u1", {
		storage,
		env: {},
		resolveFeishuOpenId: async () => "ou_1",
		pushChannelsOverride: [fake.channel],
	} as never);
	assert.equal(second.eventCount, 0, "已推过的不重复");
	assert.equal(fake.sent.length, 1);
});

test("实时推送：没有可用渠道时不发，reason 说明原因", async () => {
	const storage = new MemoryStorage();
	const subscriptions = new SubscriptionService(storage);
	const initial = await subscriptions.view("u1");
	await subscriptions.updateSettings("u1", { expectedVersion: initial.settings.version, realTimePushEnabled: true });
	await storage.transaction(async (tx) => {
		await tx.marketEventVersions.put(event("u1", new Date().toISOString()));
	});
	const result = await runRealTimePush("u1", {
		storage,
		env: {},
		resolveFeishuOpenId: async () => null,
		pushChannelsOverride: [],
	} as never);
	assert.equal(result.sent, 0);
	assert.equal(result.reason, "no_push_channel_configured");
});

test("实时推送：依据不齐备的事件不推", async () => {
	const storage = new MemoryStorage();
	const subscriptions = new SubscriptionService(storage);
	const initial = await subscriptions.view("u1");
	await subscriptions.updateSettings("u1", { expectedVersion: initial.settings.version, realTimePushEnabled: true });
	await storage.transaction(async (tx) => {
		await tx.marketEventVersions.put(event("u1", new Date().toISOString(), false));
	});
	const fake = fakeChannel();
	const result = await runRealTimePush("u1", {
		storage,
		env: {},
		resolveFeishuOpenId: async () => "ou_1",
		pushChannelsOverride: [fake.channel],
	} as never);
	assert.equal(result.eventCount, 0);
	assert.equal(fake.sent.length, 0, "依据不齐备不推");
});
