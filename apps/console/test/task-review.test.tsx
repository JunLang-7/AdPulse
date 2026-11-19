import { json, serve } from "./harness.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { components } from "../src/adpulse-client";
import { ComparisonPanel, ReviewFollowUps } from "../src/views/adpulse/tasks/comparison-panel";
import { InvestigationAlertsPanel } from "../src/views/adpulse/tasks/investigation-alerts-panel";

test("复盘用报表日期和金额展示结果，补充报表时自动提交对应编号和版本", async (t) => {
	t.after(cleanup);
	const taskId = "test-task";
	const createdAt = "2026-11-16T00:01:00.000Z";
	const currency = { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 };
	const source = { platform: "internal-platform", accountRef: "internal-account" };
	const scope = { planRef: "internal-plan", campaignRefs: [] };
	const current = { evidenceId: "ev_" + "a".repeat(64), version: 1, taskId, taskVersion: 1 };
	const previous = { ...current, evidenceId: "ev_" + "b".repeat(64), version: 2 };
	const period = { startsAt: "2026-11-14T00:00:00+08:00", endsAt: "2026-11-15T00:00:00+08:00", timeZone: "Asia/Shanghai", completeness: "complete" as const };
	const previousPeriod = { ...period, startsAt: "2026-11-13T00:00:00+08:00", endsAt: period.startsAt };
	const report = { ...current, id: "current", period, scope, currency, createdAt, values: { spendMinor: 2000, consultations: 10 } };
	const supplement = { ...report, ...previous, id: "previous", period: previousPeriod, createdAt: "2026-11-16T01:00:00.000Z" };
	const metric = { definition: "报表统计", formula: "直接统计", sourceField: "report" };
	const reports: components["schemas"]["EvidenceVersion"][] = [report, supplement].map((item) => ({
		ownerId: "owner", businessKey: "key", contentDigest: "digest",
		metricsContract: { spendMinor: metric, consultations: metric },
		attribution: { model: "platform" }, callbackStatus: "complete", ...item,
	}));
	const followUp = {
		id: "follow-up", status: "open", createdAt, updatedAt: createdAt, reasonCode: "NO_BASELINE",
		axis: "period_comparison", source, scope, period: previousPeriod, resolutionKind: "evidence",
		remediation: { action: "provide_evidence", completionCriteria: "matching_complete_evidence_version" },
	};
	let resolved = false;
	let submitted: unknown;
	const comparisonRequests: unknown[] = [];
	const costResult = {
		id: "cost", status: "missing_baseline", createdAt, current, comparisons: {},
		thresholdEvaluation: { status: "exceeded", value: { numeratorMinor: 2000, denominatorConsultations: 10 }, thresholdMinor: 100, currency: "CNY" },
		reasons: [{ code: "NO_BASELINE", axis: "period_comparison" }],
	};
	const comparisonResult = {
		...costResult, id: "comparison", baseline: previous, status: "incomparable",
		reasons: [{ code: "ATTRIBUTION_MISMATCH", axis: "period_comparison" }],
	};
	const { calls } = serve({
		"GET /api/tasks/test-task/comparisons": () => json({ items: [costResult, comparisonResult] }),
		"POST /api/comparisons/evaluate": async (request) => {
			comparisonRequests.push(await request.json());
			return json(comparisonRequests.length === 1 ? costResult : comparisonResult);
		},
		"GET /api/tasks/test-task/comparison-follow-ups": () => json({ items: [
			{ ...followUp, status: resolved ? "completed" : "open" },
		] }),
		[`GET /api/evidence/${current.evidenceId}`]: () => json({ current: report, versions: [report] }),
		[`GET /api/evidence/${previous.evidenceId}`]: () => json({ current: supplement, versions: [supplement] }),
		"POST /api/comparison-follow-ups/follow-up/resolve": async (request) => {
			submitted = await request.json();
			resolved = true;
			return json({ ...followUp, status: "completed" });
		},
		"GET /api/tasks/test-task/investigation-alerts": () => json({ items: [{
			id: "alert", status: "open", sessionId: "session",
			current: { evidence: current, source, scope, period, currency, spendMinor: 2000, consultations: 10, thresholdMinor: 100, limitations: ["NO_BASELINE"] },
			events: [{ type: "opened", at: createdAt, reason: "internal_event_code" }],
		}] }),
		"GET /api/sessions": () => json({ items: [] }),
	});
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const { container } = render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<ComparisonPanel taskId={taskId} items={reports} mode="cost" />
				<ComparisonPanel taskId={taskId} items={reports} mode="comparison" />
				<ReviewFollowUps taskId={taskId} items={reports} taskVersions={[]} />
				<InvestigationAlertsPanel taskId={taskId} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	const cost = screen.getByText("检查本期成本", { exact: true }).closest("details");
	const comparison = screen.getByText("对比两期表现", { exact: true }).closest("details");
	assert.ok(cost && comparison && cost !== comparison);
	fireEvent.click(screen.getByText("检查本期成本", { exact: true }));
	fireEvent.click(screen.getByText("对比两期表现", { exact: true }));
	const costView = within(cost);
	const comparisonView = within(comparison);
	assert.ok(await costView.findByText("2 元/次"));
	assert.ok(costView.getByText(/超过提醒线（提醒线 1 元\/次）/));
	assert.ok(costView.getByText(/本期报表 · 2026-11-14 00:00/));
	assert.equal(costView.queryByLabelText("对照报表"), null);
	assert.ok(await comparisonView.findByText("两份报表认定结果来自广告的方式不同"));
	assert.equal(comparisonView.queryByText(/超过提醒线（提醒线/), null);

	fireEvent.change(costView.getByLabelText("本期报表"), { target: { value: current.evidenceId } });
	fireEvent.change(comparisonView.getByLabelText("本期报表"), { target: { value: current.evidenceId } });
	const compareButton = comparisonView.getByRole("button", { name: "对比两期报表" });
	assert.equal(compareButton.hasAttribute("disabled"), true);
	fireEvent.change(comparisonView.getByLabelText("对照报表"), { target: { value: previous.evidenceId } });
	assert.equal(calls.some((call) => call.startsWith("POST ")), false);
	fireEvent.click(costView.getByRole("button", { name: "检查成本" }));
	await waitFor(() => assert.deepEqual(comparisonRequests, [{ current: { evidenceId: current.evidenceId, version: 1 } }]));
	fireEvent.click(compareButton);
	await waitFor(() => assert.deepEqual(comparisonRequests[1], {
		current: { evidenceId: current.evidenceId, version: 1 },
		baseline: { evidenceId: previous.evidenceId, version: 2 },
	}));

	await screen.findByText("待跟进", { exact: true });
	fireEvent.click(screen.getByText("处理记录（1）"));
	assert.ok(screen.getByText(/08:01（北京时间） · 创建提醒/));
	assert.doesNotMatch(container.textContent ?? "", /ev_|NO_BASELINE|ATTRIBUTION_MISMATCH|period_comparison|internal[_-]|证据 ID|评估器/);

	fireEvent.click(await screen.findByText("复盘跟进", { exact: true }));
	const select = screen.getByLabelText("选择补充的报表");
	assert.ok(within(select).getByRole("option", { name: /2026-11-13.*20 元.*10 次/ }));
	fireEvent.change(select, { target: { value: previous.evidenceId } });
	assert.equal(calls.some((call) => call.endsWith("/resolve")), false);
	fireEvent.click(screen.getByRole("button", { name: "确认补充" }));
	assert.ok(await screen.findByText(/已完成 · /));
	assert.deepEqual(submitted, { material: { kind: "evidence", evidenceId: previous.evidenceId, version: 2 } });
});
