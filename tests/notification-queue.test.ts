import assert from "node:assert/strict";
import test from "node:test";

import {
	NotificationQueue,
	NotificationQueueError,
	batchId,
	digestInstant,
	itemId,
	localDate,
	logicalKeyFor,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const setup = (start = "2026-11-11T01:00:00.000Z") => {
	const storage = new MemoryStorage();
	let clock = Date.parse(start);
	const queue = new NotificationQueue(storage, () => new Date(clock));
	const advance = (ms: number) => {
		clock += ms;
	};
	const at = (iso: string) => {
		clock = Date.parse(iso);
	};
	return { storage, queue, advance, at, now: () => new Date(clock) };
};

const item = (overrides: Partial<Parameters<NotificationQueue["queue"]>[1]> = {}) => ({
	logicalKey: "effect|task:t1|alert-a|r1",
	kind: "effect_alert" as const,
	taskId: "t1",
	title: "成本上升",
	summary: "近 3 天咨询成本上升 35%，超过阈值。",
	relevance: "与你关注的任务「护眼台灯」相关。",
	sources: [
		{ label: "投放后台", observedAt: "2026-11-10T09:00:00.000Z", publishedAt: null },
	],
	revision: 1,
	...overrides,
});

test("通知队列: 北京时间日期与 09:30 换算不依赖服务器时区", () => {
	// UTC 15:59 仍是北京同日；16:00 起进入北京次日。
	assert.equal(localDate(new Date("2026-11-11T15:59:00.000Z")), "2026-11-11");
	assert.equal(localDate(new Date("2026-11-11T16:00:00.000Z")), "2026-11-12");
	assert.equal(localDate(new Date("2026-11-11T00:00:00.000Z")), "2026-11-11");
	// 北京 09:30 = UTC 01:30。
	assert.equal(digestInstant("2026-11-11"), "2026-11-11T01:30:00.000Z");
	assert.equal(digestInstant("2026-01-01"), "2026-01-01T01:30:00.000Z");
});

test("通知队列: 批次按 人+本地日期+类型 幂等，关闭推送时不生成", async () => {
	const { queue } = setup();
	const first = await queue.ensureDigestBatch("user-a", {
		settingsVersion: 1,
		enabled: true,
	});
	const again = await queue.ensureDigestBatch("user-a", {
		settingsVersion: 5,
		enabled: true,
	});
	assert.equal(first?.id, batchId("user-a", "digest", "2026-11-11"));
	assert.equal(again?.id, first?.id, "同一天只应有一份批次");
	assert.equal(again?.settingsVersion, 1, "已存在的批次不被覆盖版本");

	const disabled = await queue.ensureDigestBatch("user-a", {
		settingsVersion: 1,
		enabled: false,
	});
	assert.equal(disabled, null, "关闭推送期间不得为已关闭用户排队");
	assert.equal((await queue.queuedBatches()).length, 1);
});

test("通知队列: 同一逻辑事件重复入队只留一条", async () => {
	const { queue } = setup();
	const first = await queue.queue("user-a", item(), {
		settingsVersion: 1,
		enabled: true,
	});
	assert.equal(first.outcome, "queued");
	const again = await queue.queue("user-a", item({ title: "换个标题" }), {
		settingsVersion: 1,
		enabled: true,
	});
	assert.equal(again.outcome, "duplicate", "同 revision 的重试/改名不得重复通知");
	assert.equal(again.item?.title, "成本上升", "重复请求不覆盖已排队内容");
	assert.equal((await queue.pending("user-a")).length, 1);
});

test("通知队列: 实质更新（revision 提升）再次通知并说明变化", async () => {
	const { queue } = setup();
	await queue.queue("user-a", item(), { settingsVersion: 1, enabled: true });
	const updated = await queue.queue(
		"user-a",
		item({ revision: 2, summary: "补充新证据：竞品同期降价 20%。" }),
		{ settingsVersion: 1, enabled: true },
	);
	assert.equal(updated.outcome, "queued");
	assert.equal(updated.item?.revision, 2);
	assert.match(updated.item?.summary ?? "", /补充新证据/);
	assert.equal(
		(await queue.pending("user-a")).length,
		1,
		"更新的条目复用同一行，不新增",
	);
	// 旧版本回放不能把内容改回去。
	const stale = await queue.queue("user-a", item({ revision: 1 }), {
		settingsVersion: 1,
		enabled: true,
	});
	assert.equal(stale.outcome, "duplicate");
	assert.equal(stale.item?.revision, 2);
});

test("通知队列: 取消是终态，重新开启不复活旧队列", async () => {
	const { queue } = setup();
	await queue.queue("user-a", item(), { settingsVersion: 1, enabled: true });
	const cancelled = await queue.cancelPending("user-a", "push_disabled");
	assert.equal(cancelled.items, 1);
	assert.equal(cancelled.batches, 1);
	assert.equal((await queue.queuedBatches()).length, 0);

	// 重新开启后再次提交同一条（即使 revision 更高）也不得复活。
	const revived = await queue.queue(
		"user-a",
		item({ revision: 5, title: "重新开启后重放" }),
		{ settingsVersion: 2, enabled: true },
	);
	assert.equal(revived.outcome, "cancelled");
	assert.equal(revived.item?.status, "cancelled");
	assert.equal((await queue.pending("user-a")).length, 0);
});

test("通知队列: 已发送的条目取消不回滚，业务结果不受影响", async () => {
	const { queue } = setup();
	await queue.queue("user-a", item(), { settingsVersion: 1, enabled: true });
	await queue.markSent("user-a", item().logicalKey, "delivery-1");
	const result = await queue.cancelPending("user-a", "push_disabled");
	assert.equal(result.items, 0, "已发送不在取消范围");
	assert.equal((await queue.pending("user-a")).length, 0);
});

test("通知队列: 跨用户隔离，A 的取消与去重不影响 B", async () => {
	const { queue } = setup();
	const key = logicalKeyFor({
		kind: "effect_alert",
		taskId: "t1",
		sourceRef: "alert-a",
		eventRef: "r1",
	});
	await queue.queue("user-a", item({ logicalKey: key }), {
		settingsVersion: 1,
		enabled: true,
	});
	await queue.queue("user-b", item({ logicalKey: key }), {
		settingsVersion: 1,
		enabled: true,
	});
	await queue.cancelPending("user-a", "push_disabled");
	assert.equal((await queue.pending("user-a")).length, 0);
	assert.equal(
		(await queue.pending("user-b")).length,
		1,
		"B 的通知不能被 A 的关闭带走",
	);
	// 同一 logicalKey 在两个用户下是两行。
	assert.equal(itemId("user-a", key) === itemId("user-b", key), false);
});

test("通知队列: 关闭推送时拒绝排队，不产生孤立条目", async () => {
	const { queue } = setup();
	await assert.rejects(
		queue.queue("user-a", item(), { settingsVersion: 1, enabled: false }),
		(error: unknown) =>
			error instanceof NotificationQueueError &&
			error.reason === "batch_unavailable",
	);
	assert.equal((await queue.pending("user-a")).length, 0);
	assert.equal((await queue.queuedBatches()).length, 0);
});

test("通知队列: 字段校验（标题、摘要、revision、logicalKey）", async () => {
	const { queue } = setup();
	const cases: Array<[string, Parameters<NotificationQueue["queue"]>[1]]> = [
		["空标题", item({ title: "  " })],
		["空摘要", item({ summary: "" })],
		["revision 为 0", item({ revision: 0 })],
		["revision 非整数", item({ revision: 1.5 })],
		["空 logicalKey", item({ logicalKey: "" })],
	];
	for (const [name, input] of cases) {
		await assert.rejects(
			queue.queue("user-a", input, { settingsVersion: 1, enabled: true }),
			(error: unknown) =>
				error instanceof NotificationQueueError &&
				error.reason === "invalid_item",
			name,
		);
	}
	assert.equal((await queue.pending("user-a")).length, 0, "被拒入队不留残条目");
});

test("通知队列: 批次状态流转记录原因与补发标记", async () => {
	const { queue } = setup();
	const batch = await queue.ensureDigestBatch("user-a", {
		settingsVersion: 1,
		enabled: true,
	});
	const sent = await queue.setBatchStatus(batch!.id, "sent", { catchUp: true });
	assert.equal(sent?.status, "sent");
	assert.ok(sent?.sentAt);
	assert.equal(sent?.catchUp, true);

	const second = await queue.ensureDigestBatch("user-a", {
		settingsVersion: 1,
		enabled: true,
	});
	assert.equal(second?.id, batch!.id);
	const suppressed = await queue.setBatchStatus(batch!.id, "suppressed", {
		reason: "destination_invalidated",
	});
	assert.equal(suppressed?.statusReason, "destination_invalidated");
	assert.equal(await queue.setBatchStatus("missing", "sent"), null);
});

test("通知队列: pending 只返回 queued，按 key 稳定排序", async () => {
	const { queue } = setup();
	for (const key of ["b", "a", "c"])
		await queue.queue("user-a", item({ logicalKey: key }), {
			settingsVersion: 1,
			enabled: true,
		});
	const pending = await queue.pending("user-a");
	assert.deepEqual(
		pending.map((entry) => entry.logicalKey),
		["a", "b", "c"],
		"排序稳定，批次内容可冻结",
	);
	assert.equal(pending[0]?.status, "queued");
});
