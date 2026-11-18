import { json, serve } from "./harness.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import SessionDetailPage from "../src/views/adpulse/session-detail/index.tsx";

function mount(path = "/sessions/session-1") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

test("会话详情：策略变更展开显示 原值 → 新值，无变更显示「无变更」", async t => {
	t.after(cleanup);
	serve({
		"GET /api/sessions/session-1": () => json({
			session: {
				id: "session-1", ownerId: "owner", version: 1, roundNo: 1, status: "completed",
				signal: { title: "每次咨询成本超过提醒线", summary: "检查本期成本" },
				strategy: {}, limits: {}, allowedActorIds: ["ou-owner"], createdAt: "2026-11-16T01:00:00Z",
			},
			rounds: [], actions: [], inbox: [], deliveries: [],
			snapshots: [
				{ id: "snap-1", sessionId: "session-1", version: 1, createdAt: "2026-11-16T02:00:00Z",
					changes: [
						{ kind: "budget", channelId: "channel-a", from: 1000, to: 1500 },
						{ kind: "bidCpc", channelId: "channel-a", from: 1.2, to: 1.8 },
						{ kind: "enabled", channelId: "channel-b", from: true, to: false },
					] },
				{ id: "snap-2", sessionId: "session-1", version: 2, createdAt: "2026-11-16T03:00:00Z", changes: [] },
			],
		}),
	});
	mount();
	assert.ok(await screen.findByText("策略变更记录"));
	// from/to 明细（#11 的明确规格）：字段 + 渠道 + 原值 → 新值。
	assert.ok(screen.getByText("预算（channel-a）：1000 → 1500"), "预算 from/to");
	assert.ok(screen.getByText("出价（channel-a）：1.2 → 1.8"), "出价 from/to");
	assert.ok(screen.getByText("启用状态（channel-b）：true → false"), "启停 from/to");
	// changes=[] 不冒充「草案已变更」（该行还有时间后缀，用正则匹配）。
	assert.ok(screen.getByText(/无变更/));
	assert.equal(screen.queryByText(/1 项变更/), null, "无变更的版本不显示变更计数");
});
