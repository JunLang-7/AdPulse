// 模型配置窗口（持久连接版）：目录分组、未接通供应商不给假保存、
// 保存后回传本人连接、密钥只写不回显、自定义 API 可保存。

// 必须最先导入：harness 在被测模块求值前安装 fetch 桩。
import { json, serve } from "./harness.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ModelConfigDialog } from "../src/views/adpulse/models/model-config-dialog.tsx";

const catalog = {
	canConnect: true,
	defaultSelection: null,
	providers: [
		{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", supported: true, models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }] },
		{ id: "xiaomi", name: "Xiaomi", baseUrl: "https://api.xiaomimimo.com/v1", supported: true, models: [{ id: "mimo-v2.6-flash", name: "MiMo Flash" }] },
		{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", supported: false, reason: "该供应商使用 openai-responses 原生协议，尚未接通。", models: [] },
	],
	shared: [],
	connections: [],
};

const connectionList = {
	connections: [
		{ id: "4ca3688c-a790-49be-b318-e8b244648bcf", providerId: "mimo", kind: "custom", displayName: "MiMo", baseUrl: "https://api.mimotest.example/v1", protocol: "openai-completions", models: [{ id: "mimo-v2-flash" }], status: "active", version: 1, createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", hasCredential: true },
	],
	preference: { connectionId: null, modelId: null, version: 0 },
};

function renderDialog(onUse: (choice: { connectionId: string; model: string } | { provider: string; model: string }) => void = () => {}): void {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ModelConfigDialog open onOpenChange={() => {}} onUse={onUse} />
		</QueryClientProvider>,
	);
}

const baseRoutes = {
	"GET /api/task-drafts/models": () => json(catalog),
	"GET /api/me/model-connections": () => json(connectionList),
};

test("模型配置：未接通供应商只给原因不给保存", async (t) => {
	t.after(cleanup);
	serve(baseRoutes);
	renderDialog();

	fireEvent.click(await screen.findByRole("button", { name: /OpenAI/ }));

	await screen.findByText("该供应商使用 openai-responses 原生协议，尚未接通。");
	assert.equal(screen.queryByRole("button", { name: "保存并使用" }), null);
	assert.equal(screen.queryByRole("button", { name: "测试连接" }), null);
});

test("模型配置：保存后用于本次任务，密钥不回显且不修改默认模型", async (t) => {
	t.after(cleanup);
	const calls: string[] = [];
	serve(baseRoutes, {
		"POST /api/me/model-connections": async (request) => {
			const body = await request.json() as { providerId: string; kind: string; baseUrl: string; models: { id: string }[]; apiKey: string };
			calls.push(`create:${body.providerId}:${body.kind}:${body.baseUrl}:${body.models[0]?.id}:${body.apiKey}`);
			return json({ ...connectionList.connections[0], providerId: body.providerId, baseUrl: body.baseUrl }, 201);
		},
		"PUT /api/me/model-preferences": async (request) => {
			const body = await request.json() as { connectionId: string; modelId: string };
			calls.push(`preference:${body.connectionId}:${body.modelId}`);
			return json({ connectionId: body.connectionId, modelId: body.modelId, version: 1 });
		},
	});
	let used: { connectionId: string; model: string } | { provider: string; model: string } | undefined;
	renderDialog((choice) => { used = choice; });

	fireEvent.click(await screen.findByRole("button", { name: /Xiaomi/ }));
	const key = await screen.findByPlaceholderText("粘贴你的 API Key");
	assert.equal((key as HTMLInputElement).type, "password");
	assert.equal((screen.getByRole("button", { name: "保存并使用" }) as HTMLButtonElement).disabled, true);

	fireEvent.change(key, { target: { value: "synthetic-personal-key" } });
	fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));

	await waitFor(() => assert.equal(used !== undefined, true));
	assert.deepEqual(used, { connectionId: connectionList.connections[0].id, model: "mimo-v2.6-flash" });
	assert.deepEqual(calls, [
		"create:xiaomi:catalog:https://api.xiaomimimo.com/v1:mimo-v2.6-flash:synthetic-personal-key",
	]);
	assert.equal(screen.queryByDisplayValue("synthetic-personal-key"), null, "密钥不得回显");
});

test("模型配置：自定义 API 可获取模型列表并选用", async (t) => {
	t.after(cleanup);
	const bodies: unknown[] = [];
	serve(baseRoutes, {
		"POST /api/me/model-connections/models": async (request) => {
			bodies.push(await request.json());
			return json({ models: ["mimo-v2-flash", "mimo-v2-pro"] });
		},
	});
	renderDialog();

	fireEvent.click(await screen.findByRole("button", { name: "自定义 API" }));
	fireEvent.change(await screen.findByPlaceholderText("例如：company-gateway"), { target: { value: "company-gateway" } });
	fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1"), { target: { value: "https://gateway.example.com/v1" } });
	fireEvent.change(screen.getByPlaceholderText("粘贴你的 API Key"), { target: { value: "synthetic-gateway-key" } });
	fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));

	await waitFor(() => assert.equal(bodies.length, 1));
	assert.deepEqual(bodies[0], {
		baseUrl: "https://gateway.example.com/v1",
		protocol: "openai-completions",
		apiKey: "synthetic-gateway-key",
	});
	const select = await screen.findByRole("combobox", { name: "发现的模型" });
	assert.equal((select as HTMLSelectElement).value, "mimo-v2-flash");
	assert.deepEqual([...((select as HTMLSelectElement).options)].map((option) => option.value), ["mimo-v2-flash", "mimo-v2-pro"]);
});

test("模型配置：地址修改后忽略晚到的发现结果", async (t) => {
	t.after(cleanup);
	let finish: ((response: Response) => void) | undefined;
	serve(baseRoutes, {
		"POST /api/me/model-connections/models": () => new Promise<Response>((resolve) => { finish = resolve; }),
	});
	renderDialog();
	fireEvent.click(await screen.findByRole("button", { name: "自定义 API" }));
	const address = screen.getByPlaceholderText("https://api.example.com/v1");
	fireEvent.change(address, { target: { value: "https://first.example/v1" } });
	fireEvent.change(screen.getByPlaceholderText("粘贴你的 API Key"), { target: { value: "synthetic-key" } });
	fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
	await waitFor(() => assert.ok(finish));
	fireEvent.change(address, { target: { value: "https://second.example/v1" } });
	fireEvent.change(screen.getByPlaceholderText("例如：mimo-v2-flash"), { target: { value: "manual-model" } });
	finish?.(json({ models: ["old-target-model"] }));
	await waitFor(() => assert.equal((screen.getByRole("button", { name: "获取模型列表" }) as HTMLButtonElement).disabled, false));
	assert.equal(screen.queryByRole("option", { name: "old-target-model" }), null);
	assert.ok(screen.getByDisplayValue("manual-model"));
});

test("模型配置：Responses 协议用于发现与保存，显示原生请求路径", async (t) => {
	t.after(cleanup);
	const protocols: string[] = [];
	serve(baseRoutes, {
		"POST /api/me/model-connections/models": async (request) => {
			protocols.push((await request.json() as { protocol: string }).protocol);
			return json({ models: ["synthetic-model"] });
		},
		"POST /api/me/model-connections": async (request) => {
			const body = await request.json() as { protocol: string };
			protocols.push(body.protocol);
			return json({ ...connectionList.connections[0], protocol: body.protocol }, 201);
		},
	});
	renderDialog();
	fireEvent.click(await screen.findByRole("button", { name: "自定义 API" }));
	fireEvent.change(screen.getByRole("combobox", { name: "API 协议" }), { target: { value: "openai-responses" } });
	assert.ok(screen.getByText(/会请求.*Base URL.*responses/));
	fireEvent.change(screen.getByPlaceholderText("例如：company-gateway"), { target: { value: "gateway" } });
	fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1"), { target: { value: "https://gateway.example/v1" } });
	fireEvent.change(screen.getByPlaceholderText("粘贴你的 API Key"), { target: { value: "synthetic-personal-key" } });
	fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
	await screen.findByRole("combobox", { name: "发现的模型" });
	fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));
	await waitFor(() => assert.deepEqual(protocols, ["openai-responses", "openai-responses"]));
});

test("模型配置：目录模型按 Responses 原生协议保存", async (t) => {
	t.after(cleanup);
	const protocols: string[] = [];
	serve(baseRoutes, {
		"GET /api/task-drafts/models": () => json({ ...catalog, providers: [{
			id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", supported: true,
			models: [{ id: "gpt-4", name: "GPT-4", api: "openai-responses" }],
		}] }),
		"POST /api/me/model-connections": async (request) => {
			protocols.push((await request.json() as { protocol: string }).protocol);
			return json(connectionList.connections[0], 201);
		},
	});
	renderDialog();
	fireEvent.click(await screen.findByRole("button", { name: /OpenAI/ }));
	fireEvent.change(screen.getByPlaceholderText("粘贴你的 API Key"), { target: { value: "synthetic-personal-key" } });
	fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));
	await waitFor(() => assert.deepEqual(protocols, ["openai-responses"]));
});

test("模型配置：Anthropic Messages 用于保存与请求路径提示", async (t) => {
	t.after(cleanup);
	const bodies: { protocol: string }[] = [];
	serve(baseRoutes, {
		"POST /api/me/model-connections": async (request) => {
			const body = await request.json() as { protocol: string };
			bodies.push(body);
			return json({ ...connectionList.connections[0], protocol: body.protocol }, 201);
		},
	});
	renderDialog();
	fireEvent.click(await screen.findByRole("button", { name: "自定义 API" }));
	fireEvent.change(screen.getByRole("combobox", { name: "API 协议" }), { target: { value: "anthropic-messages" } });
	assert.ok(screen.getByText(/会请求.*Base URL.*v1\/messages/));
	fireEvent.change(screen.getByPlaceholderText("例如：company-gateway"), { target: { value: "claude-gateway" } });
	fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1"), { target: { value: "https://claude.example" } });
	fireEvent.change(screen.getByPlaceholderText("例如：mimo-v2-flash"), { target: { value: "synthetic-claude" } });
	fireEvent.change(screen.getByPlaceholderText("粘贴你的 API Key"), { target: { value: "synthetic-personal-key" } });
	fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));
	await waitFor(() => assert.deepEqual(bodies.map((body) => body.protocol), ["anthropic-messages"]));
});

test("模型配置：Gemini 协议用于保存并显示原生请求路径", async (t) => {
	t.after(cleanup);
	const bodies: { protocol: string }[] = [];
	serve(baseRoutes, {
		"POST /api/me/model-connections": async (request) => {
			const body = await request.json() as { protocol: string };
			bodies.push(body);
			return json({ ...connectionList.connections[0], protocol: body.protocol }, 201);
		},
	});
	renderDialog();
	fireEvent.click(await screen.findByRole("button", { name: "自定义 API" }));
	fireEvent.change(screen.getByRole("combobox", { name: "API 协议" }), { target: { value: "google-generative-ai" } });
	assert.ok(screen.getByText(/models\/\{Model ID\}:streamGenerateContent/));
	fireEvent.change(screen.getByPlaceholderText("例如：company-gateway"), { target: { value: "gemini-gateway" } });
	fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1"), { target: { value: "https://generativelanguage.googleapis.com/v1beta" } });
	fireEvent.change(screen.getByPlaceholderText("例如：mimo-v2-flash"), { target: { value: "gemini-2.5-flash" } });
	fireEvent.change(screen.getByPlaceholderText("粘贴你的 API Key"), { target: { value: "synthetic-personal-key" } });
	fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));
	await waitFor(() => assert.deepEqual(bodies.map((body) => body.protocol), ["google-generative-ai"]));
});

test("模型配置：自定义 API 可填写并保存自定义地址", async (t) => {
	t.after(cleanup);
	const bodies: unknown[] = [];
	serve(baseRoutes, {
		"POST /api/me/model-connections": async (request) => {
			bodies.push(await request.json());
			return json({ ...connectionList.connections[0], providerId: "company-gateway", kind: "custom" }, 201);
		},
		"PUT /api/me/model-preferences": () => json({ connectionId: connectionList.connections[0].id, modelId: "mimo-v2-flash", version: 1 }),
	});
	renderDialog();

	fireEvent.click(await screen.findByRole("button", { name: "自定义 API" }));
	fireEvent.change(await screen.findByPlaceholderText("例如：company-gateway"), { target: { value: "company-gateway" } });
	fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1"), { target: { value: "https://gateway.example.com/v1" } });
	fireEvent.change(screen.getByPlaceholderText("例如：mimo-v2-flash"), { target: { value: "internal-model" } });
	fireEvent.change(screen.getByPlaceholderText("粘贴你的 API Key"), { target: { value: "synthetic-gateway-key" } });

	const save = screen.getByRole("button", { name: "保存并使用" }) as HTMLButtonElement;
	assert.equal(save.disabled, false);
	fireEvent.click(save);

	await waitFor(() => assert.equal(bodies.length, 1));
	assert.deepEqual(bodies[0], {
		providerId: "company-gateway",
		kind: "custom",
		baseUrl: "https://gateway.example.com/v1",
		protocol: "openai-completions",
		models: [{ id: "internal-model" }],
		apiKey: "synthetic-gateway-key",
	});
});

test("模型配置：已有连接显示状态，切换模型后可设为默认", async (t) => {
	t.after(cleanup);
	const preferences: unknown[] = [];
	serve(baseRoutes, {
		"PUT /api/me/model-preferences": async (request) => {
			preferences.push(await request.json());
			return json({ connectionId: connectionList.connections[0].id, modelId: "mimo-v2-flash", version: 1 });
		},
	});
	renderDialog();

	fireEvent.click(await screen.findByRole("button", { name: /MiMo/ }));
	await screen.findByText("自定义 API · https://api.mimotest.example/v1");
	assert.equal(screen.queryByPlaceholderText("已保存，如需更换请重新填写") !== null, true, "应允许更换密钥");

	fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
	await waitFor(() => assert.equal(preferences.length, 1));
	assert.deepEqual(preferences[0], {
		expectedVersion: 0,
		connectionId: connectionList.connections[0].id,
		modelId: "mimo-v2-flash",
	});
});

test("模型配置：任务选择和默认设置分开，默认冲突显示失败", async (t) => {
	t.after(cleanup);
	let writes = 0;
	const selected: unknown[] = [];
	serve(baseRoutes, {
		"PUT /api/me/model-preferences": () => {
			writes++;
			return json({ error: "connection_conflict" }, 409);
		},
	});
	renderDialog((value) => selected.push(value));
	fireEvent.click(await screen.findByRole("button", { name: /MiMo/ }));
	fireEvent.click(screen.getByRole("button", { name: "用于本次任务" }));
	assert.equal(selected.length, 1);
	assert.equal(writes, 0);
	fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
	await screen.findByText("默认模型未保存，请重试。");
	assert.equal(writes, 1);
	assert.equal(selected.length, 1);
});

test("模型配置：需要二次验证时给出飞书入口，不显示保存成功", async (t) => {
	t.after(cleanup);
	serve(baseRoutes, {
		"PUT /api/me/model-preferences": () => json({ error: "reauth_required" }, 401),
	});
	renderDialog();
	fireEvent.click(await screen.findByRole("button", { name: /MiMo/ }));
	fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
	const link = await screen.findByRole("link", { name: "用飞书确认身份" });
	assert.match(link.getAttribute("href") ?? "", /^\/auth\/feishu\/login\?reauth=1&returnTo=/);
	assert.equal(screen.queryByText("已设为默认模型"), null);
});

test("模型配置：部署未配置主密钥时提示不可保存，但仍可使用部署提供", async (t) => {
	t.after(cleanup);
	serve(baseRoutes, {
		"GET /api/me/model-connections": () => json({ error: "model connections unavailable" }, 503),
		"GET /api/task-drafts/models": () => json({ ...catalog, shared: [{ provider: "deepseek", model: "deepseek-flash", label: "DeepSeek（部署提供）" }] }),
	});
	renderDialog();

	await screen.findByText(/部署者尚未配置主密钥/);
	fireEvent.click(await screen.findByRole("button", { name: /DeepSeek（部署提供）/ }));
	await screen.findByText(/该模型由部署者配置密钥/);
	assert.equal(screen.queryByRole("button", { name: "保存并使用" }), null);
});
