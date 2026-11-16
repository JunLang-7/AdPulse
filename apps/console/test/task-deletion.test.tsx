// 组件级交互测试：删除确认必须真的拦截、提示真的渲染，且失败不冒充成功。
// 由 `bun run --cwd apps/console test:components` 运行（Node + tsx + jsdom）。

// 必须最先导入：harness 在被测页面模块求值前安装 fetch 桩。
import { json, serve } from "./harness.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
	TaskDeletionAction,
	TaskDeletionNotice,
	type TaskDeletion,
} from "../src/views/adpulse/tasks/task-deletion-action.tsx";

const view: TaskDeletion = {
	taskId: "task-1",
	state: "restricted",
	requestedAt: "2026-02-01T00:00:00.000Z",
	cleanupDueAt: "2026-02-08T00:00:00.000Z",
	newlyRequested: true,
	suppressed: { items: 2, batches: 1, deliveries: 1, jobs: 3, sessions: 1, inboxes: 0 },
};

function wrap(children: React.ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{children}</QueryClientProvider>,
	);
}

test("删除任务：先确认再提交，取消不发请求，成功后提示限访与清理上限", async (t) => {
	t.after(cleanup);
	const { calls } = serve({
		"POST /api/tasks/task-1/deletion": () => json(view),
	});
	let deleted: TaskDeletion | null = null;
	wrap(
		<TaskDeletionAction taskId="task-1" onDeleted={(next) => { deleted = next; }} />,
	);

	fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
	assert.ok(screen.getByRole("group", { name: "确认删除任务" }));
	assert.match(screen.getByRole("group", { name: "确认删除任务" }).textContent ?? "", /最迟 7 天完成清理/);
	fireEvent.click(screen.getByRole("button", { name: "取消" }));
	assert.equal(screen.queryByRole("group", { name: "确认删除任务" }), null);
	assert.deepEqual(calls, []);

	fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
	fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
	await waitFor(() => assert.equal(deleted?.taskId, "task-1"));
	assert.deepEqual(calls, ["POST /api/tasks/task-1/deletion"]);

	cleanup();
	wrap(<TaskDeletionNotice view={view} />);
	assert.match(screen.getByRole("status").textContent ?? "", /已确认删除，任务现在不可访问/);
	assert.match(screen.getByRole("status").textContent ?? "", /37 天/);
	assert.match(screen.getByRole("status").textContent ?? "", /待发信息 2 条/);
});

test("删除任务：404 时显示可行动提示，不冒充成功", async (t) => {
	t.after(cleanup);
	serve({
		"POST /api/tasks/task-1/deletion": () => json({ error: "task not found" }, 404),
	});
	let deleted: TaskDeletion | null = null;
	wrap(
		<TaskDeletionAction taskId="task-1" onDeleted={(next) => { deleted = next; }} />,
	);
	fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
	fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
	await waitFor(() =>
		assert.match(screen.getByRole("alert").textContent ?? "", /任务不存在或已不属于你/),
	);
	assert.equal(deleted, null);
});
