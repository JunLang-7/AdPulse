import { json, serve } from "./harness.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import TaskEditorPage from "../src/views/adpulse/tasks/editor.tsx";

test("两种创建方式都可以只填产品名称，提交相同的任务内容", async (t) => {
	t.after(cleanup);
	const bodies: unknown[] = [];
	const { calls } = serve({
		"POST /api/tasks": async (request) => {
			const body = await request.json() as object;
			bodies.push(body);
			return json({ ...body, taskId: "created-task", version: 1 }, 201);
		},
	});

	function renderEditor() {
		render(<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter initialEntries={["/tasks/new"]}>
				<Routes>
					<Route path="/tasks/:taskId" element={<TaskEditorPage />} />
					<Route path="/tasks/created-task" element={<h1>创建成功</h1>} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>);
	}

	renderEditor();
	fireEvent.click(screen.getByRole("button", { name: "直接填表" }));
	assert.ok(screen.getByRole("textbox", { name: /推广目标/ }));
	assert.ok(screen.getByRole("textbox", { name: /目标人群/ }));
	assert.equal(screen.queryByText("成本提醒条件"), null);
	fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
	assert.ok(screen.getByRole("alert"));
	fireEvent.change(screen.getByRole("textbox", { name: /产品或服务名称/ }), { target: { value: "云南普洱熟茶" } });
	fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
	await screen.findByRole("heading", { name: "创建成功" });
	cleanup();

	renderEditor();
	fireEvent.change(screen.getByRole("textbox", { name: /产品或服务名称/ }), { target: { value: "云南普洱熟茶" } });
	for (const heading of ["人群与卖点", "投放渠道", "核对推广任务"]) {
		fireEvent.click(screen.getByRole("button", { name: "提交本阶段" }));
		await screen.findByRole("heading", { name: heading });
	}
	fireEvent.click(screen.getByRole("button", { name: "确认并创建任务" }));
	await screen.findByRole("heading", { name: "创建成功" });
	assert.deepEqual(calls, ["POST /api/tasks", "POST /api/tasks"]);
	assert.equal(bodies.length, 2);
	assert.deepEqual(bodies[1], bodies[0]);
});
