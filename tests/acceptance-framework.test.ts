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

test("redact: 凭据、地址与数据库串只保留可判读部分", () => {
	assert.equal(mask(""), "(缺失)");
	assert.equal(mask("cli_a1b2c3d4e5f6g7"), "cli_a1***g7");
	assert.equal(mask("short"), "*****");
	assert.equal(
		maskUrl("https://internal.example.com:8443/webhooks/feishu-internal"),
		"https://***.example.com:8443/webhooks/feishu-internal",
	);
	assert.equal(maskUrl("https://127.0.0.1/webhooks/a"), "https://127.0.0.1/webhooks/a");
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
	assert.deepEqual(checks.counts(), { ok: 1, warn: 0, skip: 1, fail: 0, blocked: 0 });
	assert.equal(checks.results[0].evidence, "synthetic");

	checks.record("c", "标题 C", "fail", "失败", "修复它", {
		evidence: EVIDENCE.platformReal,
	});
	assert.equal(checks.results[2].evidence, "platform-real");
	assert.equal(checks.exitCode(), 1);

	// blocked 表示等待外部动作，不判失败。
	const waiting = createChecks();
	waiting.record("d", "标题 D", "blocked", "等待点击超时");
	assert.equal(waiting.exitCode(), 0);

	assert.throws(
		() => checks.record("e", "标题 E", "ok", "x", undefined, { evidence: "guess" }),
		/未知证据等级/,
	);
	assert.throws(() => checks.record("f", "标题 F", "done", "x"), /未知状态/);
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
	assert.ok(lines.some((line) => line.includes("通过 1 / 警告 1 / 跳过 0 / 失败 0")));
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
			prompt: "请在飞书点击「继续观察」",
			read: async () => ({ inbox: [] }),
			until: (state: { inbox: unknown[] }) => state.inbox.length > 0,
			intervalMs: 100,
			timeoutMs: 200,
			assertions: [{ id: "dm.x", title: "不应执行", check: () => verdict(true, "x") }],
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
			read: async (): Promise<DmState> => ({
				rounds: [{ status: "answered" }],
				version: 2,
			}),
			until: (state: DmState) => state.rounds[0]?.status === "answered",
			assertions: [
				{
					id: "dm.round1",
					title: "首轮已回答",
					check: (state: DmState) =>
						assertEqual(state.rounds[0]?.status, "answered", "rounds[0].status"),
				},
				{
					id: "dm.version",
					title: "版本递增",
					evidence: EVIDENCE.localReal,
					check: (state: DmState) =>
						verdict(state.version > 1, `version=${state.version}`),
				},
			],
		},
		{ record: checks.record, log: () => {} },
	);
	assert.equal(outcome.matched, true);
	assert.deepEqual(
		checks.results.map((item) => [item.id, item.status, item.evidence]),
		[
			["dm.round1", "ok", "platform-real"],
			["dm.version", "ok", "local-real"],
		],
	);
	assert.match(checks.results[0].detail, /rounds\[0\]\.status：实际 "answered"/);
});

test("scenario: 缺少必需字段直接拒绝，不静默放过", async () => {
	assert.throws(() => defineScenario({ id: "x" } as never), /缺少 title/);
	assert.throws(
		() =>
			defineScenario({
				id: "x",
				title: "x",
				read: async () => ({}),
				until: () => true,
				assertions: [],
			}),
		/至少有一个断言/,
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

test("record: 文件名按 UTC 分钟，同名默认不覆盖", () => {
	assert.equal(
		recordFileName(new Date("2026-11-08T11:15:46.248Z")),
		"2026-11-08-1115-feishu-e2e.md",
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
