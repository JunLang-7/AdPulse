import assert from "node:assert/strict";
import test from "node:test";

import {
	activeTargets,
	confirmationSummary,
	describeReadiness,
	describeSettingsFeedback,
	errorText,
	formatSchedule,
	kindLabel,
	savedNotice,
	categoryLabels,
	scopeLabel,
	validateScheduleDraft,
	validateTargetDraft,
	type NotificationStatusLike,
	type SubscriptionTargetLike,
	type SubscriptionViewLike,
} from "../apps/console/src/views/adpulse/settings/subscriptions/subscription-view.ts";

const schedule = {
	timezone: "Asia/Shanghai",
	digestAt: "09:30",
	quietStart: "22:00",
	quietEnd: "08:00",
};

const target = (
	overrides: Partial<SubscriptionTargetLike> = {},
): SubscriptionTargetLike => ({
	id: "t1",
	kind: "task",
	kindLabel: "任务",
	refId: "task-1",
	label: "护眼台灯",
	categories: ["effect", "event"],
	scope: "task_only",
	status: "active",
	updatedAt: "2026-11-10T01:00:00.000Z",
	...overrides,
});

const subscription = (
	overrides: Partial<SubscriptionViewLike> = {},
): SubscriptionViewLike => ({
	settings: { version: 3, proactiveEnabled: true, schedule },
	targets: [target()],
	...overrides,
});

const notification = (
	overrides: Partial<NotificationStatusLike> = {},
): NotificationStatusLike => ({
	destination: { status: "verified" },
	consent: { status: "active", version: 1 },
	canSendProactive: true,
	...overrides,
});

test("subscription 视图: 四种状态分开，任一缺失都不显示为可收到提醒", () => {
	const cases: Array<[string, SubscriptionViewLike, NotificationStatusLike, string]> = [
		["无地址", subscription(), notification({ destination: null }), "destination_missing"],
		[
			"地址失效",
			subscription(),
			notification({ destination: { status: "invalidated" } }),
			"destination_invalidated",
		],
		[
			"未授权",
			subscription(),
			notification({ consent: null }),
			"consent_missing",
		],
		[
			"已撤销授权",
			subscription(),
			notification({ consent: { status: "revoked", version: 2 } }),
			"consent_missing",
		],
		[
			"推送未开启",
			subscription({ settings: { version: 3, proactiveEnabled: false, schedule } }),
			notification(),
			"push_disabled",
		],
		[
			"没有生效对象",
			subscription({ targets: [target({ status: "muted" })] }),
			notification(),
			"no_targets",
		],
		["全部就绪", subscription(), notification(), "ready"],
	];
	for (const [name, sub, note, state] of cases) {
		const readiness = describeReadiness(sub, note);
		assert.equal(readiness.state, state, name);
		assert.equal(
			readiness.canDeliver,
			state === "ready",
			`${name}: 只有 ready 才算会收到提醒`,
		);
	}
});

test("subscription 视图: 服务端闸门关闭时不冒充可投递", () => {
	// 四项配置都齐备，但 canSendProactive=false：绑定/身份已失效，实际会被抑制。
	const suppressed = describeReadiness(
		subscription(),
		notification({ canSendProactive: false }),
	);
	assert.equal(suppressed.state, "identity_inactive");
	assert.equal(suppressed.canDeliver, false);
	assert.match(suppressed.title, /抑制|失效/);
	assert.ok(
		cases_every_suppressed(),
		"任何 canDeliver=false 的状态都不能被界面写成可收到提醒",
	);
});

/** 任一状态只要 canDeliver=false，就必须给出非空的「不会发送」解释。 */
function cases_every_suppressed(): boolean {
	const variants: Array<[SubscriptionViewLike, NotificationStatusLike]> = [
		[subscription(), notification({ destination: null })],
		[subscription(), notification({ consent: null })],
		[subscription(), notification({ canSendProactive: false })],
		[
			subscription({ settings: { version: 1, proactiveEnabled: false, schedule } }),
			notification(),
		],
	];
	return variants.every(([sub, note]) => {
		const readiness = describeReadiness(sub, note);
		return readiness.canDeliver === false && readiness.detail.length > 10;
	});
}

test("subscription 视图: 退订对象不计入生效数量", () => {
	const targets = [
		target({ id: "a", label: "A" }),
		target({ id: "b", label: "B", status: "muted" }),
	];
	assert.equal(activeTargets(targets).length, 1);
	assert.deepEqual(
		activeTargets(targets).map((item) => item.label),
		["A"],
	);
});

test("subscription 视图: 开启确认清单包含范围、类别、汇总与免打扰", () => {
	const summary = confirmationSummary(
		subscription({
			targets: [
				target({ id: "a", label: "护眼台灯", categories: ["effect"] }),
				target({
					id: "b",
					label: "某某竞品",
					kind: "competitor",
					kindLabel: "竞品",
					categories: ["event"],
				}),
			],
		}),
	);
	const text = summary.lines.join("\n");
	assert.match(text, /关注对象：2 个（护眼台灯、某某竞品）/);
	assert.match(text, /接收类别：效果排查、明确事件/);
	assert.match(text, /每日 09:30 汇总，有新内容才发/);
	assert.match(text, /遵守22:00–08:00 免打扰/);
	assert.match(text, /北京时间/);
	assert.equal(summary.warning, undefined);
});

test("subscription 视图: 没有生效对象时确认清单给出警告", () => {
	const summary = confirmationSummary(
		subscription({ targets: [target({ status: "muted" })] }),
	);
	assert.match(summary.lines[0] ?? "", /当前没有/);
	assert.ok(summary.warning, "空订阅必须警告，不能假装开启后有内容");
});

test("subscription 视图: 时段展示用北京时间且与后端默认一致", () => {
	const formatted = formatSchedule(schedule);
	assert.deepEqual(formatted, {
		digest: "每日 09:30 汇总",
		quiet: "22:00–08:00 免打扰",
		timezoneNote: "时间均为北京时间（Asia/Shanghai）",
	});
});

test("subscription 视图: 关注对象草稿校验", () => {
	assert.equal(
		validateTargetDraft({ kind: "task", categories: ["effect"] }),
		"请选择一个自己的任务。",
	);
	assert.equal(
		validateTargetDraft({ kind: "brand", categories: ["effect"] }),
		"请填写名称。",
	);
	assert.equal(
		validateTargetDraft({ kind: "brand", label: "   ", categories: ["effect"] }),
		"请填写名称。",
	);
	assert.equal(
		validateTargetDraft({
			kind: "brand",
			label: "x".repeat(41),
			categories: ["effect"],
		}),
		"名称最多 40 个字。",
	);
	assert.equal(
		validateTargetDraft({
			kind: "competitor",
			label: "某竞品",
			sourceUrl: "javascript:alert(1)",
			categories: ["event"],
		}),
		"来源链接必须以 http 或 https 开头。",
	);
	assert.equal(
		validateTargetDraft({
			kind: "competitor",
			label: "某竞品",
			sourceUrl: "不是链接",
			categories: ["event"],
		}),
		"来源链接格式不正确。",
	);
	assert.equal(
		validateTargetDraft({ kind: "brand", label: "某品牌", categories: [] }),
		"至少选择一个类别。",
	);
	assert.equal(
		validateTargetDraft({
			kind: "brand",
			label: " 某品牌 ",
			sourceUrl: "https://example.com/a",
			categories: ["event"],
		}),
		null,
	);
	assert.equal(
		validateTargetDraft({ kind: "task", taskId: "t1", categories: ["effect"] }),
		null,
	);
});

test("subscription 视图: 时段草稿校验与后端规则一致（汇总不得落入免打扰）", () => {
	assert.equal(
		validateScheduleDraft({ digestAt: "9:30", quietStart: "22:00", quietEnd: "08:00" }),
		"时间格式应为 HH:MM，例如 09:30。",
	);
	assert.equal(
		validateScheduleDraft({ digestAt: "09:30", quietStart: "22:00", quietEnd: "22:00" }),
		"免打扰的起止时间不能相同。",
	);
	assert.equal(
		validateScheduleDraft({ digestAt: "23:00", quietStart: "22:00", quietEnd: "08:00" }),
		"汇总时间不能落在免打扰时段内，否则永远不会发送。",
	);
	assert.equal(
		validateScheduleDraft({ digestAt: "07:00", quietStart: "22:00", quietEnd: "08:00" }),
		"汇总时间不能落在免打扰时段内，否则永远不会发送。",
	);
	assert.equal(
		validateScheduleDraft({ digestAt: "09:30", quietStart: "22:00", quietEnd: "08:00" }),
		null,
	);
	// 不跨零点的情况。
	assert.equal(
		validateScheduleDraft({ digestAt: "12:00", quietStart: "13:00", quietEnd: "14:00" }),
		null,
	);
	assert.equal(
		validateScheduleDraft({ digestAt: "13:30", quietStart: "13:00", quietEnd: "14:00" }),
		"汇总时间不能落在免打扰时段内，否则永远不会发送。",
	);
});

test("subscription 视图: 保存成功不等于可投递，提示语必须写清", () => {
	assert.match(
		savedNotice(subscription()),
		/已保存/,
	);
	assert.match(
		savedNotice(
			subscription({ settings: { version: 1, proactiveEnabled: false, schedule } }),
		),
		/推送仍是关闭状态/,
	);
});

test("subscription 视图: 标签与错误文案", () => {
	assert.equal(kindLabel("brand"), "品牌");
	assert.equal(kindLabel("competitor"), "竞品");
	assert.equal(kindLabel("unknown", "自定义"), "自定义");
	assert.equal(kindLabel("unknown"), "unknown");
	assert.deepEqual(categoryLabels(["effect", "evidence"]), ["效果排查", "补证/待处理"]);
	assert.equal(scopeLabel("include_general"), "也接收该对象的一般动态");
	assert.match(errorText(409), /其他标签页/);
	assert.match(errorText(404), /找不到这个关注对象/);
	assert.match(errorText(422), /输入不合法/);
	assert.match(errorText(500), /操作失败/);
});

test("subscription 视图: 写入失败必须可见，且不保留上一次成功提示", () => {
	const ok = describeSettingsFeedback({ pending: false, errorStatus: null, notice: "已开启订阅推送。" });
	assert.equal(ok.failure, null);
	assert.equal(ok.notice, "已开启订阅推送。");
	assert.equal(ok.dismissEnabled, true);

	// 版本冲突（409）与网络/未知错误都要给出可见文案。
	const conflict = describeSettingsFeedback({
		pending: false,
		errorStatus: 409,
		notice: "已开启订阅推送。",
	});
	assert.match(conflict.failure ?? "", /其他标签页修改，请刷新/);
	assert.equal(
		conflict.notice,
		null,
		"失败时不能继续显示上一次的成功提示",
	);

	const unknown = describeSettingsFeedback({ pending: false, errorStatus: 0, notice: null });
	assert.match(unknown.failure ?? "", /操作失败/);

	// 保存时间的服务端失败（422）同样走统一文案。
	const invalid = describeSettingsFeedback({ pending: false, errorStatus: 422, notice: null });
	assert.match(invalid.failure ?? "", /输入不合法/);
});

test("subscription 视图: 开启请求在途时不能『暂不开启』", () => {
	const pending = describeSettingsFeedback({ pending: true, errorStatus: null, notice: null });
	assert.equal(pending.dismissEnabled, false, "请求在途必须禁用关闭确认区");
	assert.equal(pending.confirmLabel, "正在提交…");

	const idle = describeSettingsFeedback({ pending: false, errorStatus: null, notice: null });
	assert.equal(idle.dismissEnabled, true);
	assert.equal(idle.confirmLabel, "确认开启");
});
