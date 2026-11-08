import assert from "node:assert/strict";
import test from "node:test";
import { emptyChannel, emptyForm, toInput } from "../apps/console/src/views/adpulse/tasks/task-form.ts";
import {
	addGuideAnswer,
	applyTaskSuggestions,
	guideQuestions,
	nextGuideQuestion,
} from "../apps/console/src/views/adpulse/tasks/task-setup.ts";

test("guided task setup needs only the name, and skip never creates a value", () => {
	assert.equal(guideQuestions[nextGuideQuestion(emptyForm)]?.field, "product");
	assert.throws(() => addGuideAnswer(emptyForm, "product", "  "), /填个名称/);
	const named = addGuideAnswer(emptyForm, "product", " 新品试用装 ");
	assert.equal(guideQuestions[nextGuideQuestion(named, 0)]?.field, "objective");
	assert.equal(addGuideAnswer(named, "objective", ""), named);
	assert.deepEqual(toInput(named), {
		product: "新品试用装",
		strategy: { objective: "", audience: [], channels: {}, sellingPoints: [] },
		observation: {},
		rules: {},
	});
});

test("suggestions fill only missing fields and keep money and time unconfirmed", () => {
	const existing = { ...emptyForm, product: "人工填写", audience: "已知受众" };
	const suggested = applyTaskSuggestions(existing, {
		product: "模型建议",
		objective: "更多咨询",
		audience: ["不同人群"],
		sellingPoints: ["试用"],
		channels: ["小红书"],
	});
	assert.equal(suggested.product, "人工填写");
	assert.equal(suggested.audience, "已知受众");
	assert.equal(suggested.objective, "更多咨询");
	assert.equal(suggested.sellingPoints, "试用");
	assert.deepEqual(toInput(suggested).strategy.channels, { 小红书: {} });
	assert.deepEqual(toInput(suggested).observation, {});
	assert.deepEqual(toInput(suggested).rules, {});
	assert.equal(nextGuideQuestion(suggested), -1);
});

test("the guide skips known answers and preserves any existing channel budget", () => {
	const existing = {
		...emptyForm,
		channels: [{ ...emptyChannel, name: "小红书", budget: "0" }],
	};
	const draft = applyTaskSuggestions(existing, { product: "新品", audience: ["通勤人群"], channels: ["其他渠道"] });
	assert.equal(guideQuestions[nextGuideQuestion(draft)]?.field, "objective");
	const answered = addGuideAnswer(draft, "channels", "小红书、抖音，抖音");
	assert.deepEqual(toInput(answered).strategy.channels, { 小红书: { budget: 0 }, 抖音: {} });
});
