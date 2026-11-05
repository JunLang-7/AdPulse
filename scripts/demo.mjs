import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { createConsoleClient } from "../apps/console/dist/index.js";

const token = process.env.CONSOLE_TOKEN;
if (!token) throw new Error("CONSOLE_TOKEN is required");
const client = createConsoleClient(
	process.env.API_BASE_URL ?? "http://127.0.0.1:3000",
	token,
);
const created = await client.POST("/api/sessions", {
	params: { header: { "Idempotency-Key": randomUUID() } },
	body: {
		recipient: { accountId: "demo", kind: "user", externalId: "demo-user" },
		allowedActorIds: ["demo-user"],
		strategy: {
			objective: "验证决策交互",
			audience: [],
			channels: {},
			sellingPoints: [],
		},
		limits: { maxBudgetChangeRatio: 0.2, maxBidChangeRatio: 0.2 },
		signal: {
			id: randomUUID(),
			title: "演示提醒",
			summary: "这是模拟数据，不代表真实市场变化。",
			evidence: [{ label: "来源", value: "本地演示" }],
		},
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
	},
});
if (!created.data) throw new Error(JSON.stringify(created.error));
const sessionId = created.data.id;
async function waitFor(predicate) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const result = await client.GET("/api/sessions/{sessionId}", {
			params: { path: { sessionId } },
		});
		if (!result.data) throw new Error(JSON.stringify(result.error));
		if (predicate(result.data)) return result.data;
		const failed = result.data.jobs.find((job) => job.status === "failed");
		if (failed) throw new Error(`job failed: ${failed.lastError}`);
		await setTimeout(100);
	}
	throw new Error("demo timed out; check that the embedded worker is enabled");
}
async function choose(detail, optionId) {
	const round = detail.rounds.find(
		(round) => round.roundNo === detail.session.roundNo,
	);
	const action = detail.actions.find(
		(action) => action.roundId === round.id && action.optionId === optionId,
	);
	if (!action) throw new Error("expected action not available");
	const result = await client.POST("/api/choices", {
		body: { actionRef: action.id },
		params: { header: { "Idempotency-Key": randomUUID() } },
	});
	if (!result.data) throw new Error(JSON.stringify(result.error));
}
const first = await waitFor(
	(detail) =>
		detail.session.roundNo === 1 && detail.session.status === "awaiting_input",
);
await choose(first, "observe");
const second = await waitFor(
	(detail) =>
		detail.session.roundNo === 2 && detail.session.status === "awaiting_input",
);
await choose(second, "acknowledge");
const final = await waitFor(
	(detail) =>
		detail.session.status === "completed" &&
		detail.deliveries.length === 3 &&
		detail.deliveries.every((delivery) => delivery.status === "sent"),
);
console.log(
	JSON.stringify(
		{
			sessionId,
			rounds: final.rounds.length,
			snapshots: final.snapshots.length,
			deliveries: final.deliveries.length,
			status: final.session.status,
		},
		null,
		2,
	),
);
