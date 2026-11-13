import assert from "node:assert/strict";
import test from "node:test";

import {
	AuthenticationService,
	CATCH_UP_GRACE_MS,
	DigestScheduler,
	NotificationQueue,
	NotificationService,
	SubscriptionService,
	Worker,
	inQuietHours,
	localDate,
	quietHoursEnd,
} from "../packages/core/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

/** 北京时间 2026-11-11 08:30（UTC 00:30），早于 09:30 汇总。 */
const BEFORE_DIGEST = "2026-11-11T00:30:00.000Z";
/** 北京时间 09:30 整。 */
const AT_DIGEST = "2026-11-11T01:30:00.000Z";
/** 北京时间 23:00，落在免打扰内。 */
const IN_QUIET = "2026-11-11T15:00:00.000Z";
/** 次日北京时间 08:00，免打扰结束。 */
const QUIET_END = "2026-11-12T00:00:00.000Z";

const identity = {
	platform: "feishu",
	applicationId: "cli_test",
	tenantId: "tenant-a",
	idType: "open_id",
	externalId: "ou-owner",
};

/** 搭一个可发日汇总的账号：已确认地址 + 已授权 + 已开启推送。 */
async function setup(start = AT_DIGEST) {
	const storage = new MemoryStorage();
	let clock = Date.parse(start);
	const now = () => new Date(clock);
	const at = (iso: string) => {
		clock = Date.parse(iso);
	};
	const sent: Array<{ id: string; card: unknown; recipient: unknown }> = [];
	/** 发送期间插入副作用的钩子，用于复现真实竞态。 */
	let onSend: (() => Promise<void>) | undefined;
	const runtime = compose(storage, [
		{
			id: "feishu-internal",
			identityScope: {
				platform: "feishu",
				applicationId: "cli_test",
				tenantId: "tenant-a",
			},
			inbound: {
				async parse() {
					throw new Error("unused");
				},
			},
			outbound: {
				async send(delivery) {
					await onSend?.();
					sent.push({
						id: delivery.id,
						card: delivery.card,
						recipient: delivery.recipient,
					});
					return { externalMessageId: `ext:${delivery.id}` };
				},
			},
		},
	]);
	const auth = new AuthenticationService(storage);
	const session = await auth.createWebSession(
		identity,
		"a".repeat(64),
		"2026-01-01T00:00:00.000Z",
	);
	const notifications = new NotificationService(storage, () => new Date(clock).toISOString());
	const subscriptions = new SubscriptionService(storage, () => new Date(clock).toISOString());
	const queue = new NotificationQueue(storage, now);
	const scheduler = new DigestScheduler(storage, subscriptions, queue, now);
	const worker = new Worker(
		storage,
		runtime.decisions,
		new Map([["feishu-internal", runtime.channels.outbound().get("feishu-internal")!]]),
		() => new Date(clock).toISOString(),
		5,
		runtime.investigationAlerts,
		notifications,
		{
			scheduler,
			subscriptions,
			queue,
			accountIdForPlatform: (platform) =>
				platform === "feishu" ? "feishu-internal" : undefined,
		},
		0,
	);

	// 地址 + 授权 + 开启推送
	const destination = await notifications.verifyDestination(session.userId, identity);
	await notifications.grantConsent(session.userId, destination.id, 0);
	await subscriptions.updateSettings(session.userId, {
		expectedVersion: 0,
		proactiveEnabled: true,
	});

	const ownerId = session.userId;
	const enqueue = async (
		key: string,
		overrides: { revision?: number; title?: string } = {},
	) => {
		const view = await subscriptions.view(ownerId);
		return queue.queue(
			ownerId,
			{
				logicalKey: key,
				kind: "effect_alert",
				taskId: "task-1",
				title: overrides.title ?? "成本上升",
				summary: "近 3 天咨询成本上升 35%，超过阈值。",
				relevance: "与你关注的「护眼台灯」相关。",
				sources: [
					{
						label: "投放后台",
						observedAt: "2026-11-10T09:00:00.000Z",
						publishedAt: null,
					},
				],
				revision: overrides.revision ?? 1,
			},
			{ settingsVersion: view.settings.version, enabled: true },
		);
	};
	/** 把队列里的任务跑到没有可领任务为止。 */
	const drain = async (limit = 10) => {
		for (let i = 0; i < limit; i += 1)
			if (!(await worker.runOnce())) break;
	};

	return {
		setOnSend: (hook: (() => Promise<void>) | undefined) => {
			onSend = hook;
		},
		storage,
		runtime,
		worker,
		queue,
		scheduler,
		subscriptions,
		notifications,
		ownerId,
		sent,
		at,
		now,
		enqueue,
		drain,
	};
}

test("日汇总调度: 早于计划时刻不入队，到点才入队且只入队一次", async () => {
	const { scheduler, queue, ownerId, storage, enqueue, at } = await setup(BEFORE_DIGEST);
	await enqueue("k1");
	at(BEFORE_DIGEST);
	let result = await scheduler.tick();
	assert.equal(result.enqueued, 0, "09:30 之前不发");
	assert.equal((await queue.queuedBatches()).length, 1);

	at(AT_DIGEST);
	result = await scheduler.tick();
	assert.equal(result.enqueued, 1);
	const jobs = await storage.transaction((tx) => tx.jobs.all());
	assert.equal(
		jobs.filter((job) => job.task.kind === "send_digest").length,
		1,
	);
	// 重复 tick 不重复入队（同一批次只允许一个在途任务）。
	const again = await scheduler.tick();
	assert.equal(again.enqueued, 0, "已入队的批次不得重复入队");
	assert.equal(
		(await storage.transaction((tx) => tx.jobs.all())).filter(
			(job) => job.task.kind === "send_digest",
		).length,
		1,
	);
	assert.ok(ownerId);
});

test("日汇总调度: 准点抖动不标补发，明显错过才标 catchUp", async () => {
	assert.equal(CATCH_UP_GRACE_MS, 5 * 60_000, "容差是 5 分钟：覆盖 30s tick 抖动");

	// 计划时刻 +10s：调度 tick 的正常抖动，属于准点发送。
	const jitter = await setup(BEFORE_DIGEST);
	await jitter.enqueue("k-jitter");
	jitter.at("2026-11-11T01:30:10.000Z");
	await jitter.scheduler.tick();
	const onTime = (await jitter.storage.transaction((tx) =>
		tx.notificationBatches.all(),
	))[0];
	assert.ok(onTime);
	assert.equal(onTime.catchUp, undefined, "10s 抖动不得标成当日补发");

	// 计划时刻 +6min：确实错过了计划时刻，属于当日补发。
	const recovered = await setup(BEFORE_DIGEST);
	await recovered.enqueue("k-recovered");
	recovered.at("2026-11-11T01:36:00.000Z");
	await recovered.scheduler.tick();
	const late = (await recovered.storage.transaction((tx) =>
		tx.notificationBatches.all(),
	))[0];
	assert.equal(late?.catchUp, true, "超出容差才记当日补发");
});

test("日汇总调度: 空批次不发，标记取消原因 empty", async () => {
	const { scheduler, storage, at } = await setup(BEFORE_DIGEST);
	const batchId = `digest:${(await storage.transaction((tx) => tx.notificationBatches.all()))[0]?.ownerId ?? "x"}`;
	at(AT_DIGEST);
	// 手动造一个没有条目的批次。
	const ownerId = (await (async () => {
		const subs = await storage.transaction((tx) => tx.subscriptionSettings.all());
		return subs[0]!.userId;
	})()) as string;
	const queue = new NotificationQueue(storage, () => new Date(Date.parse(AT_DIGEST)));
	await queue.ensureDigestBatch(ownerId, {
		settingsVersion: 1,
		enabled: true,
	});
	const result = await scheduler.tick();
	assert.equal(result.cancelled, 1);
	const batch = await storage.transaction((tx) =>
		tx.notificationBatches.get(`digest:${ownerId}:2026-11-11`),
	);
	assert.equal(batch?.status, "cancelled");
	assert.equal(batch?.statusReason, "empty");
	assert.ok(batchId);
});

test("日汇总调度: 免打扰内延后，窗口结束后的 tick 才发送", async () => {
	const started = await setup(IN_QUIET);
	await started.enqueue("k1");
	// 该批次计划时刻是今天 09:30（已过），当前处于免打扰。
	const ticked = await started.scheduler.tick();
	assert.equal(ticked.enqueued, 0, "免打扰内不得入队");
	assert.equal(ticked.deferred, 1);
	assert.deepEqual(started.sent, []);

	started.at(QUIET_END);
	const after = await started.scheduler.tick();
	// 跨日后不再补发昨天那份：条目并入今天(11-12)的汇总，昨天批次被合并终结。
	assert.equal(after.cancelled, 1, "往日批次合并，不补发旧日报");
	const batches = await started.storage.transaction((tx) =>
		tx.notificationBatches.all(),
	);
	const yesterday = batches.find((batch) => batch.localDate === "2026-11-11");
	assert.equal(yesterday?.statusReason, "merged_stale");
	assert.deepEqual(started.sent, [], "08:00 尚未到今天的汇总时刻");

	// 今天 09:30 才发，且只有一张卡。
	started.at("2026-11-12T01:30:00.000Z");
	assert.equal((await started.scheduler.tick()).enqueued, 1);
	await started.drain();
	assert.equal(started.sent.length, 1, "只发一份合并后的汇总");
});

test("日汇总发送: 卡片含短摘要、来源与「为什么相关」，不创建 Session", async () => {
	const started = await setup();
	await started.enqueue("k1");
	await started.enqueue("k2", { title: "竞品降价" });
	await started.scheduler.tick();
	await started.drain();

	assert.equal(started.sent.length, 1);
	const card = started.sent[0]!.card as {
		title: string;
		items: Array<{ title: string; summary: string; relevance: string; sources: unknown[] }>;
		footer?: string;
	};
	assert.match(card.title, /信息汇总 · 2026-11-11/);
	assert.equal(card.items.length, 2);
	assert.equal(card.items[0]?.title, "成本上升");
	assert.match(card.items[0]?.relevance ?? "", /护眼台灯/);
	assert.equal(card.items[0]?.sources.length, 1);
	assert.match(card.footer ?? "", /订阅与关注/);
	// 只发一卡：不因两条信息拆成两次投递。
	const deliveries = await started.storage.transaction((tx) => tx.deliveries.all());
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0]?.purpose, "digest");
	// 没有会话被创建。
	assert.equal(
		(await started.storage.transaction((tx) => tx.sessions.all())).length,
		0,
		"信息卡不得创建决策会话",
	);
	const items = await started.storage.transaction((tx) => tx.notificationItems.all());
	assert.deepEqual(
		items.map((item) => item.status).sort(),
		["sent", "sent"],
	);
	assert.ok(items.every((item) => item.deliveryId));
	const batch = (await started.storage.transaction((tx) => tx.notificationBatches.all()))[0];
	assert.equal(batch?.status, "sent");
	assert.ok(batch?.sentAt);
});

test("日汇总发送: 未授权时抑制且不调用渠道，条目取消不复活", async () => {
	const started = await setup();
	await started.enqueue("k1");
	const view = await started.subscriptions.view(started.ownerId);
	const status = await started.notifications.status(started.ownerId);
	await started.notifications.revokeConsent(
		started.ownerId,
		status.destination!.id,
		status.consent!.version,
	);
	// 取消授权会推进订阅版本之外的独立版本；这里只验证发送前重检能拦住。
	await started.scheduler.tick();
	await started.drain();

	assert.deepEqual(started.sent, [], "未授权不得调用渠道");
	const batch = (await started.storage.transaction((tx) => tx.notificationBatches.all()))[0];
	assert.equal(batch?.status, "suppressed");
	assert.equal(batch?.statusReason, "consent_revoked");
	const items = await started.storage.transaction((tx) => tx.notificationItems.all());
	assert.equal(items[0]?.status, "cancelled");
	assert.ok(view);
});

test("日汇总发送: 期间关闭推送 → 取消，不发送", async () => {
	const started = await setup();
	await started.enqueue("k1");
	const view = await started.subscriptions.view(started.ownerId);
	await started.subscriptions.updateSettings(started.ownerId, {
		expectedVersion: view.settings.version,
		proactiveEnabled: false,
	});
	await started.scheduler.tick();
	await started.drain();
	assert.deepEqual(started.sent, []);
	const batch = (await started.storage.transaction((tx) => tx.notificationBatches.all()))[0];
	assert.equal(batch?.status, "cancelled");
	// 关闭后重新开启：旧条目仍取消，新内容排到下一批次。
	const reopened = await started.subscriptions.view(started.ownerId);
	await started.subscriptions.updateSettings(started.ownerId, {
		expectedVersion: reopened.settings.version,
		proactiveEnabled: true,
	});
	const after = await started.subscriptions.view(started.ownerId);
	const fresh = await started.queue.queue(
		started.ownerId,
		{
			logicalKey: "fresh",
			kind: "effect_alert",
			title: "新信息",
			summary: "重新开启后的新内容。",
			relevance: "与任务相关。",
			sources: [{ label: "投放后台" }],
			revision: 1,
		},
		{ settingsVersion: after.settings.version, enabled: true },
	);
	assert.equal(fresh.outcome, "queued");
	assert.equal(fresh.item?.batchId, `digest:${started.ownerId}:2026-11-12`);
});

test("日汇总发送: 发送期间出现实质更新时，只把展示过的版本标为已发送", async () => {
	const started = await setup();
	await started.enqueue("k1");
	await started.scheduler.tick();
	const jobs = await started.storage.transaction((tx) => tx.jobs.all());
	assert.equal(jobs.filter((job) => job.task.kind === "send_digest").length, 1);
	// 真实竞态：投递卡已按 revision 1 冻结，发送**期间**来了实质更新。
	started.setOnSend(async () => {
		await started.enqueue("k1", { revision: 2, title: "成本上升（补充证据）" });
	});
	await started.drain();

	assert.equal(started.sent.length, 1);
	const items = await started.storage.transaction((tx) => tx.notificationItems.all());
	const item = items.find((entry) => entry.logicalKey === "k1");
	// revision 1 已发送，revision 2 仍在待发 → 条目回到 queued。
	assert.equal(item?.revision, 2);
	assert.equal(item?.status, "queued", "尚未发出的实质更新不能被旧回执消费");
	assert.equal(
		item?.batchId,
		`digest:${started.ownerId}:2026-11-12`,
		"更新的条目顺延到下一批次，不留在已发送批次里",
	);
});

test("日汇总发送: 卡片容量满时剩余条目标记为「另有 N 条」并顺延到下一批", async () => {
	const started = await setup();
	for (let index = 1; index <= 7; index += 1)
		await started.enqueue(`k${index}`, { title: `第 ${index} 条` });
	await started.scheduler.tick();
	await started.drain();

	assert.equal(started.sent.length, 1);
	const card = started.sent[0]!.card as { items: unknown[]; footer?: string };
	assert.equal(card.items.length, 5, "首期一卡最多 5 条");
	assert.match(card.footer ?? "", /另有 2 条/);
	const items = await started.storage.transaction((tx) => tx.notificationItems.all());
	assert.equal(
		items.filter((item) => item.status === "queued").length,
		2,
		"未展示的条目仍在待发，且已移到下一批次",
	);
	const queued = await started.queue.queuedBatches();
	assert.deepEqual(
		queued.map((batch) => batch.localDate),
		["2026-11-12"],
	);
});

test("日汇总时间: 免打扰判断与窗口结束计算使用北京时间", () => {
	const schedule = { quietStart: "22:00", quietEnd: "08:00" };
	assert.equal(inQuietHours(new Date("2026-11-11T15:00:00.000Z"), schedule), true);
	assert.equal(inQuietHours(new Date("2026-11-11T00:30:00.000Z"), schedule), false);
	assert.equal(inQuietHours(new Date("2026-11-11T13:59:00.000Z"), schedule), false);
	assert.equal(inQuietHours(new Date("2026-11-11T14:00:00.000Z"), schedule), true);
	assert.equal(
		quietHoursEnd(new Date("2026-11-11T15:00:00.000Z"), "08:00"),
		"2026-11-12T00:00:00.000Z",
	);
	assert.equal(
		localDate(new Date("2026-11-11T15:00:00.000Z")),
		"2026-11-11",
		"北京时间 23:00 仍是当天",
	);
});

test("日汇总发送: 调度之后进入免打扰，发送前复检必须拦住", async () => {
	const started = await setup(AT_DIGEST);
	await started.enqueue("k1");
	// 09:30 允许，任务已入队。
	assert.equal((await started.scheduler.tick()).enqueued, 1);
	// 到 23:00（免打扰内）worker 才领到这个任务：必须不发。
	started.at(IN_QUIET);
	await started.drain();
	assert.deepEqual(started.sent, [], "发送前复检应拦住免打扰");
	const batch = (await started.storage.transaction((tx) => tx.notificationBatches.all()))[0];
	assert.equal(batch?.status, "queued", "延后而不是取消，窗口结束后还能发");
});

test("日汇总发送: 入队后配置版本变化，发送前复检必须取消", async () => {
	const started = await setup(AT_DIGEST);
	await started.enqueue("k1");
	assert.equal((await started.scheduler.tick()).enqueued, 1);
	// 入队之后、发送之前改了时段 → 版本推进，批次内容与当前配置已不匹配。
	const view = await started.subscriptions.view(started.ownerId);
	await started.subscriptions.updateSettings(started.ownerId, {
		expectedVersion: view.settings.version,
		schedule: {
			timezone: "Asia/Shanghai",
			digestAt: "10:00",
			quietStart: "23:00",
			quietEnd: "07:00",
		},
	});
	await started.drain();
	assert.deepEqual(started.sent, [], "配置变了不得按旧批次发送");
	const batch = (await started.storage.transaction((tx) => tx.notificationBatches.all()))[0];
	assert.equal(batch?.status, "cancelled");
	assert.equal(batch?.statusReason, "settings_changed");
	const items = await started.storage.transaction((tx) => tx.notificationItems.all());
	assert.equal(items[0]?.status, "cancelled");
});

test("日汇总调度: 连续多日积压只发一份，旧批次合并终结", async () => {
	// 三天各留一个排队批次（模拟服务故障），第四天恢复。
	const started = await setup("2026-11-09T01:00:00.000Z");
	const queue = started.queue;
	const subs = await started.subscriptions.view(started.ownerId);
	for (const date of ["2026-11-09", "2026-11-10", "2026-11-11"]) {
		started.at(`${date}T01:00:00.000Z`);
		await queue.ensureDigestBatch(started.ownerId, {
			settingsVersion: subs.settings.version,
			enabled: true,
		});
		await queue.queue(
			started.ownerId,
			{
				logicalKey: `k-${date}`,
				kind: "effect_alert",
				title: `${date} 的信息`,
				summary: "该日的新信息。",
				relevance: "与任务相关。",
				sources: [{ label: "投放后台" }],
				revision: 1,
			},
			{ settingsVersion: subs.settings.version, enabled: true },
		);
	}

	// 第四天 09:30 恢复：一次 tick + drain 只应发出一张卡。
	started.at("2026-11-12T01:30:00.000Z");
	await started.scheduler.tick();
	await started.drain();
	assert.equal(started.sent.length, 1, "跨日恢复不得连发多份旧日报");

	const card = started.sent[0]!.card as { title: string; items: unknown[] };
	assert.match(card.title, /2026-11-12/, "发出的是当天汇总");
	const batches = await started.storage.transaction((tx) =>
		tx.notificationBatches.all(),
	);
	const stale = batches.filter((batch) => batch.localDate < "2026-11-12");
	assert.equal(stale.length, 3);
	assert.ok(
		stale.every((batch) => batch.status === "cancelled"),
		"往日批次全部终结",
	);
	assert.ok(
		stale.every((batch) => batch.statusReason === "merged_stale"),
	);
	// 三天三批的条目全部并入当天汇总（一卡最多 5 条，3 条全在）。
	assert.equal(card.items.length, 3);
});

test("日汇总发送: 往日批次的任务跨日才被领取时不发送，改成合并", async () => {
	const started = await setup("2026-11-11T01:30:00.000Z");
	await started.enqueue("k1");
	assert.equal((await started.scheduler.tick()).enqueued, 1);
	// 任务入队后 worker 一直没跑，跨日才被领取。
	started.at("2026-11-12T02:00:00.000Z");
	await started.drain();
	assert.deepEqual(started.sent, [], "跨日才领取的往日任务不得补发");
	const batches = await started.storage.transaction((tx) =>
		tx.notificationBatches.all(),
	);
	const yesterday = batches.find((batch) => batch.localDate === "2026-11-11");
	assert.equal(yesterday?.status, "cancelled");
	assert.equal(yesterday?.statusReason, "merged_stale");
	const items = await started.storage.transaction((tx) => tx.notificationItems.all());
	assert.equal(items[0]?.status, "queued", "条目仍待发，只是换了批次");
	assert.equal(items[0]?.batchId, `digest:${started.ownerId}:2026-11-12`);
});

test("日汇总发送: 租约被接管时旧 worker 不得回写投递、条目、批次或地址", async () => {
	const started = await setup();
	await started.enqueue("k1");
	assert.equal((await started.scheduler.tick()).enqueued, 1);
	// 发送期间：任务租约被新 worker 接管（模拟租约过期后重新领取）。
	started.setOnSend(async () => {
		await started.storage.transaction(async (tx) => {
			const jobs = await tx.jobs.all();
			for (const job of jobs)
				if (job.task.kind === "send_digest")
					await tx.jobs.put({
						...job,
						status: "running",
						leaseToken: "another-worker-lease",
					});
		});
	});
	await started.drain();

	// 投递/条目/批次都不是旧 worker 写的。
	const deliveries = await started.storage.transaction((tx) => tx.deliveries.all());
	assert.equal(deliveries[0]?.status, "pending", "旧 worker 不得把投递标为已发送");
	const items = await started.storage.transaction((tx) => tx.notificationItems.all());
	assert.equal(items[0]?.status, "queued", "条目仍待发");
	const batches = await started.storage.transaction((tx) =>
		tx.notificationBatches.all(),
	);
	assert.equal(batches[0]?.status, "queued", "批次不被旧 worker 终结");
	// 地址状态也不能被旧 worker 改动。
	const status = await started.notifications.status(started.ownerId);
	assert.equal(status.destination?.status, "verified");
});
