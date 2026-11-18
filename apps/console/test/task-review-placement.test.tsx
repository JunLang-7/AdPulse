import { serve } from "./harness.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { components } from "../src/adpulse-client";
import { ComparisonPanel } from "../src/views/adpulse/tasks/comparison-panel";
import { reportChoiceLabel } from "../src/views/adpulse/tasks/review-display";
import { QuickReviewPanel } from "../src/views/adpulse/tasks/review-quick-panel";

const taskId = "placement-task";
const createdAt = "2026-11-16T00:01:00.000Z";
const currency = { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 };
const scope = { planRef: "plan", campaignRefs: [] };
const period = {
	startsAt: "2026-11-14T00:00:00+08:00",
	endsAt: "2026-11-15T00:00:00+08:00",
	timeZone: "Asia/Shanghai",
	completeness: "complete" as const,
};
const metric = { definition: "报表统计", formula: "直接统计", sourceField: "report" };

function evidence(
	placementType: "paid_ads" | "influencer" | "seeding",
	keys: { spend: string; count: string },
	values: Record<string, number>,
	version = 1,
): components["schemas"]["EvidenceVersion"] {
	return {
		id: `ev-${version}`,
		evidenceId: `ev_${placementType}_${version}`,
		ownerId: "owner",
		taskId,
		taskVersion: 1,
		version,
		businessKey: "key",
		contentDigest: "digest",
		placementType,
		scope,
		period,
		metricsContract: { [keys.spend]: metric, [keys.count]: metric },
		currency,
		attribution: { model: "platform" },
		callbackStatus: "complete",
		values,
		createdAt,
	};
}

function renderPanel(items: components["schemas"]["EvidenceVersion"][]) {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter>
				<ComparisonPanel taskId={taskId} items={items} mode="comparison" />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

test("达人合作报表按互动口径展示，不出现咨询次数标签", async (t) => {
	t.after(cleanup);
	const influencerReport = evidence("influencer", { spend: "feeMinor", count: "engagement" }, { feeMinor: 2_000, engagement: 10 });
	// 报表选择标签按口径取值：达人报表要读出合作费用与互动量，而不是「未提供」。
	const label = reportChoiceLabel(influencerReport);
	assert.doesNotMatch(label, /未提供/);
	assert.match(label, /20 元/);
	assert.match(label, /10 次/);
	serve({});
	renderPanel([
		influencerReport,
		evidence("influencer", { spend: "feeMinor", count: "engagement" }, { feeMinor: 3_000, engagement: 12 }, 2),
	]);
	fireEvent.click(await screen.findByText("对比两期表现"));
	assert.ok(await screen.findByText(/合作费用、互动量和单次互动成本/));
	assert.equal(screen.queryByText(/每次咨询成本/), null);
});

test("内容种草任务隐藏按咨询成本设计的手填试算", async (t) => {
	t.after(cleanup);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter>
				<QuickReviewPanel
					rules={{ placementType: "seeding", metricKey: "cost_per_engagement" }}
					placementType="seeding"
					startOpen
				/>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	assert.ok(screen.getByText(/手填试算只针对付费广告的咨询成本/));
	assert.equal(screen.queryByPlaceholderText("例如 300"), null);
	assert.equal(screen.queryByPlaceholderText("例如 12"), null);
});

test("付费广告任务保留原有手填试算", async (t) => {
	t.after(cleanup);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter>
				<QuickReviewPanel
					rules={{ placementType: "paid_ads", metricKey: "cost_per_consultation" }}
					placementType="paid_ads"
					startOpen
				/>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	assert.ok(screen.getByPlaceholderText("例如 300"));
	assert.ok(screen.getByPlaceholderText("例如 12"));
	assert.equal(screen.queryByText(/手填试算只针对付费广告/), null);
});
