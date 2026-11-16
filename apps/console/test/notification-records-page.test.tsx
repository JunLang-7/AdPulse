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
			kind: "task",
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

test("筛选记录页：当时原因、详情、任务/日期/结果过滤和稳定翻页", async () => {
	const searches: URLSearchParams[] = [];
	const record = { id: "record-a", input: "effect", alertId: "alert-a", taskId: "task-a", comparisonResultId: "comparison-a", evidenceRef: { evidenceId: "evidence-a", version: 1 }, revision: 1, settingsVersion: 4, matchedTargetIds: [], outcome: "not_queued", reason: "no_target", evaluatedAt: "2026-11-16T00:01:00.000Z" };
	serve(defaults, {
		"GET /api/me/notifications": () => json({ records: [], nextBefore: null }),
		"GET /api/tasks": () => json({ items: [{ taskId: "task-a", product: "本人任务 A" }] }),
		"GET /api/me/notification-selections": (request) => {
			const params = new URL(request.url).searchParams; searches.push(params);
			return json(params.has("before") ? { records: [{ ...record, id: "record-b", reason: "push_disabled" }], nextBefore: null } : { records: [record], nextBefore: "cursor-a" });
		},
	});
	renderPage();
	fireEvent.click(screen.getByRole("button", { name: "筛选记录" }));
	assert.ok(await screen.findByText("当时未关注该任务"));
	assert.ok(screen.getByText(/当时设置 v4/));
	fireEvent.click(screen.getByText("查看当时依据"));
	assert.ok(screen.getByText("比较引用：comparison-a"));
	assert.equal(screen.getByRole("link", { name: "task-a" }).getAttribute("href"), "/tasks/task-a");
	fireEvent.click(screen.getByRole("button", { name: "加载更早的筛选记录" }));
	assert.ok(await screen.findByText("当时未开启主动推送"));
	assert.equal(searches[1].get("before"), "cursor-a");
	await screen.findByRole("option", { name: "本人任务 A" });
	fireEvent.change(screen.getByLabelText("筛选任务"), { target: { value: "task-a" } });
	fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-11-15" } });
	fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2026-11-16" } });
	fireEvent.change(screen.getByLabelText("筛选结果"), { target: { value: "not_queued" } });
	fireEvent.click(screen.getByRole("button", { name: "查询筛选记录" }));
	await screen.findByText("当时未关注该任务");
	assert.equal(searches[searches.length - 1]?.get("taskId"), "task-a");
	assert.equal(searches[searches.length - 1]?.get("dateFrom"), "2026-11-15");
	assert.equal(searches[searches.length - 1]?.get("dateTo"), "2026-11-16");
	assert.equal(searches[searches.length - 1]?.get("outcome"), "not_queued");
	assert.equal(searches[searches.length - 1]?.has("before"), false, "新过滤重置分页");
	cleanup();
});

test("筛选记录页：事件输入显示事件依据与已接入的拒绝原因", async () => {
	const record = {
		id: "record-event", input: "event",
		marketEventRef: { eventId: "event-a", version: 2, evidenceRevision: 2 },
		taskId: "task-a", revision: 2, settingsVersion: 5, matchedTargetIds: [],
		outcome: "not_queued", reason: "scope_excluded", evaluatedAt: "2026-11-16T01:02:00.000Z",
	};
	serve(defaults, {
		"GET /api/me/notifications": () => json({ records: [], nextBefore: null }),
		"GET /api/tasks": () => json({ items: [{ taskId: "task-a", product: "本人任务 A" }] }),
		"GET /api/me/notification-selections": () => json({ records: [record], nextBefore: null }),
	});
	renderPage();
	fireEvent.click(screen.getByRole("button", { name: "筛选记录" }));
	assert.ok(await screen.findByText("未入队 · 市场/竞品事件"));
	assert.ok(screen.getByText(/只标注了关注对象、没有关联任务/));
	fireEvent.click(screen.getByText("查看当时依据"));
	assert.equal(screen.getByRole("link", { name: "event-a" }).getAttribute("href"), "/market-events/event-a");
	assert.ok(screen.getByText(/（证据版本 2）/));
	assert.equal(screen.getByRole("link", { name: "task-a" }).getAttribute("href"), "/tasks/task-a");
	assert.equal(screen.queryByText(/告警引用/), null, "事件记录不显示效果告警引用");
	cleanup();
});

test("筛选记录页：失败可见且可重试，空历史不伪造原因", async () => {
	let failed = true;
	serve(defaults, {
		"GET /api/me/notifications": () => json({ records: [], nextBefore: null }),
		"GET /api/tasks": () => json({ items: [] }),
		"GET /api/me/notification-selections": () => failed ? json({ error: "invalid_query" }, 400) : json({ records: [], nextBefore: null }),
	});
	renderPage(); fireEvent.click(screen.getByRole("button", { name: "筛选记录" }));
	assert.ok(await screen.findByText("查询条件无效，请检查日期范围。"));
	failed = false; fireEvent.click(screen.getByRole("button", { name: "重试读取筛选记录" }));
	assert.ok(await screen.findByText(/未记录的历史原因无法还原/));
	cleanup();
});

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
						itemsSource: "rows",
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
							itemsSource: "delivery",
							// 冻结卡片只有展示字段：不补造 id/status/revision。
							items: [
								{
									title: "成本上升（首版）",
									summary: "近 3 天咨询成本上升 35%。",
									relevance: "与你关注的任务「护眼台灯」相关。",
									sources: [{ label: "投放后台", publishedAt: null }],
								},
							],
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
						itemsSource: "rows",
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
	// 历史内容取自发送时冻结的卡片，而不是条目行当前版本。
	assert.ok(screen.getByText("成本上升（首版）"));
	assert.ok(
		await screen.findByTestId("notification-record-items-note"),
		"说明这是当时发出的内容",
	);
	assert.match(
		screen.getByTestId("notification-record-items-note").textContent ?? "",
		/发送时实际发出的卡片内容/,
	);

	fireEvent.click(screen.getByRole("button", { name: "加载更早的记录" }));

	assert.ok(await screen.findByText("11月10日 每日汇总"));
	assert.ok(
		screen.getByText("本批没有待发内容"),
		"不把「内容已移入后续批次」冒充成「没有新内容」",
	);
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
