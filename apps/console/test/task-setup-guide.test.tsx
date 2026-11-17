import { json, serve } from "./harness.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { emptyForm, type FormState } from "../src/views/adpulse/tasks/task-form.ts";
import { TaskSetupGuide } from "../src/views/adpulse/tasks/task-setup-guide.tsx";

test("辅助填写：模型暂时不可用时保留普洱茶资料，换模型后可核对并应用", async (t) => {
	t.after(cleanup);
	const note = "我想推广茶叶，是那种云南普洱，熟普";
	const shared = { provider: "deepseek", model: "deepseek-flash", label: "DeepSeek（部署提供）" };
	serve({
		"GET /api/task-drafts/models": () => json({ providers: [], shared: [shared], connections: [], canConnect: false, defaultSelection: null }),
		"GET /api/me/model-connections": () => json({ connections: [], preference: { connectionId: null, modelId: null, version: 0 } }),
		"POST /api/task-drafts/extract": async (request) => {
			const body = await request.json() as { brief: string; provider?: string; model?: string };
			assert.ok(body.brief.includes(note));
			return body.provider === shared.provider && body.model === shared.model
				? json({ product: "云南普洱，熟普" })
				: json({ error: "task draft extraction unavailable" }, 503);
		},
	});

	const changes: FormState[] = [];
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={client}>
		<TaskSetupGuide form={emptyForm} onChange={(form) => { changes.push(form); }} onEdit={() => {}}
			onSave={() => {}} onBusyChange={() => {}} saving={false} />
	</QueryClientProvider>);

	const helper = within(screen.getByRole("region", { name: "AI 辅助填写" }));
	const notes = helper.getByRole("textbox", { name: "本阶段说明" });
	assert.ok(helper.getByRole("button", { name: "选择资料文件" }));
	fireEvent.change(notes, { target: { value: note } });
	fireEvent.click(helper.getByRole("button", { name: "生成建议" }));
	await screen.findByText(/请检查模型配置、换一个模型重试/);
	assert.equal(screen.getByDisplayValue(note), notes);
	assert.equal(changes.length, 0);

	fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
	fireEvent.click(await screen.findByRole("button", { name: /DeepSeek（部署提供）/ }));
	fireEvent.click(await screen.findByRole("button", { name: "使用此模型" }));
	assert.equal(screen.queryByRole("alert"), null);
	assert.equal(screen.getByDisplayValue(note), notes);

	fireEvent.click(helper.getByRole("button", { name: "生成建议" }));
	await screen.findByText("产品或服务 · 云南普洱，熟普");
	assert.equal(changes.length, 0);
	fireEvent.click(screen.getByRole("button", { name: "应用建议" }));
	assert.equal(changes[0]?.product, "云南普洱，熟普");
});

test("提交推广内容先确认整理出的熟茶名称，并允许从目标建议中多选", async (t) => {
	t.after(cleanup);
	const note = "我想推广茶叶，是那种云南普洱，熟普";
	const goals = ["带动茶友首次购买", "增加熟普冲泡咨询", "鼓励老顾客复购"];
	const { calls } = serve({
		"POST /api/task-drafts/extract": () => json({
			product: "云南普洱，熟普",
			recommendations: { product: { value: "云南普洱熟茶", evidence: "云南普洱，熟普" }, objectives: goals },
		}),
	});
	let current = emptyForm;
	function Guide() {
		const [form, setForm] = useState(emptyForm);
		return <TaskSetupGuide form={form} onChange={(value) => { current = value; setForm(value); }}
			onEdit={() => {}} onSave={() => {}} onBusyChange={() => {}} saving={false} />;
	}
	const client = new QueryClient();
	render(<QueryClientProvider client={client}><Guide /></QueryClientProvider>);

	fireEvent.change(screen.getByRole("textbox", { name: "本阶段说明" }), { target: { value: note } });
	fireEvent.click(screen.getByRole("button", { name: "提交本阶段" }));
	await screen.findByRole("checkbox", { name: /云南普洱熟茶/ });
	assert.equal(current.product, "");
	assert.equal(current.objective, "");
	assert.equal(screen.queryByText("产品或服务 · 云南普洱，熟普"), null);
	for (const goal of goals) assert.equal(screen.getByRole<HTMLInputElement>("checkbox", { name: goal }).checked, true);
	fireEvent.click(screen.getByRole("checkbox", { name: goals[1] }));
	fireEvent.click(screen.getByRole("button", { name: "应用所选建议" }));
	assert.equal(current.product, "云南普洱熟茶");
	assert.equal(current.objective, [goals[0], goals[2]].join("\n"));
	fireEvent.click(screen.getByRole("button", { name: "提交本阶段" }));
	await screen.findByRole("heading", { name: "人群与卖点" });
	assert.deepEqual(calls, ["POST /api/task-drafts/extract"]);
});

test("口语化描述里整理出的名称和目标作为建议填入表单待核对", async (t) => {
	t.after(cleanup);
	const note = "我是卖瓜子的，然后现在有不少产业园基地，然后还是南瓜子，据说有壮阳的效果，然后就是还有很多员工，福利也很好嘛，然后咱们的产品也还不错的，。你给我想想咋推广？";
	serve({
		"POST /api/task-drafts/extract": () => json({
			recommendations: {
				product: { value: "南瓜子" },
				objectives: ["提升南瓜子销量", "吸引新客户购买"],
			},
		}),
	});
	let current = emptyForm;
	function Guide() {
		const [form, setForm] = useState(emptyForm);
		return <TaskSetupGuide form={form} onChange={(value) => { current = value; setForm(value); }}
			onEdit={() => {}} onSave={() => {}} onBusyChange={() => {}} saving={false} />;
	}
	render(<QueryClientProvider client={new QueryClient()}><Guide /></QueryClientProvider>);

	fireEvent.change(screen.getByRole("textbox", { name: "本阶段说明" }), { target: { value: note } });
	fireEvent.click(screen.getByRole("button", { name: "生成建议" }));
	await screen.findByRole("checkbox", { name: /建议名称 · 南瓜子/ });
	assert.equal(current.product, "");
	assert.equal(current.objective, "");
	fireEvent.click(screen.getByRole("checkbox", { name: "吸引新客户购买" }));
	fireEvent.click(screen.getByRole("button", { name: "应用所选建议" }));
	assert.equal(current.product, "南瓜子");
	assert.equal(current.objective, "提升南瓜子销量");
});

test("人群阶段的建议会成为待核对项，而不是直接改写表单", async (t) => {
	t.after(cleanup);
	const note = "南瓜子主要卖给注重健康的人和春节备货的家庭";
	serve({
		"POST /api/task-drafts/extract": async (request) => {
			const body = await request.json() as { stage: string };
			return body.stage === "audience"
				? json({ recommendations: { audience: ["送礼人群"], sellingPoints: ["基地直供"] } })
				: json({});
		},
	});
	let current = { ...emptyForm, product: "南瓜子" };
	function Guide() {
		const [form, setForm] = useState(current);
		return <TaskSetupGuide form={form} onChange={(value) => { current = value; setForm(value); }}
			onEdit={() => {}} onSave={() => {}} onBusyChange={() => {}} saving={false} />;
	}
	render(<QueryClientProvider client={new QueryClient()}><Guide /></QueryClientProvider>);

	fireEvent.click(screen.getByRole("button", { name: "提交本阶段" }));
	await screen.findByRole("heading", { name: "人群与卖点" });
	fireEvent.change(screen.getByRole("textbox", { name: "本阶段说明" }), { target: { value: note } });
	fireEvent.click(screen.getByRole("button", { name: "生成建议" }));
	await screen.findByRole("checkbox", { name: /人群建议 · 送礼人群/ });
	assert.equal(current.audience, "");
	fireEvent.click(screen.getByRole("button", { name: "应用所选建议" }));
	assert.equal(current.audience, "送礼人群");
	assert.equal(current.sellingPoints, "基地直供");
});

test("长资料先预览，可只用前 2,500 字生成建议并继续下一阶段", async (t) => {
	t.after(cleanup);
	const notes = "我想推广云南普洱熟茶。\n" + "这是推广工作的背景资料。".repeat(250);
	const form = { ...emptyForm, product: "云南普洱熟茶" };
	const briefs: string[] = [];
	serve({
		"POST /api/task-drafts/extract": async (request) => {
			const body = await request.json() as { brief: string };
			briefs.push(body.brief);
			return json({});
		},
	});
	render(<QueryClientProvider client={new QueryClient()}>
		<TaskSetupGuide form={form} onChange={() => {}} onEdit={() => {}}
			onSave={() => {}} onBusyChange={() => {}} saving={false} />
	</QueryClientProvider>);

	const region = screen.getByRole("region", { name: "AI 辅助填写" });
	const input = region.querySelector('input[type="file"]');
	assert.ok(input);
	fireEvent.change(input, { target: { files: [new File([notes], "long.txt")] } });
	const generate = await within(region).findByRole("button", { name: "用前 2,500 字生成建议" });
	assert.equal(briefs.length, 0);
	fireEvent.click(generate);
	await within(region).findByText(/没有可补充的建议/);
	assert.deepEqual(briefs, [("产品或服务：云南普洱熟茶\n" + notes).slice(0, 2_500)]);
	assert.equal(region.querySelector<HTMLTextAreaElement>("textarea")?.value, notes);
	fireEvent.click(screen.getByRole("button", { name: "提交本阶段" }));
	await screen.findByRole("heading", { name: "人群与卖点" });
	assert.equal(briefs.length, 1);
});
