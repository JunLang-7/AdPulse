import { json, serve } from "./harness.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import SessionDetailPage from "../src/views/adpulse/session-detail/index.tsx";

/** 126 字符无空格 token：验证强制断词，长渠道名不得被卡片的 overflow-hidden 裁掉。 */
const longChannel = "channel-" + "x".repeat(126);

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
				strategy: {
					objective: "提升咨询量",
					audience: ["装修业主"],
					sellingPoints: ["免费样品"],
					contentDirections: ["产地溯源"],
					partners: ["本地达人"],
					channels: { "小红书": { budget: 1200, bidCpc: 2.5, enabled: true } },
				},
				limits: {}, allowedActorIds: ["ou-owner"], createdAt: "2026-11-16T01:00:00Z",
			},
			rounds: [
				{
					id: "round-1", sessionId: "session-1", roundNo: 1, strategyVersion: 0,
					status: "answered", respondedAt: "2026-11-16T02:10:00Z",
					card: {
						title: "复核成本", summary: "本期咨询成本上升", evidence: [],
						options: [{ id: "c1", label: "补充人群" }],
					},
					candidates: [{
						id: "c1", label: "补充人群", changes: [], complete: true,
						hypothesis: "春节前家庭备货增加",
						validationPlan: "观察 7 天咨询成本是否回落",
					}],
				},
			],
			actions: [], inbox: [], deliveries: [],
			snapshots: [
				{ id: "snap-1", sessionId: "session-1", version: 1, createdAt: "2026-11-16T02:00:00Z",
					strategy: {
						objective: "提升咨询量",
						audience: ["装修业主", "旧人群"],
						sellingPoints: ["免费样品"],
						channels: { "小红书": { budget: 1000, bidCpc: 2.5, enabled: true } },
					},
					changes: [
						{ kind: "budget", channelId: "channel-a", from: 1000, to: 1500 },
						{ kind: "bidCpc", channelId: "channel-a", from: 1.2, to: 1.8 },
						{ kind: "enabled", channelId: "channel-b", from: true, to: false },
						{ kind: "audience", op: "add", item: "春节备货的家庭" },
						{ kind: "sellingPoint", op: "remove", item: "免费样品" },
						{ kind: "contentDirection", op: "add", item: "产地溯源短视频" },
						{ kind: "partner", op: "add", item: "本地生活达人" },
					] },
				{ id: "snap-long", sessionId: "session-1", version: 2, createdAt: "2026-11-16T03:00:00Z",
					changes: [{ kind: "budget", channelId: longChannel, from: 100, to: 200 }] },
				{ id: "snap-empty", sessionId: "session-1", version: 3, createdAt: "2026-11-16T04:00:00Z", changes: [] },
			],
		}),
	});
	mount();
	assert.ok(await screen.findByText("当前方案"));
	assert.ok(screen.getByText("推广目标：提升咨询量"));
	assert.ok(screen.getByText("装修业主"));
	assert.ok(screen.getByText("产地溯源"));
	assert.ok(screen.getByText("本地达人"));
	assert.ok(screen.getByText(/小红书：预算 1200 · 出价 2.5 · 启用/));
	assert.ok(await screen.findByText("与最早快照相比"));
	assert.ok(screen.getByText("人群：移除 旧人群"));
	assert.ok(screen.getByText("内容方向：新增 产地溯源"));
	assert.ok(screen.getByText("合作对象：新增 本地达人"));
	assert.ok(screen.getByText("渠道 小红书：预算 1000 → 1200"));
	assert.ok(await screen.findByText("策略变更记录"));
	// from/to 明细（#11 的明确规格）：字段 + 渠道 + 原值 → 新值。
	assert.ok(screen.getByText("预算（channel-a）：1000 → 1500"), "预算 from/to");
	assert.ok(screen.getByText("出价（channel-a）：1.2 → 1.8"), "出价 from/to");
	assert.ok(screen.getByText("启用状态（channel-b）：true → false"), "启停 from/to");
	assert.ok(screen.getByText("人群新增：春节备货的家庭"), "人群增删");
	assert.ok(screen.getByText("卖点移除：免费样品"), "卖点增删");
	assert.ok(screen.getByText("内容方向新增：产地溯源短视频"), "内容方向增删");
	assert.ok(screen.getByText("合作对象新增：本地生活达人"), "合作对象增删");
	// 长渠道名（无空格 token）完整渲染并强制断词，不能被卡片的 overflow-hidden 裁掉。
	const longRow = screen.getByText(new RegExp(longChannel));
	assert.equal(longRow.textContent, `预算（${longChannel}）：100 → 200`, "完整渠道名与原值新值都在文本里");
	assert.ok(longRow.className.includes("break-all"), "变更行强制断词");
	// changes=[] 显示「无变更」，不冒充草案已变更（该行还有时间后缀，用正则匹配）。
	assert.ok(screen.getByText(/无变更/));
	assert.equal(screen.queryByText(/0 项变更/), null, "空变更版本不显示计数");
	// 候选的假设与验证方式在轮次里可见，不塞进按钮文本。
	assert.ok(
		screen.getByText("补充人群：假设：春节前家庭备货增加；验证：观察 7 天咨询成本是否回落"),
		"候选假设与验证方式",
	);
});
