// 组件级：事件录入的 AI 整理 —— 整理建议默认只勾原文、勾选后填入表单。
import { json, serve } from "./harness.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import MarketEventsPage from "../src/views/adpulse/market-events/index.tsx";

const closedSources = [
	{ key: "weichai_news", label: "潍柴新闻与事件", subject: { kind: "brand", name: "潍柴" }, enabled: false },
	{ key: "haier_news", label: "海尔品牌资讯", subject: { kind: "brand", name: "海尔" }, enabled: false },
];
const defaults = {
	"GET /api/tasks": () => json({ items: [] }),
	"GET /api/market-events": () => json({ items: [] }),
	"GET /api/me/source-leads": () => json({ leads: [], sources: closedSources }),
	"GET /api/me/source-status": () => json({ items: [] }),
};

function mount(): void {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/market-events"]}>
				<Routes><Route path="/market-events" element={<MarketEventsPage />} /></Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const settle = async (ms = 400): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, ms));
};

const extractResult = {
	items: [
		{ field: "citationSubject", value: "本公司", source: "quote" },
		{ field: "citationEventTime", value: "2026年11月16日", source: "quote" },
		{ field: "title", value: "关于新品发布的公告", source: "quote" },
		{ field: "type", value: "product_launch", source: "idea" },
		{ field: "subjectName", value: "本公司", source: "quote" },
		{ field: "eventTime", value: "2026年11月16日", source: "quote" },
		{ field: "limitations", value: "仅取得公告摘要。", source: "idea" },
	],
};

test("事件 AI 整理：原文项默认勾选、整理项不勾，填入后写进表单", async (t) => {
	t.after(cleanup);
	const calls: string[] = [];
	serve(defaults, {
		"POST /api/market-events/extract": () => {
			calls.push("extract");
			return json(extractResult);
		},
	});
	mount();
	fireEvent.click(await screen.findByRole("button", { name: "录入事件" }));
	fireEvent.change(screen.getByLabelText("事件材料（官网原文或粘贴内容）"), {
		target: { value: "本公司于2026年11月16日发布新款背包。本次发布不包含价格调整。" },
	});
	fireEvent.click(screen.getByRole("button", { name: "AI 整理材料" }));
	await screen.findByText("关于新品发布的公告");
	assert.equal(calls.length, 1);

	// 原文逐字项已默认勾选；模型整理项（产品发布、局限）需要用户自己勾。
	const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
	const checked = boxes.filter((box) => box.checked).length;
	assert.ok(checked >= 4, "原文逐字项默认勾选");
	assert.match(screen.getByText(/整理出 \d+ 条建议/).textContent ?? "", /整理出/);

	fireEvent.click(screen.getByRole("button", { name: /填入勾选的/ }));
	await settle();
	assert.equal((screen.getByLabelText("事件标题") as HTMLInputElement).value, "关于新品发布的公告");
	assert.equal((screen.getByLabelText("关注对象名称") as HTMLInputElement).value, "本公司");
	assert.equal((screen.getByLabelText("事件时间（未知留空）") as HTMLInputElement).value, "2026年11月16日");
	// 模型整理项未勾选 → 类别仍保持默认公告，但要点名提醒还有未勾的类别建议。
	assert.equal((screen.getByLabelText("类别") as HTMLSelectElement).value, "announcement");
	assert.match(screen.getByText(/还有 \d+ 条建议未勾/).textContent ?? "", /类别：产品发布/);
	// 引用已填入且材料同步到正文，否则保存会被领域拒绝。
	assert.equal((screen.getByLabelText("来源性质") as HTMLSelectElement).value, "unknown");
	assert.match((screen.getByLabelText("原始材料文字") as HTMLTextAreaElement).value, /本公司于2026年11月16日发布/);
	assert.equal((screen.getByLabelText("内容范围") as HTMLSelectElement).value, "excerpt");
});
