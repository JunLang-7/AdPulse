// 模型配置窗口的交互测试：目录分组、未接通供应商不给假保存、密钥只写、保存后回传选择。
// 由 `bun run --cwd apps/console test:components` 运行（Node + tsx + jsdom）。

// 必须最先导入：harness 在被测模块求值前安装 fetch 桩。
import { json, serve } from "./harness.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ModelConfigDialog } from "../src/views/adpulse/models/model-config-dialog.tsx";

const catalog = {
	canConnect: true,
	defaultSelection: { provider: "deepseek", model: "deepseek-flash" },
	providers: [
		{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", supported: true, models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }] },
		{ id: "xiaomi", name: "Xiaomi", baseUrl: "https://api.xiaomimimo.com/v1", supported: true, models: [{ id: "mimo-v2.6-flash", name: "MiMo Flash" }] },
		{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", supported: false, reason: "该供应商使用 openai-responses 原生协议，尚未接通。", models: [] },
	],
	shared: [],
	connections: [],
};

const defaults = {
	"GET /api/task-drafts/models": () => json(catalog),
};

function renderDialog(onUse: (selection: { provider: string; model: string }) => void = () => {}): void {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ModelConfigDialog open onOpenChange={() => {}} onUse={onUse} />
		</QueryClientProvider>,
	);
}

test("模型配置：按目录展示供应商，未接通项只给原因不给保存", async (t) => {
	t.after(cleanup);
	serve(defaults);
	renderDialog();

	fireEvent.click(await screen.findByRole("button", { name: /OpenAI/ }));

	await screen.findByText("该供应商使用 openai-responses 原生协议，尚未接通。");
	assert.equal(screen.queryByRole("button", { name: "保存并使用" }), null);
	assert.equal(screen.queryByRole("button", { name: "测试连接" }), null);
});

test("模型配置：密钥只写，保存时提交供应商与模型并回传选择", async (t) => {
	t.after(cleanup);
	const calls: string[] = [];
	serve(defaults, {
		"PUT /api/task-drafts/models": async (request) => {
			const body = await request.json() as { provider: string; model: string; apiKey: string };
			calls.push(`${body.provider}/${body.model}/${body.apiKey}`);
			return json({
				...catalog,
				connections: [{ provider: body.provider, model: body.model, label: "Xiaomi · MiMo Flash", connectedAt: "2026-11-12T00:00:00.000Z" }],
			});
		},
	});
	let used: { provider: string; model: string } | undefined;
	renderDialog((selection) => { used = selection; });

	fireEvent.click(await screen.findByRole("button", { name: /Xiaomi/ }));
	const key = await screen.findByPlaceholderText("粘贴你的 API Key");
	assert.equal((key as HTMLInputElement).type, "password");
	assert.equal((screen.getByRole("button", { name: "保存并使用" }) as HTMLButtonElement).disabled, true);

	fireEvent.change(key, { target: { value: "synthetic-personal-key" } });
	fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));

	await waitFor(() => assert.deepEqual(used, { provider: "xiaomi", model: "mimo-v2.6-flash" }));
	assert.deepEqual(calls, ["xiaomi/mimo-v2.6-flash/synthetic-personal-key"]);
	assert.equal(screen.queryByDisplayValue("synthetic-personal-key"), null, "密钥不得回显");
});

test("模型配置：自定义 API 明确说明本期不开放保存", async (t) => {
	t.after(cleanup);
	serve(defaults);
	renderDialog();

	fireEvent.click(await screen.findByRole("button", { name: "自定义 API" }));

	await screen.findByText(/自定义 API 需要服务端受控出网/);
	assert.equal(screen.queryByRole("button", { name: "保存并使用" }), null);
});
