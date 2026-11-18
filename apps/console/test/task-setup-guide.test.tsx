// AI 辅助填写：一次请求整理全部字段，结果是一份可逐条勾选的草稿。
// 覆盖：一次拿到全部字段、默认只勾原话、整理不出内容时给填写提示、未选模型时给可行动的报错、
// 以及提交本阶段不再联网。

import { json, serve } from "./harness.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { emptyForm, type FormState } from "../src/views/adpulse/tasks/task-form.ts";
import { assistModeStorageKey, type AssistMode } from "../src/views/adpulse/tasks/task-assist-mode.ts";
import { TaskSetupGuide } from "../src/views/adpulse/tasks/task-setup-guide.tsx";

const rambling = "我是卖瓜子的，然后现在有不少产业园基地，然后还是南瓜子，据说有壮阳的效果，然后就是还有很多员工，福利也很好嘛，咱们的产品也还不错的。你给我想想咋推广？";

/** 跳过首次弹窗：直接当作已经选过填写方式。 */
function rememberMode(mode: AssistMode): void {
	window.localStorage.clear();
	window.localStorage.setItem(assistModeStorageKey, mode);
}

function renderGuide(onChange: (form: FormState) => void = () => {}): void {
	function Guide() {
		const [form, setForm] = useState<FormState>(emptyForm);
		return <TaskSetupGuide form={form} onChange={(value) => { setForm(value); onChange(value); }}
			onEdit={() => {}} onSave={() => {}} onBusyChange={() => {}} saving={false} />;
	}
	render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Guide /></QueryClientProvider>);
}

function typeNote(value: string): void {
	fireEvent.change(screen.getByRole("textbox", { name: "本阶段说明" }), { target: { value } });
}

test("一次整理全部字段：原话默认勾选，AI 建议默认不勾，勾选后一起写入表单", async (t) => {
	t.after(cleanup);
	rememberMode("form");
	const calls: string[] = [];
	serve({
		"POST /api/task-drafts/extract": async (request) => {
			const body = await request.json() as { brief: string; stage?: string };
			calls.push(body.stage ?? "all");
			return json({
				objective: "增加咨询",
				recommendations: {
					product: { value: "南瓜子 500 克罐装", evidence: "还是南瓜子" },
					objectives: ["带动首次购买"],
					audience: ["在意养生的上班族"],
					sellingPoints: ["今年新货、可以先试吃"],
					channels: ["微信视频号"],
				},
			});
		},
	});
	let current = emptyForm;
	renderGuide((form) => { current = form; });
	typeNote(rambling);

	fireEvent.click(screen.getByRole("button", { name: "一次整理全部字段" }));
	await screen.findByText(/可填的内容 · 共 6 条，已选 1 条/);
	// 一次请求就要覆盖全部阶段，不再按 step 逐个问。
	assert.deepEqual(calls, ["all"]);
	assert.equal(screen.getAllByText("原话摘录").length, 1);
	assert.equal(screen.getAllByText("AI 建议").length, 5);
	assert.ok(screen.getByText(/根据原文「还是南瓜子」整理/));
	// 五个字段的建议一次全列出来，不用一步步点。
	for (const label of ["推广目标", "目标人群", "主要卖点", "投放渠道"]) {
		assert.ok(screen.getAllByText(label).length > 0, `要一次列出${label}`);
	}
	assert.equal(current.product, "", "未确认前不写表单");

	fireEvent.click(screen.getByRole("button", { name: "写入表单（1）" }));
	assert.equal(current.objective, "增加咨询");
	assert.equal(current.product, "", "默认不勾 AI 建议的产品名");

	fireEvent.click(screen.getByRole("button", { name: "一次整理全部字段" }));
	await screen.findByText(/可填的内容 · 共 5 条，已选 0 条/);
	fireEvent.click(screen.getByRole("checkbox", { name: /南瓜子 500 克罐装/ }));
	fireEvent.click(screen.getByRole("checkbox", { name: /在意养生的上班族/ }));
	fireEvent.click(screen.getByRole("button", { name: "写入表单（2）" }));
	assert.equal(current.product, "南瓜子 500 克罐装");
	assert.equal(current.audience, "在意养生的上班族");
});

test("整理不出内容时按字段给提示和示例，而不是一句死胡同", async (t) => {
	t.after(cleanup);
	rememberMode("form");
	serve({ "POST /api/task-drafts/extract": () => json({}) });
	renderGuide();
	typeNote("随便写点什么");

	fireEvent.click(screen.getByRole("button", { name: "一次整理全部字段" }));
	await screen.findByText(/还没整理出来的字段/);
	assert.ok(screen.getAllByText(/写清卖的是什么/).length > 0, "要给出产品或服务的填写提示");
	assert.ok(screen.getAllByText(/南瓜子 500 克罐装/).length > 0, "提示要带示例");
	assert.equal(screen.queryByText(/没有可补充的建议/), null);
	assert.equal(screen.queryByRole("button", { name: /写入表单/ }), null);
});

test("没选模型时说清下一步，不给假的建议", async (t) => {
	t.after(cleanup);
	rememberMode("form");
	serve({ "POST /api/task-drafts/extract": () => json({ error: "model_selection_required" }, 409) });
	renderGuide();
	typeNote(rambling);

	fireEvent.click(screen.getByRole("button", { name: "一次整理全部字段" }));
	await screen.findByText("请先选择一个模型，或直接手填。");
	assert.equal(screen.queryByText(/还没整理出来的字段/), null);
});

test("长资料可只用前 2,500 字整理，提交本阶段不再联网", async (t) => {
	t.after(cleanup);
	rememberMode("form");
	const notes = "我想推广云南普洱熟茶。\n" + "这是推广工作的背景资料。".repeat(250);
	const briefs: string[] = [];
	const { calls } = serve({
		"POST /api/task-drafts/extract": async (request) => {
			const body = await request.json() as { brief: string; stage?: string };
			briefs.push(body.brief);
			return json({});
		},
	});
	renderGuide();
	const region = screen.getByRole("region", { name: "AI 辅助填写" });
	const input = region.querySelector('input[type="file"]');
	assert.ok(input);
	fireEvent.change(input, { target: { files: [new File([notes], "long.txt")] } });
	const generate = await within(region).findByRole("button", { name: "用前 2,500 字整理全部" });
	assert.equal(briefs.length, 0);
	fireEvent.click(generate);
	await within(region).findByText(/还没整理出来的字段/);
	assert.deepEqual(briefs, [notes.slice(0, 2_500)]);
	assert.equal(region.querySelector<HTMLTextAreaElement>("textarea")?.value, notes);

	// 提交只在本机校验：不再隐式打模型，也不再替用户写入建议。
	fireEvent.change(screen.getByRole("textbox", { name: /产品或服务名称/ }), { target: { value: "云南普洱熟茶" } });
	fireEvent.click(screen.getByRole("button", { name: "提交本阶段" }));
	await screen.findByRole("heading", { name: "人群与卖点" });
	assert.deepEqual(calls, ["POST /api/task-drafts/extract"]);
});

test("第一次打开先问填写方式，选完记下来，之后可以更换", async (t) => {
	t.after(cleanup);
	window.localStorage.clear();
	const stages: Array<string | undefined> = [];
	serve({
		"POST /api/task-drafts/extract": async (request) => {
			const body = await request.json() as { stage?: string };
			stages.push(body.stage);
			return json({ recommendations: { product: { value: "南瓜子" } } });
		},
	});
	renderGuide();

	// 没选过就先把两种方式解释清楚，必须先选一个。
	await screen.findByRole("heading", { name: "先选一个填写方式" });
	assert.ok(screen.getByText(/两种都能用，只是给建议的节奏不同/));
	assert.ok(screen.getByText("整表单一次给"));
	assert.ok(screen.getByText("按阶段一次次给"));

	fireEvent.click(screen.getByText("按阶段一次次给"));
	assert.equal(window.localStorage.getItem(assistModeStorageKey), "stage");
	assert.equal(screen.queryByRole("heading", { name: "先选一个填写方式" }), null);
	assert.ok(screen.getByRole("button", { name: /填写方式：按阶段一次次给 · 更换/ }));

	// 按阶段模式：请求带 stage，只整理当前这一步。
	typeNote(rambling);
	fireEvent.click(screen.getByRole("button", { name: "整理本阶段" }));
	await screen.findByText(/可填的内容/);
	assert.deepEqual(stages, ["overview"]);

	// 随时可以改回整表单。
	fireEvent.click(screen.getByRole("button", { name: /填写方式：按阶段一次次给 · 更换/ }));
	fireEvent.click(screen.getByText("整表单一次给"));
	assert.equal(window.localStorage.getItem(assistModeStorageKey), "form");
	assert.ok(screen.getByRole("button", { name: "一次整理全部字段" }));
	fireEvent.click(screen.getByRole("button", { name: "一次整理全部字段" }));
	await waitFor(() => assert.deepEqual(stages, ["overview", undefined]));
});

test("记住过的选择不再弹窗，直接沿用", async (t) => {
	t.after(cleanup);
	rememberMode("stage");
	serve({ "POST /api/task-drafts/extract": () => json({}) });
	renderGuide();
	assert.equal(screen.queryByRole("heading", { name: "先选一个填写方式" }), null);
	assert.ok(screen.getByRole("button", { name: /填写方式：按阶段一次次给/ }));
});

test("只写一句提问也能拿到候选建议，而不是只剩提示", async (t) => {
	t.after(cleanup);
	rememberMode("form");
	serve({
		"POST /api/task-drafts/extract": () => json({
			recommendations: { audience: ["在意养生的上班族", "买给父母的中青年"] },
		}),
	});
	renderGuide();
	typeNote("你觉得给谁");

	fireEvent.click(screen.getByRole("button", { name: "一次整理全部字段" }));
	await screen.findByText("在意养生的上班族");
	assert.ok(screen.getByText("买给父母的中青年"));
	assert.ok(screen.getAllByText("AI 建议").length >= 2);
});

test("按阶段整理时，问的是别的字段会提示去哪看", async (t) => {
	t.after(cleanup);
	rememberMode("stage");
	serve({ "POST /api/task-drafts/extract": () => json({}) });
	renderGuide();
	typeNote("你觉得给谁");

	fireEvent.click(screen.getByRole("button", { name: "整理本阶段" }));
	await screen.findByText(/还没整理出来的字段/);
	assert.ok(screen.getByText(/如果你问的是别的字段（比如「给谁」）/));
});
