// 组件级交互测试：验证「理由真的渲染」「空态与加载更多真的按状态出现」。
// 由 `bun run --cwd apps/console test:components` 运行（Node + tsx + jsdom）。

// 必须最先导入：harness 在被测页面模块求值前安装 fetch 桩。
import { json, serve } from "./harness.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import NotificationRecordsPage from "../src/views/adpulse/settings/notification-records/index.tsx";

const subscription = {
	settings: {
		version: 4,
		proactiveEnabled: true,
		schedule: {
			timezone: "Asia/Shanghai",
			digestAt: "09:30",
			quietStart: "22:00",
			quietEnd: "08:00",
		},
	},
	targets: [
		{
			id: "6f2b6b1e-1111-4222-8333-444455556666",
			kind: "brand",
			kindLabel: "品牌",
			refId: "某某灯饰",
			label: "某某灯饰",
			categories: ["effect"],
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

const item = (title: string, status: string) => ({
	id: `user-a:${title}`,
	kind: "effect_alert",
	title,
	summary: "近 3 天咨询成本上升 35%。",
	relevance: "与你关注的任务「护眼台灯」相关。",
	sources: [{ label: "投放后台", publishedAt: null }],
	revision: 1,
	status,
	createdAt: "2026-11-12T01:00:00.000Z",
	updatedAt: "2026-11-12T01:00:00.000Z",
});

const defaults = {
	"GET /api/me/subscription": () => json(subscription),
	"GET /api/me/notification-status": () => json(notification),
};

function renderPage(): void {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<NotificationRecordsPage />
		</QueryClientProvider>,
	);
}

test("通知记录页：已取消批次显示原因，且不冒充「平台已接收」", async () => {
	serve(defaults, {
		"GET /api/me/notifications": () =>
			json({
				records: [
					{
						id: "digest:user-a:2026-11-11",
						kind: "digest",
						localDate: "2026-11-11",
						status: "cancelled",
						statusReason: "push_disabled",
						scheduledAt: "2026-11-11T01:30:00.000Z",
						settingsVersion: 4,
						createdAt: "2026-11-11T01:00:00.000Z",
						updatedAt: "2026-11-11T01:30:00.000Z",
						items: [item("已取消的汇总", "cancelled")],
						delivery: null,
					},
				],
				nextBefore: null,
			}),
	});
	renderPage();

	assert.ok(await screen.findByText("11月11日 每日汇总"));
	assert.ok(
		screen.getAllByText("已取消").length >= 1,
		"批次状态与条目状态都标为已取消",
	);
	assert.ok(await screen.findByTestId("notification-record-reason"));
	assert.ok(screen.getByText("当时关闭了主动提醒"));
	assert.equal(
		screen.queryByTestId("notification-record-delivery"),
		null,
		"从没投递就不显示回执说明",
	);
	assert.equal(
		screen.queryByRole("button", { name: "加载更早的记录" }),
		null,
		"没有下一页时不显示加载更多",
	);
	cleanup();
});

test("通知记录页：没有记录时说明「不发空汇总」", async () => {
	serve(defaults, {
		"GET /api/me/notifications": () => json({ records: [], nextBefore: null }),
	});
	renderPage();

	assert.ok(await screen.findByText("暂无通知记录"));
	assert.ok(screen.getByText(/没有新内容时不发空汇总/));
	assert.ok(
		await screen.findByText("会收到提醒"),
		"就绪状态来自订阅与通知设置，不是记录的猜测",
	);
	cleanup();
});

test("通知记录页：有下一页时按游标请求更早记录", async () => {
	const requested: string[] = [];
	serve(defaults, {
		"GET /api/me/notifications": (request) => {
			requested.push(new URL(request.url).search);
			if (requested.length === 1)
				return json({
					records: [
						{
							id: "digest:user-a:2026-11-12",
							kind: "digest",
							localDate: "2026-11-12",
							status: "sent",
							scheduledAt: "2026-11-12T01:30:00.000Z",
							sentAt: "2026-11-12T01:31:00.000Z",
							settingsVersion: 4,
							createdAt: "2026-11-12T01:00:00.000Z",
							updatedAt: "2026-11-12T01:31:00.000Z",
							items: [item("成本上升", "sent")],
							delivery: {
								status: "sent",
								sentAt: "2026-11-12T01:31:00.000Z",
							},
						},
					],
					nextBefore: "2026-11-12",
				});
			return json({
				records: [
					{
						id: "digest:user-a:2026-11-10",
						kind: "digest",
						localDate: "2026-11-10",
						status: "cancelled",
						statusReason: "empty",
						scheduledAt: "2026-11-10T01:30:00.000Z",
						settingsVersion: 4,
						createdAt: "2026-11-10T01:00:00.000Z",
						updatedAt: "2026-11-10T01:30:00.000Z",
						items: [],
						delivery: null,
					},
				],
				nextBefore: null,
			});
		},
	});
	renderPage();

	assert.ok(await screen.findByText("11月12日 每日汇总"));
	assert.ok(screen.getByText(/已接收.*不代表你已读/));

	fireEvent.click(screen.getByRole("button", { name: "加载更早的记录" }));

	assert.ok(await screen.findByText("11月10日 每日汇总"));
	assert.ok(screen.getByText("没有新内容"));
	assert.deepEqual(
		requested.slice(0, 2),
		["", "?before=2026-11-12"],
		"第二页用排他游标请求，不重复第一页",
	);
	assert.equal(
		screen.queryByRole("button", { name: "加载更早的记录" }),
		null,
		"没有下一页时按钮消失",
	);
	cleanup();
});
