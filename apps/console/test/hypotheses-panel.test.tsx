// 组件级交互测试：假设面板的草案接受、初判确认与停用。
// 必须最先导入：harness 在被测组件模块求值前安装 fetch 桩。
// 说明：本环境 waitFor 的重试路径会放大内存压力，因此用有界轮询代替。
import { json, serve } from "./harness.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { HypothesesPanel } from "../src/views/adpulse/tasks/hypotheses-panel.tsx";

const taskId = "11111111-1111-4111-8111-111111111111";

const hypothesis = {
	head: { id: "hyp-1", ownerId: "owner", taskId, taskVersion: 1, currentVersion: 1, status: "open", createdAt: "2026-11-16T00:00:00.000Z" },
	current: {
		id: "hyp-1:1", hypothesisId: "hyp-1", ownerId: "owner", version: 1,
		statement: "目标人群对免费试用装的反应优于直接折扣",
		rationale: "任务说明将免费试用列为主卖点",
		origin: "manual", createdAt: "2026-11-16T00:00:00.000Z",
	},
	versions: [1],
	verdicts: [],
};

const defaults = {
	[`GET /api/tasks/${taskId}/hypotheses`]: () => json({ items: [hypothesis] }),
	"GET /api/hypotheses/pending": () => json({ items: [] }),
};

const settle = async (ms = 400): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, ms));
};

function renderPanel(): void {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<HypothesesPanel taskId={taskId} />
		</QueryClientProvider>,
	);
}

test("假设面板：展示已确认假设的状态与陈述", async (t) => {
	t.after(cleanup);
	serve(defaults);
	renderPanel();
	await screen.findByText("目标人群对免费试用装的反应优于直接折扣");
	assert.ok(screen.getByText("观察中"));
	assert.equal(screen.queryByText(/待确认判定/), null, "无待确认时不渲染该区块");
});

test("假设面板：生成草案后接受为假设，POST 携带草案来源", async (t) => {
	t.after(cleanup);
	const bodies: unknown[] = [];
	serve(defaults, {
		[`POST /api/tasks/${taskId}/hypotheses/drafts`]: () => json({
			drafts: [{ statement: "装修人群更看重免费样品", rationale: "材料提到装修业主", evidenceHint: "准备装修的新房业主" }],
		}),
		[`POST /api/tasks/${taskId}/hypotheses`]: async (request) => {
			bodies.push(await request.json());
			return json({
				status: "created",
				hypothesis: { ...hypothesis.head, id: "hyp-2" },
				version: { ...hypothesis.current, id: "hyp-2:1" },
			}, 201);
		},
	});
	renderPanel();
	await act(async () => {
		fireEvent.click(await screen.findByRole("button", { name: "生成假设草案" }));
	});
	// 陈述渲染在可编辑输入里：用 display value 断言而不是文本内容。
	await screen.findByDisplayValue("装修人群更看重免费样品");
	assert.ok(screen.getByText(/依据摘录：准备装修的新房业主/));
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "接受为假设" }));
		await settle();
	});
	// 草案卡片移除，假设列表刷新（POST 已发出且界面回到列表态）。
	assert.equal(screen.queryByRole("button", { name: "接受为假设" }), null);
	assert.ok(bodies.length >= 1);
	assert.equal((bodies[0] as { origin?: string }).origin, "model_draft_accepted");
});

test("假设面板：待确认初判显示判定与原文，确认后重新查询为空", async (t) => {
	t.after(cleanup);
	let confirmed = false;
	const pendingVerdict = {
		id: "verdict-1", dedupKey: "d", ownerId: "owner", hypothesisId: "hyp-1", hypothesisVersion: 1,
		subject: { kind: "market_event", eventId: "event-1", version: 1 },
		judgment: "challenges", explanation: "竞品同类免费试用削弱差异化", quote: "测试品牌发布新品",
		stage: "preliminary", preliminary: { modelRef: "deepseek/deepseek-chat", generatedAt: "2026-11-16T00:00:00.000Z" },
		createdAt: "2026-11-16T00:00:00.000Z",
	};
	serve(defaults, {
		"GET /api/hypotheses/pending": () => json({ items: confirmed ? [] : [pendingVerdict] }),
		"POST /api/hypotheses/verdicts/verdict-1/confirm": () => {
			confirmed = true;
			return json({ verdict: { ...pendingVerdict, stage: "confirmed" }, hypothesis: hypothesis.head });
		},
	});
	renderPanel();
	await screen.findByText("竞品同类免费试用削弱差异化");
	assert.ok(screen.getByText(/原文引用：/));
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "确认判定" }));
		await settle();
	});
	assert.equal(screen.queryByRole("button", { name: "确认判定" }), null);
});

test("假设面板：模型不可用时提示配置而不是通用错误", async (t) => {
	t.after(cleanup);
	serve(defaults, {
		[`POST /api/tasks/${taskId}/hypotheses/drafts`]: () => json({ error: "unavailable" }, 503),
	});
	renderPanel();
	await act(async () => {
		fireEvent.click(await screen.findByRole("button", { name: "生成假设草案" }));
	});
	await screen.findByRole("alert");
	assert.ok(screen.getByText(/模型连接/));
});
