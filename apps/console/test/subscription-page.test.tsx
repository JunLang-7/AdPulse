// 组件级交互测试：验证「按钮真的禁用」「提示真的渲染」，不测状态推导。
// 由 `bun run --cwd apps/console test:components` 运行（Node + tsx + jsdom）。

// 必须最先导入：harness 在被测页面模块求值前安装 fetch 桩。
import { json, serve } from "./harness.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import SubscriptionSettingsPage from "../src/views/adpulse/settings/subscriptions/index.tsx";

const subscription = {
	settings: {
		version: 3,
		proactiveEnabled: false,
		schedule: {
			timezone: "Asia/Shanghai",
			digestAt: "09:30",
			quietStart: "22:00",
			quietEnd: "08:00",
		},
		updatedAt: "2026-11-10T01:00:00.000Z",
	},
	targets: [
		{
			id: "6f2b6b1e-1111-4222-8333-444455556666",
			kind: "brand",
			kindLabel: "品牌",
			refId: "某某灯饰",
			label: "某某灯饰",
			categories: ["effect", "event"],
			scope: "task_only",
			status: "active",
			updatedAt: "2026-11-10T01:00:00.000Z",
		},
	],
};

const notification = {
	destination: { status: "verified" },
	consent: { status: "active", version: 1 },
	canSendProactive: true,
};

const defaults = {
	"GET /api/me/subscription": () => json(subscription),
	"GET /api/me/notification-status": () => json(notification),
	"GET /api/tasks": () => json({ items: [] }),
};

function renderPage(): void {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<SubscriptionSettingsPage />
		</QueryClientProvider>,
	);
}

const openConfirm = async (): Promise<void> => {
	fireEvent.click(await screen.findByRole("button", { name: "配置并开启" }));
	await screen.findByText("开启前请确认");
};

test("订阅页：开启请求在途时禁用「暂不开启」", async () => {
	serve(defaults, {
		// 永不返回：模拟慢请求，界面必须停留在「提交中」。
		"PUT /api/me/subscription/settings": () => new Promise<Response>(() => {}),
	});
	renderPage();
	await openConfirm();

	fireEvent.click(screen.getByRole("button", { name: "确认开启" }));

	const dismiss = (await screen.findByRole("button", {
		name: /请稍候/,
	})) as HTMLButtonElement;
	assert.equal(
		dismiss.disabled,
		true,
		"开启请求在途必须禁用「暂不开启」，否则会关掉确认区却让请求落库",
	);
	assert.equal(
		(screen.getByRole("button", { name: "正在提交…" }) as HTMLButtonElement)
			.disabled,
		true,
		"提交中不能重复点击开启",
	);
	cleanup();
});

test("订阅页：开启失败（409）必须显示可见提示并清空旧的成功提示", async () => {
	serve(defaults, {
		"PUT /api/me/subscription/settings": () =>
			json({ error: "subscription_conflict" }, 409),
	});
	renderPage();
	await openConfirm();

	fireEvent.click(screen.getByRole("button", { name: "确认开启" }));

	const alert = await screen.findByRole("alert");
	assert.match(alert.textContent ?? "", /其他标签页修改，请刷新/);
	assert.equal(
		screen.queryByText("已开启订阅推送。"),
		null,
		"失败时不能同时显示上一次的成功提示",
	);
	assert.equal(
		screen.queryByText("已选择暂不开启；不会发送任何主动推送。"),
		null,
	);
	cleanup();
});

test("订阅页：保存时间失败（422）同样给出可见提示", async () => {
	serve(defaults, {
		"PUT /api/me/subscription/settings": () =>
			json({ error: "invalid_schedule" }, 422),
	});
	renderPage();
	await screen.findByText("推送时间");

	fireEvent.click(screen.getByRole("button", { name: "保存时间" }));

	const alert = await screen.findByRole("alert");
	assert.match(alert.textContent ?? "", /输入不合法/);
	cleanup();
});

test("订阅页：本地校验拦住非法时段，不发出请求", async () => {
	const { calls } = serve(defaults);
	renderPage();
	await screen.findByText("推送时间");

	// 汇总时间改成免打扰区间内（23:00），前端应直接拒绝。
	const digest = screen.getByLabelText("汇总时间") as HTMLInputElement;
	fireEvent.change(digest, { target: { value: "23:00" } });
	fireEvent.click(screen.getByRole("button", { name: "保存时间" }));

	const alert = await screen.findByRole("alert");
	assert.match(alert.textContent ?? "", /不能落在免打扰时段内/);
	assert.equal(
		calls.includes("PUT /api/me/subscription/settings"),
		false,
		"前端校验失败不应发请求",
	);
	cleanup();
});

test("订阅页：品牌名称留空时不提交，给出字段级提示", async () => {
	const { calls } = serve(defaults);
	renderPage();
	await screen.findByText("添加关注对象");

	fireEvent.click(screen.getByRole("button", { name: "品牌" }));
	fireEvent.click(screen.getByRole("button", { name: "添加" }));

	assert.match((await screen.findByRole("alert")).textContent ?? "", /请填写名称/);
	assert.equal(calls.includes("POST /api/me/subscription/targets"), false);
	cleanup();
});
