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
	for (const goal of [goals[0], goals[2]]) fireEvent.click(screen.getByRole("checkbox", { name: goal }));
	fireEvent.click(screen.getByRole("button", { name: "应用所选建议" }));
	assert.equal(current.product, "云南普洱熟茶");
	assert.equal(current.objective, [goals[0], goals[2]].join("\n"));
	fireEvent.click(screen.getByRole("button", { name: "提交本阶段" }));
	await screen.findByRole("heading", { name: "人群与卖点" });
	assert.deepEqual(calls, ["POST /api/task-drafts/extract"]);
});
