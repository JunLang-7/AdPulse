import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
import { USAGE, parseArgs } from "../scripts/acceptance/cli.mjs";
import { ConsoleApiError, authHeaders, createConsoleClient } from "../scripts/acceptance/console-api.mjs";
import { OUTBOUND_FAILURE_MESSAGE } from "../scripts/acceptance/fault-injection.mjs";
import { main } from "../scripts/acceptance/cli.mjs";
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
import { dbDownScenario } from "../scripts/acceptance/scenarios/db-down.mjs";
import { dmScenario } from "../scripts/acceptance/scenarios/dm.mjs";
import { failureScenario } from "../scripts/acceptance/scenarios/failure.mjs";
import { groupScenario } from "../scripts/acceptance/scenarios/group.mjs";
import { rejectScenario } from "../scripts/acceptance/scenarios/reject.mjs";
import { roundsScenario } from "../scripts/acceptance/scenarios/rounds.mjs";
import {
	MANAGED_DB_NAME,
	createManagedDocker,
	pointsAtManagedDb,
} from "../scripts/acceptance/docker.mjs";

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

test("console-api: 会话 Cookie 优先，副作用请求补同源 Origin", () => {
	assert.deepEqual(authHeaders({ sessionCookie: "abc" }), {
		cookie: "adpulse_session=abc",
	});
	assert.deepEqual(authHeaders({ sessionCookie: "abc", origin: "https://x" }, "POST"), {
		cookie: "adpulse_session=abc",
		origin: "https://x",
	});
	// cookie 存在时不回退 Bearer，避免误用已废弃的静态凭据。
	assert.deepEqual(authHeaders({ sessionCookie: "abc", token: "t" }), {
		cookie: "adpulse_session=abc",
	});
	assert.deepEqual(authHeaders({ token: "t" }), { authorization: "Bearer t" });
	assert.throws(() => authHeaders({}), /缺少控制台凭据/);
	assert.throws(() => authHeaders({ sessionCookie: "", token: "" }), /缺少控制台凭据/);
});

test("cli: 场景用到的开关都能解析（防止只加帮助文本漏加解析）", () => {
	const options = parseArgs([
		"--managed-db",
		"--keep",
		"--scenario",
		"db-down",
		"--other-open-id",
		"ou_other",
		"--chat-id",
		"oc_chat",
	]);
	assert.equal(options.managedDb, true);
	assert.equal(options.keep, true);
	assert.equal(options.scenario, "db-down");
	assert.equal(options.otherOpenId, "ou_other");
	assert.equal(options.chatId, "oc_chat");
	// 帮助文本里列出的每个开关都必须能被解析。
	for (const flag of USAGE.match(/--[a-z-]+/g) ?? []) {
		if (["--", "--help"].includes(flag)) continue;
		const booleanFlags = [
			"--list-scenarios",
			"--managed-db",
			"--keep",
			"--write",
			"--force",
			"--skip-preflight",
		];
		// 数值参数用合法值探测，其余用占位字符串。
		const probe = flag === "--step-timeout" ? "60" : "x";
		assert.doesNotThrow(
			() => parseArgs(booleanFlags.includes(flag) ? [flag] : [flag, probe]),
			`帮助文本列出的 ${flag} 未被解析`,
		);
	}
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
	command: {
		actionRef: string;
		actor?: { kind: string; externalId?: string };
	};
};

type FakeSession = {
	id: string;
	recipient: { accountId: string; kind: string; externalId: string };
	allowedActorIds: string[];
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
		lastError?: string;
	}>;
	snapshots: Array<{ version: number }>;
	jobs: Array<{
		id: string;
		status: string;
		attempts: number;
		leaseToken?: string;
		lastError?: string;
		task: { kind: string; deliveryId?: string };
	}>;
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
		failOutbound: false,
		async assertFaultInjection() { server.failOutbound = true; },
		/** 模拟某个真人在飞书客户端点一次卡片。 */
		humanClick(sessionId: string, optionId: string, actorId = "ou_test") {
			const session = sessions.get(sessionId);
			if (!session) throw new Error("unknown session");
			const round = session.rounds.at(-1);
			const action = session.actions.find(
				(item) => item.roundId === round?.id && item.optionId === optionId,
			);
			if (!action) throw new Error("unknown option");
			server.submitChoice(action.id, actorId);
		},
		createSession(input: Record<string, unknown>) {
			sequence += 1;
			const id = `sess-${sequence}`;
			const recipient = input.recipient as FakeSession["recipient"];
			if (recipient.kind === "group") throw new ConsoleApiError("personal sessions require a user recipient", 400, { error: "personal sessions require a user recipient" });
			const session: FakeSession = {
				id,
				recipient,
				allowedActorIds: [...((input.allowedActorIds as string[]) ?? [])],
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
				jobs: [],
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
			const unreachable = server.failOutbound;
			session.deliveries.push({
				id: `del-${roundId}`,
				roundId,
				purpose: "decision",
				status: unreachable ? "failed" : "sent",
				...(unreachable
					? { lastError: OUTBOUND_FAILURE_MESSAGE }
					: { externalMessageId: `om_${roundId}` }),
			});
			session.jobs.push({
				id: `job-${roundId}`,
				status: unreachable ? "failed" : "done",
				attempts: unreachable ? 5 : 1,
					leaseToken: `lease-${roundId}`,
				task: { kind: "send_delivery", deliveryId: `del-${roundId}` },
				...(unreachable
					? { lastError: OUTBOUND_FAILURE_MESSAGE }
					: {}),
			});
		},
		getSession(id: string) {
			const session = sessions.get(id);
			if (!session) throw new Error(`unknown session ${id}`);
			return {
				session: {
					id: session.id,
					recipient: session.recipient,
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
				jobs: session.jobs,
			};
		},
		submitChoice(actionRef: string, actorId = "ou_test") {
			sequence += 1;
			const id = `inbox-${sequence}`;
			const inbox: FakeInbox = {
				id,
				status: "pending",
				command: { actionRef, actor: { kind: "platform", externalId: actorId } },
			};
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
			if (!owner.allowedActorIds.includes(actorId)) {
				// 群成员身份不自动获得决策权：未授权点击直接拒绝且不改策略。
				owner.inbox.push(inbox);
				inbox.status = "rejected";
				inbox.reason = "forbidden";
			} else if (Date.parse(owner.expiresAt) <= clock.value) {
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
		retryJob(jobId: string) {
			for (const session of sessions.values()) {
				const job = session.jobs.find((item) => item.id === jobId);
				if (job) {
					job.status = "failed";
					job.attempts = 5;
					job.leaseToken = `retry-${job.leaseToken}`;
				}
			}
			return { ok: true };
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
	options: {
		clicks?: Array<string | { option: string; actor: string }>;
		openId?: string;
		chatId?: string;
		otherOpenId?: string;
	} = {},
) {
	const checks = createChecks({ defaultEvidence: EVIDENCE.platformReal });
	const clicks = [...(options.clicks ?? [])];
	const ctx = {
		record: checks.record,
		log: () => {},
		env: { FEISHU_ACCOUNT_ID: "feishu-internal" },
		options: {
			openId: options.openId ?? "ou_test",
			chatId: options.chatId ?? "oc_test_chat",
			otherOpenId: options.otherOpenId,
		},
		client: server,
		vars: {} as Record<string, unknown>,
		now: () => clock.value,
		// 每次轮询间隔等于「人过一会儿才点卡片」：把队列里的点击应用掉。
		sleep: async (ms: number) => {
			clock.value += ms;
			const next = clicks.shift();
			if (!next) return;
			if (typeof next === "string") server.humanClick(server.lastCreatedId, next);
			else server.humanClick(server.lastCreatedId, next.option, next.actor);
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

test("group 场景：个人身份拒绝群收件人，不发送卡片", async () => {
	const clock = { value: Date.parse("2026-11-08T00:00:00.000Z") };
	const server = fakeServer(clock);
	const { checks, ctx } = scenarioContext(server, clock);
	const outcome = await runScenario(groupScenario, ctx);
	assert.equal(outcome.matched, true);
	assert.equal(checks.results[0].id, "group.recipient-rejected");
	assert.equal(checks.results[0].status, "ok");
	assert.equal(checks.results[0].evidence, EVIDENCE.localReal);
	assert.equal(server.lastCreatedId, "");
});

test("reject 场景：未授权成员被拒且策略不变，授权成员随后生效", async () => {
	const clock = { value: Date.parse("2026-11-08T00:00:00.000Z") };
	const server = fakeServer(clock);
	const { checks, ctx } = scenarioContext(server, clock, {
		// 先由未授权成员点，再由授权成员点。
		clicks: [
			{ option: "acknowledge", actor: "ou_other" },
			"observe",
		],
		chatId: "oc_test_chat",
		openId: "ou_test",
		otherOpenId: "ou_other",
	});
	const outcome = await runScenario(rejectScenario, ctx);
	assert.equal(outcome.matched, true);
	assert.deepEqual(
		checks.results.map((item) => [item.id, item.status]),
		[
			["reject.card.delivered", "ok"],
			["reject.forbidden.rejected", "ok"],
			["reject.forbidden.no-effect", "ok"],
			["reject.forbidden.actor", "ok"],
			["reject.authorized.processed", "ok"],
			["reject.authorized.rejected-stays", "ok"],
		],
	);
	assert.match(checks.results[1].detail, /reason=forbidden/);
	assert.equal(checks.exitCode(), 0);
});

test("reject 场景：服务端把转发接收人当有权限时会判失败", async () => {
	const clock = { value: Date.parse("2026-11-08T00:00:00.000Z") };
	const server = fakeServer(clock);
	const { checks, ctx } = scenarioContext(server, clock, {
		clicks: [{ option: "acknowledge", actor: "ou_other" }, "observe"],
		chatId: "oc_test_chat",
		openId: "ou_test",
		otherOpenId: "ou_other",
	});
	// 模拟回归：未授权者被当作允许成员放行。
	const create = server.createSession.bind(server);
	server.createSession = (input: Record<string, unknown>) =>
		create({ ...input, allowedActorIds: ["ou_test", "ou_other"] });
	const outcome = await runScenario(rejectScenario, ctx);
	assert.equal(outcome.matched, true);
	const forbidden = checks.results.find(
		(item) => item.id === "reject.forbidden.rejected",
	);
	assert.equal(forbidden?.status, "fail");
	assert.match(forbidden?.detail ?? "", /status=processed/);
	assert.equal(checks.exitCode(), 1);
});

test("failure 场景：业务成功与投递失败分离，重试复用同一 delivery", async () => {
	const clock = { value: Date.parse("2026-11-08T00:00:00.000Z") };
	const server = fakeServer(clock);
	const { checks, ctx } = scenarioContext(server, clock, { clicks: [] });
	const outcome = await runScenario(failureScenario, ctx);
	assert.equal(outcome.matched, true);
	assert.deepEqual(
		checks.results.map((item) => [item.id, item.status]),
		[
			["failure.round1.delivery-failed", "ok"],
			["failure.round1.round-open", "ok"],
			["failure.business-succeeded", "ok"],
			["failure.delivery-still-failed", "ok"],
			["failure.retry-same-delivery", "ok"],
			["failure.retry-restarted", "ok"],
		],
	);
	assert.ok(checks.results[0].detail?.includes(OUTBOUND_FAILURE_MESSAGE));
	assert.ok(checks.results.every((item) => item.evidence === "synthetic"));
	assert.equal(checks.exitCode(), 0);
});

test("failure 场景：worker 已重跑但换新 delivery 时判失败", async () => {
	const clock = { value: Date.parse("2026-11-08T00:00:00.000Z") };
	const server = fakeServer(clock);
	const { checks, ctx } = scenarioContext(server, clock, { clicks: [] });
	// 模拟回归：新的 worker 执行已经终结，但重试错误地换了 delivery。
	server.retryJob = (jobId: string) => {
		const detail = server.getSession(server.lastCreatedId);
		const job = detail.jobs.find((item) => item.id === jobId);
		const oldId = (job?.task.deliveryId ?? "") as string;
		if (job && oldId) {
			job.attempts = 5;
			job.leaseToken = "retry-new-lease";
			job.task.deliveryId = `${oldId}-new`;
			detail.deliveries.push({
				id: `${oldId}-new`,
				roundId: oldId.replace("del-", ""),
				purpose: "decision",
				status: "failed",
				lastError: OUTBOUND_FAILURE_MESSAGE,
			});
		}
		return { ok: true };
	};
	const outcome = await runScenario(failureScenario, ctx);
	assert.equal(outcome.matched, true);
	assert.equal(checks.results.find((item) => item.id === "failure.retry-same-delivery")?.status, "fail");
});

test("docker: 只操作带前缀与自有 label 的容器", () => {
	const state = {
		names: new Set<string>(),
		labels: new Map<string, string>(),
		running: new Map<string, boolean>(),
	};
	const calls: string[][] = [];
	const run = (args: string[]) => {
		calls.push(args);
		const name = args.at(-1) ?? "";
		if (args[0] === "inspect") {
			if (!state.names.has(name)) return { status: 1, stdout: "", stderr: "no such" };
			const format = args.includes("--format") ? args[args.indexOf("--format") + 1] : "";
			if (format?.includes("Labels")) {
				return { status: 0, stdout: `${state.labels.get(name) ?? ""}\n`, stderr: "" };
			}
			if (format?.includes("State.Running")) {
				return { status: 0, stdout: `${state.running.get(name) ? "true" : "false"}\n`, stderr: "" };
			}
			return { status: 0, stdout: "{}", stderr: "" };
		}
		if (args[0] === "run") {
			const nameIndex = args.indexOf("--name");
			const name = args[nameIndex + 1] as string;
			const labelIndex = args.indexOf("--label");
			state.names.add(name);
			state.labels.set(name, String(args[labelIndex + 1]).split("=")[1] ?? "");
			state.running.set(name, true);
			return { status: 0, stdout: "cid\n", stderr: "" };
		}
		if (args[0] === "start") {
			state.running.set(args[1] as string, true);
			return { status: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "stop") {
			state.running.set(args[1] as string, false);
			return { status: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "rm") {
			const target = args[args.length - 1] as string;
			state.names.delete(target);
			return { status: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "exec") return { status: 0, stdout: "accepting", stderr: "" };
		return { status: 0, stdout: "", stderr: "" };
	};

	const docker = createManagedDocker({ run, log: () => {}, sleep: async () => {} });
	assert.equal(docker.ensureDb(), MANAGED_DB_NAME);
	const created = calls.find((args) => args[0] === "run");
	assert.ok(created?.includes("127.0.0.1:5433:5432"));
	assert.ok(created?.includes("adpulse.acceptance=1"));
	// stop → start 要恢复同一容器，因此不能带 --rm（stop 会直接删除容器）。
	assert.ok(!created?.includes("--rm"));
	assert.equal(state.names.has(MANAGED_DB_NAME), true);

	// 被停/被删都只针对已验证归属的容器。
	docker.stopDb();
	assert.equal(state.running.get(MANAGED_DB_NAME), false);
	docker.startDb();
	assert.equal(state.running.get(MANAGED_DB_NAME), true);

	// 缺自有 label 的容器必须拒绝操作。
	state.labels.set(MANAGED_DB_NAME, "");
	assert.throws(() => docker.stopDb(), /label/);
	state.labels.set(MANAGED_DB_NAME, "1");
	docker.cleanup();
	assert.equal(state.names.has(MANAGED_DB_NAME), false);
});

test("docker: 只有指向受管端口与库时允许停库", () => {
	assert.equal(
		pointsAtManagedDb("postgres://postgres:pw@127.0.0.1:5433/adpulse_acceptance"),
		true,
	);
	assert.equal(
		pointsAtManagedDb("postgres://postgres:pw@127.0.0.1:5432/adpulse"),
		false,
	);
	assert.equal(
		pointsAtManagedDb("postgres://postgres:pw@db.internal:5433/adpulse_acceptance"),
		false,
	);
	assert.equal(
		pointsAtManagedDb("postgres://postgres:pw@127.0.0.1:5433/other"),
		false,
	);
	assert.equal(pointsAtManagedDb(""), false);
});

test("db-down 场景：未授权停库时全部 skip，且不触碰 docker 与会话", async () => {
	const clock = { value: Date.parse("2026-11-08T00:00:00.000Z") };
	const server = fakeServer(clock);
	let sessionsCreated = 0;
	const create = server.createSession.bind(server);
	server.createSession = (input: Record<string, unknown>) => {
		sessionsCreated += 1;
		return create(input);
	};
	const { checks, ctx } = scenarioContext(server, clock, { clicks: [] });
	const outcome = await runScenario(dbDownScenario, ctx);
	assert.equal(outcome.matched, true);
	assert.equal(sessionsCreated, 0);
	assert.deepEqual(
		checks.results.map((item) => [item.id, item.status]),
		[
			["db-down.prepare.action", "skip"],
			["db-down.down.no-ack", "skip"],
			["db-down.recover.accepted", "skip"],
			["db-down.once.processed", "skip"],
			["db-down.once.round", "skip"],
		],
	);
	assert.match(checks.results[0].detail, /未提供 --managed-db/);
	assert.equal(checks.exitCode(), 0);
});

test("console-api: 会话凭据随请求发出，GET 不带 Origin，401 不回显凭据", async () => {
	const seen: Array<Record<string, unknown>> = [];
	let replyStatus = 200;
	const server = createServer((req, res) => {
		seen.push({ ...req.headers, method: req.method });
		res.writeHead(replyStatus, { "content-type": "application/json" });
		res.end(
			replyStatus === 200
				? JSON.stringify({ id: "session-1" })
				: JSON.stringify({ error: "unauthenticated" }),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const client = createConsoleClient({
		baseUrl: `http://127.0.0.1:${port}`,
		auth: { sessionCookie: "cookie-value", origin: "https://console.example.com" },
	});
	try {
		await client.createSession({ recipient: {} });
		// 副作用请求：带 Cookie + 同源 Origin，不带 Bearer。
		assert.equal(seen[0]?.cookie, "adpulse_session=cookie-value");
		assert.equal(seen[0]?.origin, "https://console.example.com");
		assert.equal(seen[0]?.authorization, undefined);

		await client.getSession("session-1");
		// 读取类请求不强制 Origin，但仍带 Cookie。
		assert.equal(seen[1]?.cookie, "adpulse_session=cookie-value");
		assert.equal(seen[1]?.origin, undefined);

		replyStatus = 401;
		await assert.rejects(
			() => client.getSession("session-1"),
			(error: Error) => {
				assert.match(error.message, /HTTP 401/);
				assert.ok(
					!error.message.includes("cookie-value"),
					"错误信息不得回显会话凭据",
				);
				return true;
			},
		);
	} finally {
		server.close();
	}
});

test("selfcheck: #34 之后 config.console 校验 PUBLIC_ORIGIN 形态", async () => {
	const run = async (env: Record<string, string>) => {
		const lines: string[] = [];
		const code = await main(
			["--api", "http://127.0.0.1:1"],
			env,
			{ log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) },
		);
		return { code, lines };
	};

	const good = await run({ PUBLIC_ORIGIN: "https://console.example.com" });
	assert.ok(
		good.lines.some(
			(line) =>
				line.startsWith("[ok  ] config.console") &&
				line.includes("https://console.example.com/auth/feishu/callback"),
		),
		good.lines.join("\n"),
	);

	// 非 HTTPS 与带路径的 origin 都必须判 fail：它们会让 Cookie/CORS 行为偏离预期。
	for (const bad of ["http://console.example.com", "https://console.example.com/app"]) {
		const result = await run({ PUBLIC_ORIGIN: bad });
		assert.ok(
			result.lines.some((line) => line.startsWith("[fail] config.console")),
			`${bad} 应判 fail：${result.lines.join("\n")}`,
		);
	}

	const missing = await run({});
	assert.ok(
		missing.lines.some((line) => line.startsWith("[fail] config.console")),
	);
	assert.equal(missing.code, 1, "存在 fail 时退出码非 0");
});

test("cli: 场景缺少控制台凭据时退出 2 并指出两种来源", async () => {
	const errors: string[] = [];
	const code = await main(
		["--scenario", "dm", "--open-id", "ou_x"],
		{},
		{ log: () => {}, error: (line: string) => errors.push(line) },
	);
	assert.equal(code, 2);
	assert.match(errors[0] ?? "", /ADPULSE_SESSION_COOKIE/);
	assert.match(errors[0] ?? "", /CONSOLE_TOKEN/);
});
