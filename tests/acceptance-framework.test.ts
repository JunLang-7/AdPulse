import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	EVIDENCE,
	createChecks,
	printChecks,
} from "../scripts/acceptance/checks.mjs";
import { pollUntil } from "../scripts/acceptance/poll.mjs";
import {
	mask,
	maskBody,
	maskUrl,
	redactDatabaseUrl,
} from "../scripts/acceptance/redact.mjs";
import { parseArgs } from "../scripts/acceptance/cli.mjs";
import {
	recordFileName,
	renderRecord,
	writeRecord,
} from "../scripts/acceptance/record.mjs";
import {
	assertEqual,
	defineScenario,
	runScenario,
	verdict,
} from "../scripts/acceptance/scenario.mjs";
import { dmScenario } from "../scripts/acceptance/scenarios/dm.mjs";
import { roundsScenario } from "../scripts/acceptance/scenarios/rounds.mjs";

test("redact: 凭据、地址与数据库串只保留可判读部分", () => {
	assert.equal(mask(""), "(缺失)");
	assert.equal(mask("cli_a1b2c3d4e5f6g7"), "cli_a1***g7");
	assert.equal(mask("short"), "*****");
	assert.equal(
		maskUrl("https://internal.example.com:8443/webhooks/feishu-internal"),
		"https://***.example.com:8443/webhooks/feishu-internal",
	);
	assert.equal(
		maskUrl("https://127.0.0.1/webhooks/a"),
		"https://127.0.0.1/webhooks/a",
	);
	assert.equal(
		redactDatabaseUrl("postgres://user:secret@127.0.0.1:5433/adpulse_test"),
		"postgres://127.0.0.1:5433/adpulse_test",
	);
	assert.equal(maskBody(undefined), "(无响应体)");
	assert.equal(maskBody({ code: 0 }), '{"code":0}');
	assert.ok(maskBody({ raw: "x".repeat(400) }).endsWith("…"));
});

test("checks: 汇总计数与退出码口径，未知证据等级直接报错", () => {
	const checks = createChecks({ defaultEvidence: EVIDENCE.synthetic });
	checks.record("a", "标题 A", "ok", "通过");
	checks.record("b", "标题 B", "skip", "跳过");
	assert.equal(checks.exitCode(), 0);
	assert.deepEqual(checks.counts(), {
		ok: 1,
		warn: 0,
		skip: 1,
		fail: 0,
		blocked: 0,
	});
	assert.equal(checks.results[0].evidence, "synthetic");

	checks.record("c", "标题 C", "fail", "失败", "修复它", {
		evidence: EVIDENCE.platformReal,
	});
	assert.equal(checks.results[2].evidence, "platform-real");
	assert.equal(checks.exitCode(), 1);

	const waiting = createChecks();
	waiting.record("d", "标题 D", "blocked", "等待点击超时");
	assert.equal(waiting.exitCode(), 0);

	assert.throws(
		() => checks.record("e", "E", "ok", "x", undefined, { evidence: "guess" }),
		/未知证据等级/,
	);
	assert.throws(() => checks.record("f", "F", "done", "x"), /未知状态/);
});

test("checks: 终端输出保持既有格式，blocked 单独成行", () => {
	const lines: string[] = [];
	const checks = createChecks();
	checks.record("config.feishu", "飞书应用配置", "ok", "account=x");
	checks.record("local.api", "本机 API", "warn", "不可达", "先启动服务");
	checks.record("dm", "单聊链路", "blocked", "等待超时");
	printChecks(checks.results, (line: string) => lines.push(line));
	assert.equal(lines[0], "[ok  ] config.feishu          account=x");
	assert.equal(lines[1], "[warn] local.api              不可达");
	assert.equal(lines[2], "          ↳ 先启动服务");
	assert.match(lines[3] ?? "", /^\[bloc/);
	assert.ok(
		lines.some((line) => line.includes("通过 1 / 警告 1 / 跳过 0 / 失败 0")),
	);
	assert.ok(lines.includes("阻塞 1（等待外部动作或超时，不计入验收）"));
});

test("pollUntil: 用注入时钟等到状态迁移，超时不抛错", async () => {
	let clock = 0;
	let state = { round: 1, answered: false };
	const matched = await pollUntil({
		read: async () => state,
		until: (value) => value.answered,
		intervalMs: 100,
		timeoutMs: 500,
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
			if (clock >= 200) state = { round: 1, answered: true };
		},
	});
	assert.equal(matched.matched, true);
	assert.equal(matched.samples, 3);
	assert.equal(matched.elapsedMs, 200);

	clock = 0;
	const timedOut = await pollUntil({
		read: async () => ({ answered: false }),
		until: (value) => value.answered,
		intervalMs: 100,
		timeoutMs: 250,
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
	});
	assert.equal(timedOut.matched, false);
	assert.equal(timedOut.elapsedMs, 200);

	const failed = await pollUntil({
		read: async () => {
			throw new Error("connection refused");
		},
		until: () => true,
		now: () => 0,
		sleep: async () => {},
	});
	assert.equal(failed.matched, false);
	assert.match(failed.error?.message ?? "", /connection refused/);
});

test("scenario: 未等到人工动作记 blocked，不判 fail", async () => {
	const checks = createChecks();
	let clock = 0;
	const outcome = await runScenario(
		{
			id: "dm",
			title: "单聊链路",
			evidence: EVIDENCE.platformReal,
			steps: [
				{
					id: "dm.round1",
					prompt: "请点击「继续观察」",
					read: async () => ({ inbox: [] as unknown[] }),
					until: (state) => state.inbox.length > 0,
					intervalMs: 100,
					timeoutMs: 200,
					assertions: [
						{
							id: "dm.x",
							title: "不应执行",
							check: () => verdict(true, "x"),
						},
					],
				},
			],
		},
		{
			record: checks.record,
			log: () => {},
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		},
	);
	assert.equal(outcome.matched, false);
	assert.equal(outcome.aborted, true);
	assert.equal(checks.results.length, 1);
	assert.equal(checks.results[0].status, "blocked");
	assert.equal(checks.results[0].evidence, "platform-real");
	assert.equal(checks.exitCode(), 0);
});

test("scenario: 命中后逐条落断言，证据等级可覆盖", async () => {
	const checks = createChecks();
	type DmState = { rounds: Array<{ status: string }>; version: number };
	const outcome = await runScenario(
		{
			id: "dm",
			title: "单聊链路",
			evidence: EVIDENCE.platformReal,
			steps: [
				{
					id: "dm.round1",
					read: async (): Promise<DmState> => ({
						rounds: [{ status: "answered" }],
						version: 2,
					}),
					until: (state) => state.rounds[0]?.status === "answered",
					assertions: [
						{
							id: "dm.round1.selected",
							title: "首轮已回答",
							check: (state) =>
								assertEqual(
									state.rounds[0]?.status,
									"answered",
									"rounds[0].status",
								),
						},
						{
							id: "dm.version",
							title: "版本递增",
							evidence: EVIDENCE.localReal,
							check: (state) => verdict(state.version > 1, `version=${state.version}`),
						},
					],
				},
			],
		},
		{ record: checks.record, log: () => {} },
	);
	assert.equal(outcome.matched, true);
	assert.deepEqual(
		checks.results.map((item) => [item.id, item.status, item.evidence]),
		[
			["dm.round1.selected", "ok", "platform-real"],
			["dm.version", "ok", "local-real"],
		],
	);
	assert.match(checks.results[0].detail, /rounds\[0\]\.status：实际 "answered"/);
});

test("scenario: 多步骤 stopOnFail 时后续步骤记 skip 而不是继续等待", async () => {
	const checks = createChecks();
	const outcome = await runScenario(
		{
			id: "dm",
			title: "单聊链路",
			steps: [
				{
					id: "dm.round1",
					stopOnFail: true,
					read: async () => ({ selectedOptionId: "ignore", status: "open" }),
					until: () => true,
					assertions: [
						{
							id: "dm.round1.selected",
							title: "记录所选选项",
							check: (state) =>
								assertEqual(state.selectedOptionId, "observe", "option"),
						},
					],
				},
				{
					id: "dm.round2",
					read: async () => ({ selectedOptionId: "observe", status: "completed" }),
					until: (state) => state.status === "completed",
				},
			],
		},
		{ record: checks.record, log: () => {} },
	);
	assert.equal(outcome.aborted, true);
	assert.deepEqual(
		checks.results.map((item) => [item.id, item.status]),
		[
			["dm.round1.selected", "fail"],
			["dm.aborted", "skip"],
		],
	);
	assert.match(checks.results[1].detail, /未执行 dm\.round2/);
	assert.equal(checks.exitCode(), 1);
});

test("scenario: 缺少必需字段直接拒绝，不静默放过", async () => {
	assert.throws(() => defineScenario({ id: "x" } as never), /缺少 title/);
	assert.throws(
		() => defineScenario({ id: "x", title: "x", steps: [] } as never),
		/至少有一个步骤/,
	);
	assert.throws(
		() =>
			defineScenario({
				id: "x",
				title: "x",
				steps: [{ read: async () => ({}) }],
			} as never),
		/缺少 until/,
	);
	assert.throws(
		() =>
			defineScenario({
				id: "x",
				title: "x",
				steps: [
					{
						read: async () => ({}),
						until: () => true,
						assertions: [{ id: "a", title: "t" }],
					},
				],
			} as never),
		/断言缺少 id \/ title \/ check/,
	);
	await assert.rejects(runScenario({ id: "x" } as never, { record: () => {} }), /缺少/);
});

test("record: 渲染来源列与证据分级说明，表格内容转义", () => {
	const checks = createChecks();
	checks.record("config.feishu", "飞书 | 应用配置", "ok", "a|b");
	const content = renderRecord({
		title: "测试记录",
		generator: "`scripts/feishu-acceptance.mjs`",
		meta: [["环境 commit", "abc1234"]],
		results: checks.results,
		manualItems: [{ title: "单聊链路", mode: "真人操作" }],
		footerLines: ["结论行"],
	});
	assert.match(content, /\| 检查 \| 结果 \| 来源 \| 判定依据（已脱敏） \|/);
	assert.match(content, /飞书 \\\| 应用配置 .* local-real .* a\\\|b/);
	assert.match(content, /`platform-real`：平台真实推送或真实用户交互/);
	assert.match(content, /\| 单聊链路 \| 真人操作 \|/);
	assert.match(content, /\| 环境 commit \| abc1234 \|/);
	assert.match(content, /结论行/);
});

test("cli: --step-timeout 换算为毫秒并拒绝非法值", () => {
	assert.equal(parseArgs(["--step-timeout", "1800"]).stepTimeoutMs, 1_800_000);
	assert.equal(parseArgs(["--step-timeout=90"]).stepTimeoutMs, 90_000);
	assert.throws(() => parseArgs(["--step-timeout", "0"]), /正数秒/);
	assert.throws(() => parseArgs(["--step-timeout", "abc"]), /正数秒/);
	assert.equal(parseArgs([]).stepTimeoutMs, undefined);
});

test("record: 文件名按 UTC 分钟，同名默认不覆盖", () => {
	assert.equal(
		recordFileName(new Date("2026-11-08T11:15:46.248Z")),
		"2026-11-08-1115-feishu-e2e.md",
	);
	assert.equal(
		recordFileName(new Date("2026-11-08T11:15:46.248Z"), "scenario-dm"),
		"2026-11-08-1115-scenario-dm.md",
	);
	const written: string[] = [];
	const log = (line: string) => written.push(line);
	const dir = mkdtempSync(join(tmpdir(), "adpulse-acceptance-"));
	try {
		assert.notEqual(writeRecord(dir, "a.md", "first", { log }), "");
		assert.equal(writeRecord(dir, "a.md", "second", { log }), "");
		assert.match(written.at(-1) ?? "", /记录已存在，未覆盖/);
		assert.notEqual(writeRecord(dir, "a.md", "second", { force: true, log }), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------- 场景：用内存假服务端驱动，验证断言真的会判失败 ----------

type FakeRound = {
	id: string;
	roundNo: number;
	status: string;
	selectedOptionId?: string;
	selectedBy?: { kind: string; externalId?: string };
	candidates: Array<{ id: string; label: string; complete: boolean }>;
};

type FakeInbox = {
	id: string;
	status: string;
	reason?: string;
	command: { actionRef: string };
};

type FakeSession = {
	id: string;
	status: string;
	version: number;
	roundNo: number;
	expiresAt: string;
	rounds: FakeRound[];
	actions: Array<{ id: string; roundId: string; optionId: string }>;
	inbox: FakeInbox[];
	deliveries: Array<{
		id: string;
		roundId: string;
		purpose: string;
		status: string;
		externalMessageId?: string;
	}>;
	snapshots: Array<{ version: number }>;
};

const CANDIDATES = [
	{ id: "acknowledge", label: "确认已阅", complete: true },
	{ id: "observe", label: "继续观察", complete: false },
	{ id: "ignore", label: "忽略此条", complete: true },
];

function fakeServer(clock: { value: number }) {
	const sessions = new Map<string, FakeSession>();
	const choices = new Map<string, FakeInbox>();
	let sequence = 0;
	const server = {
		lastCreatedId: "",
		/** 置 true 可模拟「服务端缺少已答轮次校验」的回归。 */
		acceptStale: false,
		/** 模拟真人在飞书客户端点一次卡片。 */
		humanClick(sessionId: string, optionId: string) {
			const session = sessions.get(sessionId);
			if (!session) throw new Error("unknown session");
			const round = session.rounds.at(-1);
			const action = session.actions.find(
				(item) => item.roundId === round?.id && item.optionId === optionId,
			);
			if (!action) throw new Error("unknown option");
			server.submitChoice(action.id);
		},
		createSession(input: Record<string, unknown>) {
			sequence += 1;
			const id = `sess-${sequence}`;
			const session: FakeSession = {
				id,
				status: "awaiting_input",
				version: 0,
				roundNo: 1,
				expiresAt: String(input.expiresAt),
				rounds: [],
				actions: [],
				inbox: [],
				deliveries: [],
				// 真实服务端在建会话时即写入一条 version=0 的初始快照。
				snapshots: [{ version: 0 }],
			};
			sessions.set(id, session);
			server.openRound(session, 1);
			server.lastCreatedId = id;
			return { ...session };
		},
		openRound(session: FakeSession, roundNo: number) {
			const roundId = `${session.id}-r${roundNo}`;
			session.rounds.push({
				id: roundId,
				roundNo,
				status: "open",
				candidates: CANDIDATES,
			});
			for (const candidate of CANDIDATES)
				session.actions.push({
					id: `act-${roundId}-${candidate.id}`,
					roundId,
					optionId: candidate.id,
				});
			session.deliveries.push({
				id: `del-${roundId}`,
				roundId,
				purpose: "decision",
				status: "sent",
				externalMessageId: `om_${roundId}`,
			});
		},
		getSession(id: string) {
			const session = sessions.get(id);
			if (!session) throw new Error(`unknown session ${id}`);
			return {
				session: {
					id: session.id,
					status: session.status,
					version: session.version,
					roundNo: session.roundNo,
					expiresAt: session.expiresAt,
				},
				rounds: session.rounds,
				actions: session.actions,
				inbox: session.inbox,
				deliveries: session.deliveries,
				snapshots: session.snapshots,
				jobs: [],
			};
		},
		submitChoice(actionRef: string) {
			sequence += 1;
			const id = `inbox-${sequence}`;
			const inbox: FakeInbox = { id, status: "pending", command: { actionRef } };
			choices.set(id, inbox);
			const owner = [...sessions.values()].find((session) =>
				session.actions.some((action) => action.id === actionRef),
			);
			if (!owner) {
				inbox.status = "rejected";
				inbox.reason = "unknown_action";
				return { inboxId: id, status: inbox.status };
			}
			const action = owner.actions.find((item) => item.id === actionRef);
			const round = owner.rounds.find((item) => item.id === action?.roundId);
			if (Date.parse(owner.expiresAt) <= clock.value) {
				inbox.status = "rejected";
				inbox.reason = "expired";
			} else if (round?.status !== "open" && !server.acceptStale) {
				inbox.status = "rejected";
				inbox.reason = "already_handled";
			} else if (round && action) {
				round.status = "answered";
				round.selectedOptionId = action.optionId;
				round.selectedBy = { kind: "platform", externalId: "ou_test" };
				owner.version += 1;
				owner.snapshots.push({ version: owner.version });
				owner.inbox.push(inbox);
				inbox.status = "processed";
				const candidate = round.candidates.find(
					(item) => item.id === action.optionId,
				);
				if (candidate?.complete) {
					owner.status = "completed";
					owner.deliveries.push({
						id: `del-${owner.id}-confirmation`,
						roundId: round.id,
						purpose: "confirmation",
						status: "sent",
						externalMessageId: "om_confirmation",
					});
				} else {
					owner.roundNo += 1;
					owner.status = "awaiting_input";
					server.openRound(owner, owner.roundNo);
				}
			}
			return { inboxId: id, status: inbox.status };
		},
		getChoice(inboxId: string) {
			const inbox = choices.get(inboxId);
			if (!inbox) throw new Error(`unknown inbox ${inboxId}`);
			return { ...inbox };
		},
	};
	return server;
}

function scenarioContext(
	server: ReturnType<typeof fakeServer>,
	clock: { value: number },
	options: { clicks?: string[]; openId?: string } = {},
) {
	const checks = createChecks({ defaultEvidence: EVIDENCE.platformReal });
	const clicks = [...(options.clicks ?? [])];
	const ctx = {
		record: checks.record,
		log: () => {},
		env: { FEISHU_ACCOUNT_ID: "feishu-internal" },
		options: { openId: options.openId ?? "ou_test" },
		client: server,
		vars: {} as Record<string, unknown>,
		now: () => clock.value,
		// 每次轮询间隔等于「人过一会儿才点卡片」：把队列里的点击应用掉。
		sleep: async (ms: number) => {
			clock.value += ms;
			const next = clicks.shift();
			if (next) server.humanClick(server.lastCreatedId, next);
		},
	};
	return { checks, ctx };
}

test("dm 场景：两次点击后全部断言通过（platform-real）", async () => {
	const clock = { value: Date.parse("2026-11-08T00:00:00.000Z") };
	const server = fakeServer(clock);
	const { checks, ctx } = scenarioContext(server, clock, {
		clicks: ["observe", "acknowledge"],
	});
	const outcome = await runScenario(dmScenario, ctx);
	assert.equal(outcome.matched, true);
	assert.equal(outcome.aborted, false);
	assert.deepEqual(
		checks.results.map((item) => [item.id, item.status]),
		[
			["dm.card.delivered", "ok"],
			["dm.card.round", "ok"],
			["dm.card.options", "ok"],
			["dm.round1.selected", "ok"],
			["dm.round1.persisted", "ok"],
			["dm.round1.inbox", "ok"],
			["dm.round1.observed-interval", "skip"],
			["dm.round2-card.delivered", "ok"],
			["dm.completed", "ok"],
			["dm.round2.selected", "ok"],
			["dm.round2.persisted", "ok"],
		],
	);
	// 观测区间是 skip（含人工耗时，不计入验收），因此证据等级为 local-real。
	assert.ok(
		checks.results.every((item) =>
			item.id === "dm.round1.observed-interval"
				? item.evidence === "local-real"
				: item.evidence === "platform-real",
		),
	);
	assert.equal(checks.exitCode(), 0);
});

test("dm 场景：点错按钮时在第一个失败处停下并带出原因", async () => {
	const clock = { value: Date.parse("2026-11-08T00:00:00.000Z") };
	const server = fakeServer(clock);
	const { checks, ctx } = scenarioContext(server, clock, { clicks: ["ignore"] });
	const outcome = await runScenario(dmScenario, ctx);
	assert.equal(outcome.aborted, true);
	const selected = checks.results.find((item) => item.id === "dm.round1.selected");
	assert.equal(selected?.status, "fail");
	assert.match(selected?.detail ?? "", /option=ignore actor=platform\/\*+/);
	const aborted = checks.results.find((item) => item.id === "dm.aborted");
	assert.equal(aborted?.status, "skip");
	assert.match(aborted?.detail ?? "", /未执行 dm\.round2/);
	assert.equal(checks.exitCode(), 1);
});

test("dm 场景：没人点击时记 blocked 而不是 fail", async () => {
	const clock = { value: Date.parse("2026-11-08T00:00:00.000Z") };
	const server = fakeServer(clock);
	const { checks, ctx } = scenarioContext(server, clock, { clicks: [] });
	const outcome = await runScenario(dmScenario, ctx);
	assert.equal(outcome.matched, false);
	assert.equal(outcome.aborted, true);
	const blocked = checks.results.at(-1);
	assert.equal(blocked?.status, "blocked");
	assert.match(blocked?.detail ?? "", /等待超时/);
	assert.equal(checks.exitCode(), 0);
});

test("rounds 场景：旧卡与重复提交被拒、过期提交被拒", async () => {
	const clock = { value: Date.parse("2026-11-08T00:00:00.000Z") };
	const server = fakeServer(clock);
	const { checks, ctx } = scenarioContext(server, clock, { clicks: ["observe"] });
	const outcome = await runScenario(roundsScenario, ctx);
	assert.equal(outcome.matched, true);
	assert.deepEqual(
		checks.results.map((item) => [item.id, item.status]),
		[
			["rounds.card.delivered", "ok"],
			["rounds.round1.answered", "ok"],
			["rounds.round1.inbox", "ok"],
			["rounds.stale.rejected", "ok"],
			["rounds.repeat.rejected", "ok"],
			["rounds.repeat.no-effect", "ok"],
			["rounds.expired.rejected", "ok"],
		],
	);
	assert.match(checks.results[3].detail, /reason=already_handled/);
	assert.match(checks.results[6].detail, /reason=expired/);
	assert.equal(checks.exitCode(), 0);
});

test("rounds 场景：服务端把重复提交当成功时会判失败", async () => {
	const clock = { value: Date.parse("2026-11-08T00:00:00.000Z") };
	const server = fakeServer(clock);
	const { checks, ctx } = scenarioContext(server, clock, { clicks: ["observe"] });
	// 模拟服务端缺少「已答轮次」校验：旧卡会被再次处理。
	server.acceptStale = true;
	const outcome = await runScenario(roundsScenario, ctx);
	assert.equal(outcome.matched, true);
	const stale = checks.results.find((item) => item.id === "rounds.stale.rejected");
	assert.equal(stale?.status, "fail");
	assert.match(stale?.detail ?? "", /status=processed/);
	const drift = checks.results.find(
		(item) => item.id === "rounds.repeat.no-effect",
	);
	assert.equal(drift?.status, "fail");
	assert.equal(checks.exitCode(), 1);
});
