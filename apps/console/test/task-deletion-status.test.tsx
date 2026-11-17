import { json, serve } from "./harness.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import TasksPage from "../src/views/adpulse/tasks/index.tsx";

function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<TasksPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

test("任务列表：显示清理进度（等待清理/已清理），不含任务正文", async t => {
	t.after(cleanup);
	serve({
		"GET /api/tasks": () => json({ items: [] }),
		"GET /api/me/lifecycle-deletions": () => json({ items: [
			{ id: "m1", ownerId: "o", taskId: "aaaaaaaa-1111", requestedAt: "2026-11-17T00:00:00.000Z", deadlineAt: "2026-11-24T00:00:00.000Z", status: "pending" },
			{ id: "m2", ownerId: "o", taskId: "bbbbbbbb-2222", requestedAt: "2026-11-10T00:00:00.000Z", deadlineAt: "2026-11-17T00:00:00.000Z", status: "cleaned", cleanedAt: "2026-11-17T01:00:00.000Z" },
		] }),
	});
	mount();
	assert.ok(await screen.findByText("删除与清理状态"));
	assert.ok(screen.getByText("等待清理"));
	assert.ok(screen.getByText("已清理"));
	assert.ok(
		screen.getAllByText((_, element) => element?.textContent?.includes("aaaaaaaa") ?? false).length > 0,
		"展示任务 id 前缀",
	);
	assert.equal(screen.queryByText(/任务正文/), null, "不展示任务正文");
});

test("任务列表：没有删除请求时不渲染状态卡", async t => {
	t.after(cleanup);
	serve({
		"GET /api/tasks": () => json({ items: [] }),
		"GET /api/me/lifecycle-deletions": () => json({ items: [] }),
	});
	mount();
	assert.ok(await screen.findByText(/还没有推广任务/));
	assert.equal(screen.queryByText("删除与清理状态"), null);
});
