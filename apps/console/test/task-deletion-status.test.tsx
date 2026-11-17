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
	assert.ok(await screen.findByText("删除进度"));
	assert.ok(screen.getByText("等待清理"));
	assert.ok(screen.getByText("已清理"));
	assert.ok(screen.getByText(/最迟 7 天内清理完成（剩下 1 个在排队）/), "说明还要等多久");
	assert.ok(screen.getByText("请求于 11月17日 08:00 · 最迟 11月24日 08:00 清理完成"), "时间用北京时间到分钟");
	assert.ok(screen.getByText("11月17日 09:00 清理完成"), "已清理的显示完成时间");
	assert.equal(screen.queryByText(/aaaaaaaa|bbbbbbbb/), null, "不给用户看任务 ID");
	assert.equal(screen.queryByText(/\d{2}:\d{2}:\d{2}/), null, "不显示秒和毫秒");
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
	assert.equal(screen.queryByText("删除进度"), null);
});
