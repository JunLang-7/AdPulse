import { json, serve } from "./harness.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import TaskEditorPage from "../src/views/adpulse/tasks/editor.tsx";
import TasksPage from "../src/views/adpulse/tasks/index.tsx";

const version = {
	taskId: "task-1", version: 1, product: "待删除任务",
	strategy: { objective: "咨询", audience: [], channels: {}, sellingPoints: [] },
	observation: {}, rules: {}, createdAt: "2026-11-10T00:00:00.000Z",
};
const lifecycle = {
	taskId: "task-1", state: "active", anchor: "2026-11-10T00:00:00.000Z",
	anchorSource: "last_business_update", lastBusinessUpdate: "2026-11-10T00:00:00.000Z",
	observationEndsAt: null, expiresAt: "2027-11-10T00:00:00.000Z", retentionDays: 365,
	expired: false, deletedAt: null,
};
const defaults = {
	"GET /api/tasks/task-1": () => json({ task: version, versions: [version] }),
	"GET /api/tasks/task-1/lifecycle": () => json(lifecycle),
	"GET /api/tasks": () => json({ items: [] }),
	"GET /api/me/model-connections": () => json({ connections: [] }),
};
function mount(path: string) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/tasks" element={<TasksPage />} />
					<Route path="/tasks/:taskId" element={<TaskEditorPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

test("任务详情：显示保留期，删除需要显式确认后才发出请求", async t => {
	t.after(cleanup);
	const calls: string[] = [];
	serve(defaults, {
		"DELETE /api/tasks/task-1": () => { calls.push("delete"); return json({ manifest: { id: "m1", ownerId: "o", taskId: "task-1", requestedAt: "2026-11-17T00:00:00.000Z", deadlineAt: "2026-11-24T00:00:00.000Z", status: "pending" }, created: true }); },
	});
	mount("/tasks/task-1");
	assert.ok(await screen.findByText(/保留至 2027-11-10（剩余 \d+ 天）/));
	assert.equal(calls.length, 0, "默认不发出删除请求");

	fireEvent.click(screen.getByRole("button", { name: "删除任务…" }));
	assert.ok(screen.getByText(/删除后不可恢复：任务、证据/));
	assert.equal(screen.getAllByText(/删除后不可恢复/).length, 2, "确认面板与勾选项都说明不可恢复");
	const confirmButton = screen.getByRole("button", { name: "确认删除任务" }) as HTMLButtonElement;
	assert.equal(confirmButton.disabled, true, "未勾选确认前不可删除");

	fireEvent.click(screen.getByRole("checkbox"));
	assert.equal(confirmButton.disabled, false);
	fireEvent.click(confirmButton);
	await waitFor(() => assert.equal(calls.length, 1));
	assert.ok(await screen.findByText(/任务已删除，旧任务与其历史立即不可访问/), "删除后回到列表并提示");
});

test("任务详情：删除失败显示可见提示，不假装成功", async t => {
	t.after(cleanup);
	serve(defaults, { "DELETE /api/tasks/task-1": () => json({ error: "deletion already in progress" }, 409) });
	mount("/tasks/task-1");
	fireEvent.click(await screen.findByRole("button", { name: "删除任务…" }));
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(screen.getByRole("button", { name: "确认删除任务" }));
	assert.ok(await screen.findByText("删除请求正在处理，请稍后重试。"));
	assert.equal(screen.queryByText(/任务已删除/), null, "失败不显示成功提示");
});
