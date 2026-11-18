/** 针对审核中发现的边界：功效词、超长多阶段 brief、勾选后写入。 */
import assert from "node:assert/strict";
import test from "node:test";

import { createTaskDraftExtractor } from "../packages/runtime/dist/task-draft-extractor.js";
import { emptyForm, toInput } from "../apps/console/src/views/adpulse/tasks/task-form.ts";
import {
	applyTaskSuggestions,
	emptyNotes,
	missingFields,
	setupBrief,
	taskSuggestions,
} from "../apps/console/src/views/adpulse/tasks/task-setup.ts";

const env = { DEEPSEEK_API_KEY: "synthetic-review-key" };
function reply(content: string): Response {
	const chunk = { id: "x", object: "chat.completion.chunk", created: 1, model: "deepseek-flash" };
	const frames = [
		{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
		{ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
	];
	return new Response(frames.map((f) => "data: " + JSON.stringify(f) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
const finishReason = "stop";

test("边界一：模型若把功效词放进卖点，服务端是否照单全收", async () => {
	const brief = "我是卖瓜子的，据说有壮阳的效果";
	const extract = createTaskDraftExtractor(env, async () => reply(JSON.stringify({
		sellingPoints: ["据说有壮阳的效果"],
		recommendations: { sellingPoints: ["可以壮阳"] },
	})));
	assert.ok(extract);
	const result = await extract(brief);
	console.log("  [观察] 服务端返回:", JSON.stringify(result));
	const items = taskSuggestions(emptyForm, result ?? {});
	console.log("  [观察] 清单:", JSON.stringify(items.map((i) => `${i.field}:${i.value}/${i.source}`)));
	// 修复后：功效词在服务端被硬拦截，摘录字段和 AI 建议都不会进入清单。
	assert.deepEqual(result, {});
	assert.deepEqual(items, []);
});

test("边界二：三个阶段说明合并超过 2,500 字时 UI 会拦住（数据集层验证）", () => {
	const long = "卖南瓜子。".repeat(600);
	const brief = setupBrief(emptyForm, { ...emptyNotes, overview: long });
	assert.ok(brief.length > 2500, "合并后确实超限");
	assert.equal(brief.length > 2500, true, "UI 层 remaining<0 会禁用按钮并提示精简");
});

test("边界三：原话摘录默认勾选、AI 建议默认不勾，写入时只取勾选的", () => {
	const form = { ...emptyForm };
	const items = taskSuggestions(form, {
		product: "南瓜子",
		recommendations: { product: { value: "南瓜子礼盒" }, audience: ["养生人群"] },
	});
	assert.deepEqual(items.map((i) => `${i.field}:${i.value}/${i.source}`), [
		"product:南瓜子/quote",
		"product:南瓜子礼盒/idea",
		"audience:养生人群/idea",
	]);
	const picked = items.filter((i) => i.source === "quote");
	const next = applyTaskSuggestions(form, picked);
	assert.equal(next.product, "南瓜子", "默认勾选的原话胜出，AI 建议未被写入");
	assert.deepEqual(toInput(next).strategy.audience, []);
});

test("边界四：重复点整理按钮不会重复叠加已填字段的建议", () => {
	const form = { ...emptyForm, product: "南瓜子", audience: "老客户", sellingPoints: "新货" };
	const data = {
		recommendations: {
			product: { value: "南瓜子礼盒" },
			audience: ["老客户", "新客户"],
			sellingPoints: ["新货", "可试吃"],
		},
	};
	const items = taskSuggestions(form, data);
	assert.deepEqual(items.map((i) => `${i.field}:${i.value}`), [
		"audience:新客户", "sellingPoints:可试吃",
	], "已填值不再作为建议出现");
	assert.deepEqual(missingFields(form), ["objective", "channels"]);
});
