import assert from "node:assert/strict";
import test from "node:test";
import type { components } from "../apps/console/src/generated/api.js";
import { emptyChannel, emptyForm, fromVersion, toInput } from "../apps/console/src/views/adpulse/tasks/task-form.ts";

test("a product name is enough to create a promotion task", () => {
	assert.deepEqual(toInput({ ...emptyForm, product: " 新品试用装 " }), {
		product: "新品试用装",
		strategy: { objective: "", audience: [], channels: {}, sellingPoints: [] },
		observation: {},
		rules: {},
	});
	assert.throws(() => toInput({ ...emptyForm, product: " " }), /产品或服务名称/);
});

test("channel fields distinguish zero, paused and unconfirmed values", () => {
	const result = toInput({
		...emptyForm,
		product: "测试任务",
		channels: [
			{ ...emptyChannel, name: "小红书", budget: "0", enabled: "paused" },
			{ ...emptyChannel, name: "抖音", bidCpc: ".5" },
			emptyChannel,
		],
	});
	assert.deepEqual(result.strategy.channels, {
		小红书: { budget: 0, enabled: false },
		抖音: { bidCpc: 0.5 },
	});
});

test("Beijing times convert to UTC and RMB entry converts exactly to minor amounts", () => {
	const result = toInput({
		...emptyForm,
		product: "测试任务",
		startsAt: "2026-11-08T00:15",
		endsAt: "2026-11-09T12:30",
		moneyMode: "cny",
		alertThreshold: "70.19",
		minimumSpend: "0",
	});
	assert.deepEqual(result.observation, {
		startsAt: "2026-11-07T16:15:00.000Z",
		endsAt: "2026-11-09T04:30:00.000Z",
	});
	assert.deepEqual(result.rules, {
		currency: "CNY", unit: "分", alertThresholdMinor: 7019, minimumSpendMinor: 0,
	});
});

test("editing a legacy task preserves channel keys, time precision and report units", () => {
	const task: components["schemas"]["TaskVersion"] = {
		id: "task:1", taskId: "task", version: 1, createdAt: "2026-11-08T00:00:00.000Z",
		product: "旧任务",
		strategy: { objective: "", audience: [], sellingPoints: [], channels: {
			"legacy channel": { budget: 0, bidCpc: 1e-7, enabled: false },
		} },
		observation: { startsAt: "2026-11-08T17:09:43.123Z" },
		rules: { currency: "USD", unit: "cent", alertThresholdMinor: 223 },
	};
	const form = fromVersion(task);
	assert.equal(form.startsAt, "2026-11-09T01:09:43.123");
	assert.equal(form.moneyMode, "report");
	const saved = toInput({ ...form, product: "修订任务" });
	assert.deepEqual(saved.observation, task.observation);
	assert.deepEqual(saved.rules, task.rules);
	assert.deepEqual(saved.strategy, task.strategy);
	const yuan = fromVersion({ ...task, rules: { currency: "CNY", unit: "分", alertThresholdMinor: 0, minimumSpendMinor: 12300 } });
	assert.equal(yuan.alertThreshold, "0");
	assert.equal(yuan.minimumSpend, "123");
	assert.equal(toInput(yuan).rules.minimumSpendMinor, 12300);
});

test("invalid dates, amounts and duplicate channels get plain-language errors", () => {
	const form = { ...emptyForm, product: "测试任务" };
	assert.throws(() => toInput({ ...form, startsAt: "2026-02-30T00:00" }), /有效的北京时间/);
	assert.throws(() => toInput({ ...form, startsAt: "2026-11-09T00:00", endsAt: "2026-11-08T00:00" }), /结束时间不能早于/);
	assert.throws(() => toInput({ ...form, moneyMode: "cny", alertThreshold: "7.119" }), /两位小数/);
	assert.throws(() => toInput({ ...form, channels: [{ ...emptyChannel, name: "小红书", budget: "0x10" }] }), /预算请填写/);
	const row = { ...emptyChannel, name: "小红书" };
	assert.throws(() => toInput({ ...form, channels: [row, row] }), /渠道.*重复/);
});
