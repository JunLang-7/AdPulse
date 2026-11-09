import assert from "node:assert/strict";
import test from "node:test";
import { emptyChannel, emptyForm, toInput } from "../apps/console/src/views/adpulse/tasks/task-form.ts";
import {
	applyStageSuggestions,
	stageBrief,
	taskStages,
	withSelectedValue,
} from "../apps/console/src/views/adpulse/tasks/task-setup.ts";

test("stage submissions only include the current fields and explicit notes", () => {
	const form = { ...emptyForm, product: "新品试用装", objective: "增加咨询", audience: "老客户" };
	assert.equal(stageBrief(form, taskStages[0], "  有试用材料  "), "产品或服务：新品试用装\n推广目标：增加咨询\n有试用材料");
	assert.equal(stageBrief(form, taskStages[1], "联系人是张三"), "目标人群：老客户\n联系人是张三");
	assert.equal(stageBrief(form, taskStages[2], ""), "");
});

test("stage extraction preserves the name and goal and ignores fields owned by another stage", () => {
	const existing = { ...emptyForm, product: "手填产品", objective: "增加咨询" };
	const next = applyStageSuggestions(existing, "overview", { product: "其他产品", objective: "促进购买", channels: ["抖音"] });
	assert.deepEqual(next, existing);
	const suggested = applyStageSuggestions(emptyForm, "overview", { product: "新品试用装" });
	assert.deepEqual(toInput(suggested).rules, {});
	assert.deepEqual(toInput(suggested).observation, {});
});

test("list suggestions supplement choices without replacing confirmed channel details", () => {
	const existing = { ...emptyForm, product: "新品", audience: "企业客户", channels: [
		{ ...emptyChannel, name: "小红书", budget: "0" },
	] };
	const withAudience = applyStageSuggestions(existing, "audience", {
		audience: ["企业客户", "周女士所在团队"], sellingPoints: ["专业服务"],
	});
	assert.equal(withAudience.audience, "企业客户\n周女士所在团队");
	assert.equal(withAudience.sellingPoints, "专业服务");
	const withChannels = applyStageSuggestions(withAudience, "channels", { channels: ["小红书", "抖音"] });
	assert.deepEqual(toInput(withChannels).strategy.channels, { 小红书: { budget: 0 }, 抖音: {} });
});

test("explicitly removed items stay removed when resubmitting an edited stage", () => {
	const form = { ...emptyForm, product: "新品" };
	const selected = withSelectedValue(form, "channels", "抖音");
	const removed = withSelectedValue(selected, "channels", "抖音");
	const updated = applyStageSuggestions(removed, "channels", { channels: ["抖音", "微信公众号"] }, { channels: ["抖音"] });
	assert.deepEqual(toInput(updated).strategy.channels, { 微信公众号: {} });
	assert.equal(withSelectedValue(withSelectedValue(form, "objective", "增加咨询"), "objective", "促进购买").objective, "促进购买");
});
