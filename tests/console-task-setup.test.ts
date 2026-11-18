import assert from "node:assert/strict";
import test from "node:test";
import { emptyChannel, emptyForm, toInput } from "../apps/console/src/views/adpulse/tasks/task-form.ts";
import {
	applyTaskSuggestions,
	emptyNotes,
	fieldHints,
	fieldLabels,
	missingFields,
	setupBrief,
	suggestionKey,
	taskSuggestions,
	withSelectedValue,
} from "../apps/console/src/views/adpulse/tasks/task-setup.ts";

test("the brief covers all three stages at once, skipping what is still empty", () => {
	const form = {
		...emptyForm,
		product: "南瓜子 500 克罐装",
		objective: "增加咨询",
		audience: "老客户",
		sellingPoints: "今年新货",
		channels: [{ ...emptyChannel, name: "抖音" }],
	};
	assert.equal(setupBrief(form, { overview: "  我是卖瓜子的  ", audience: "面向本地顾客", channels: "" }), [
		"产品或服务：南瓜子 500 克罐装",
		"推广目标：增加咨询",
		"目标人群：老客户",
		"主要卖点：今年新货",
		"投放渠道：抖音",
		"我是卖瓜子的",
		"面向本地顾客",
	].join("\n"));
	assert.equal(setupBrief(emptyForm, emptyNotes), "");
});

test("missing fields drive the filling hints instead of a dead end", () => {
	assert.deepEqual(missingFields({ ...emptyForm, product: "南瓜子" }), ["objective", "audience", "sellingPoints", "channels"]);
	assert.deepEqual(missingFields({ ...emptyForm, product: "南瓜子", objective: "增加咨询", audience: "老客户", sellingPoints: "今年新货", channels: [{ ...emptyChannel, name: "抖音" }] }), []);
});

test("one response becomes one checklist across every field", () => {
	const form = { ...emptyForm, product: "南瓜子", audience: "老客户" };
	const items = taskSuggestions(form, {
		product: "南瓜子",
		objective: "增加咨询",
		sellingPoints: ["今年新货"],
		channels: ["抖音"],
		recommendations: {
			product: { value: "南瓜子 500 克罐装", evidence: "南瓜子" },
			objectives: ["带动首次购买"],
			audience: ["老客户", "写字楼里的上班族"],
			sellingPoints: ["可以先试吃一小包"],
			channels: ["抖音", "小红书"],
		},
	});
	assert.deepEqual(items, [
		{ field: "objective", value: "增加咨询", source: "quote" },
		{ field: "sellingPoints", value: "今年新货", source: "quote" },
		{ field: "channels", value: "抖音", source: "quote" },
		{ field: "objective", value: "带动首次购买", source: "idea" },
		{ field: "audience", value: "写字楼里的上班族", source: "idea" },
		{ field: "sellingPoints", value: "可以先试吃一小包", source: "idea" },
		{ field: "channels", value: "小红书", source: "idea" },
	]);
	const keys = items.map(suggestionKey);
	assert.equal(new Set(keys).size, keys.length, "每条建议要有稳定的唯一键");
});

test("a recommended product only appears when the field is still empty", () => {
	const data = {
		recommendations: {
			product: { value: "南瓜子" },
			objectives: ["带动首次购买"],
		},
	};
	assert.deepEqual(taskSuggestions(emptyForm, data), [
		{ field: "product", value: "南瓜子", source: "idea" },
		{ field: "objective", value: "带动首次购买", source: "idea" },
	]);
	assert.deepEqual(taskSuggestions({ ...emptyForm, product: "南瓜子" }, data), [
		{ field: "objective", value: "带动首次购买", source: "idea" },
	]);
});

test("explicitly removed choices never come back as suggestions", () => {
	const form = { ...emptyForm, product: "新品" };
	const selected = withSelectedValue(form, "channels", "抖音");
	const removed = withSelectedValue(selected, "channels", "抖音");
	assert.deepEqual(
		taskSuggestions(removed, { recommendations: { channels: ["抖音", "微信公众号"] } }, { channels: ["抖音"] }),
		[{ field: "channels", value: "微信公众号", source: "idea" }],
	);
});

test("confirming picked items fills a partial form without dropping typed values", () => {
	const form = {
		...emptyForm,
		audience: "老客户",
		channels: [{ ...emptyChannel, name: "抖音", budget: "300" }],
	};
	const items = taskSuggestions(form, {
		recommendations: {
			product: { value: "南瓜子 500 克罐装" },
			objectives: ["增加咨询", "带动首次购买"],
			audience: ["老客户", "本地顾客"],
			sellingPoints: ["今年新货"],
			channels: ["抖音", "小红书"],
		},
	});
	const next = applyTaskSuggestions(form, items);
	assert.equal(next.product, "南瓜子 500 克罐装");
	assert.equal(next.objective, "增加咨询\n带动首次购买");
	assert.equal(next.audience, "老客户\n本地顾客");
	assert.equal(next.sellingPoints, "今年新货");
	assert.deepEqual(toInput(next).strategy.channels, { 抖音: { budget: 300 }, 小红书: {} });
});

test("multiple promotion objectives retain order and old free text", () => {
	const existing = { ...emptyForm, product: "新品", objective: "原有目标、补充说明" };
	const selected = withSelectedValue(withSelectedValue(existing, "objective", "增加咨询"), "objective", "促进购买");
	assert.equal(toInput(selected).strategy.objective, "原有目标、补充说明\n增加咨询\n促进购买");
	const revised = withSelectedValue(selected, "objective", "增加咨询");
	assert.equal(toInput(revised).strategy.objective, "原有目标、补充说明\n促进购买");
	assert.match(setupBrief(revised, emptyNotes), /原有目标、补充说明、促进购买/);
});

test("every field ships a filling hint with an example", () => {
	for (const field of Object.keys(fieldLabels) as (keyof typeof fieldLabels)[]) {
		assert.ok(fieldHints[field].hint.length > 8, `${field} 需要一句能照做的提示`);
		assert.match(fieldHints[field].example, /^例如：/);
	}
	// 食品不得在卖点里写功效：提示必须明确挡住这类写法。
	assert.match(fieldHints.sellingPoints.hint, /不要写功效/);
});
