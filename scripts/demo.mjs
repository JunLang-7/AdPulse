import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const token = process.env.CONSOLE_TOKEN;
if (!token) throw new Error("CONSOLE_TOKEN is required");
const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";

async function call(path, init = {}) {
	const response = await fetch(baseUrl + path, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
	});
	const body = await response.json().catch(() => null);
	if (!response.ok)
		throw new Error(`${path} ${response.status} ${JSON.stringify(body)}`);
	return body;
}

const created = await call("/api/sessions", {
	method: "POST",
	headers: { "idempotency-key": randomUUID() },
	body: JSON.stringify({
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
	}),
});
const sessionId = created.id;

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const detail = await call(`/api/sessions/${sessionId}`);
		if (predicate(detail)) return detail;
		const failed = detail.jobs?.find((job) => job.status === "failed");
		if (failed) throw new Error("job failed: " + failed.lastError);
		await setTimeout(100);
	}
	throw new Error("demo timed out; check that the embedded worker is enabled");
}

async function choose(detail, optionId) {
	const round = detail.rounds.find((r) => r.roundNo === detail.session.roundNo);
	const action = detail.actions.find(
		(a) => a.roundId === round.id && a.optionId === optionId,
	);
	if (!action) throw new Error("expected action not available");
	await call("/api/choices", {
		method: "POST",
		headers: { "idempotency-key": randomUUID() },
		body: JSON.stringify({ actionRef: action.id }),
	});
}

const first = await waitFor(
	(d) => d.session.roundNo === 1 && d.session.status === "awaiting_input",
);
await choose(first, "observe");
const second = await waitFor(
	(d) => d.session.roundNo === 2 && d.session.status === "awaiting_input",
);
await choose(second, "acknowledge");
const final = await waitFor(
	(d) =>
		d.session.status === "completed" &&
		d.deliveries.length === 3 &&
		d.deliveries.every((x) => x.status === "sent"),
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
