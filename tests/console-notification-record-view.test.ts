import assert from "node:assert/strict";
import test from "node:test";

import {
	describeRecord,
	formatBeijing,
	type RecordLike,
} from "../apps/console/src/views/adpulse/settings/notification-records/record-view.ts";

const source = {
	label: "投放后台",
	url: "https://example.com/report",
	publishedAt: null,
	observedAt: "2026-11-12T00:30:00.000Z",
};

/** 去掉 sentAt：已排队/被抑制的批次不会有实际发送时刻。 */
const withoutSentAt = (input: RecordLike): RecordLike => {
	const copy = { ...input };
	delete copy.sentAt;
	return copy;
};

const record = (overrides: Partial<RecordLike> = {}): RecordLike => ({
	id: "digest:user-a:2026-11-12",
	localDate: "2026-11-12",
	status: "sent",
	scheduledAt: "2026-11-12T01:30:00.000Z",
	sentAt: "2026-11-12T01:31:00.000Z",
	settingsVersion: 4,
	items: [
		{
			id: "user-a:effect|task:t1|alert-a|r1",
			title: "成本上升",
			summary: "近 3 天咨询成本上升 35%。",
			relevance: "与你关注的任务「护眼台灯」相关。",
			sources: [source],
			revision: 1,
			status: "sent",
			taskId: "t1",
		},
	],
	delivery: { status: "sent", sentAt: "2026-11-12T01:31:00.000Z" },
	...overrides,
});

test("通知记录视图: 已发送的汇总说明「已接收不等于已读」，不编造原因", () => {
	const view = describeRecord(record());

	assert.equal(view.statusLabel, "已发送");
	assert.equal(view.tone, "ok");
	assert.equal(view.reason, null, "已发送不显示「为什么没收到」");
	assert.equal(
		view.deliveryNote,
		"平台已接收这条消息，但「已接收」不代表你已读。",
	);
	assert.equal(view.title, "11月12日 每日汇总");
	assert.equal(view.times.planned, "09:30", "计划时刻固定北京时间");
	assert.equal(view.items[0]?.statusLabel, "已发送");
	assert.equal(view.items[0]?.sources[0]?.publishedAt, null, "未知发布时间保留 null");
});

test("通知记录视图: 每个已知原因代码都有可读文案，未知代码不吞掉", () => {
	const reasons = [
		"push_disabled",
		"settings_changed",
		"empty",
		"merged_stale",
		"destination_missing",
		"destination_invalidated",
		"consent_missing",
		"consent_revoked",
		"identity_inactive",
		"channel_unavailable",
		"recipient_unreachable",
	];
	for (const statusReason of reasons) {
		const view = describeRecord(record({ status: "cancelled", statusReason }));
		assert.ok(view.reason, `${statusReason} 必须有说明`);
		assert.ok(
			!view.reason.label.includes(statusReason),
			`${statusReason} 应翻译成中文，而不是显示原码`,
		);
		assert.ok(view.reason.detail.length > 0);
	}

	const unknown = describeRecord(
		record({ status: "cancelled", statusReason: "future_code" }),
	);
	assert.ok(unknown.reason?.label.includes("future_code"), "未翻译的代码要显示原码");
	assert.match(unknown.reason?.detail ?? "", /不推测/);
});

test("通知记录视图: 没有记录原因时如实说「未记录原因」", () => {
	const view = describeRecord(
		record({ status: "failed", delivery: { status: "failed", lastError: "send failed" } }),
	);
	assert.equal(view.statusLabel, "发送失败");
	assert.match(view.reason?.detail ?? "", /不推测具体原因/);
	assert.match(view.deliveryNote ?? "", /投递失败/);
	assert.match(view.deliveryNote ?? "", /不回滚业务结果/);
});

test("通知记录视图: 排队中的批次说明会顺延而非承诺时刻", () => {
	const view = describeRecord({
		...withoutSentAt(record()),
		status: "queued",
		delivery: null,
		items: [{ ...record().items[0]!, status: "queued" }],
	});
	assert.equal(view.statusLabel, "等待发送");
	assert.match(view.reason?.label ?? "", /队列/);
	assert.match(view.reason?.detail ?? "", /免打扰/);
	assert.equal(view.deliveryNote, null, "还没投递就不谈回执");
});

test("通知记录视图: 补发批次与抑制回执分别标注", () => {
	const view = describeRecord({
		...withoutSentAt(record()),
		catchUp: true,
		status: "suppressed",
		statusReason: "recipient_unreachable",
		delivery: {
			status: "suppressed",
			suppressionReason: "destination_invalidated",
		},
	});
	assert.equal(view.title, "11月12日 每日汇总（当日补发）");
	assert.equal(view.tone, "warn");
	assert.match(view.deliveryNote ?? "", /destination_invalidated/);
});

test("通知记录视图: 时间格式化固定 Asia/Shanghai", () => {
	// UTC 17:00 = 北京次日 01:00，不跟随运行环境时区。
	assert.equal(formatBeijing("2026-11-12T17:00:00.000Z"), "11月13日 01:00");
	assert.equal(
		formatBeijing("2026-11-12T17:00:00.000Z", { withDate: false }),
		"01:00",
	);
	assert.equal(formatBeijing("not-a-time"), "—");
});
