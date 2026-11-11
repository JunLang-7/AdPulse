// 验收脚本入口：解析参数、执行自检或场景、输出结果与记录。
// 默认行为是飞书只读自检（与 #21 一致）；--scenario 走 #49 的场景驱动器。

import { resolve } from "node:path";

import { EVIDENCE, createChecks, printChecks } from "./checks.mjs";
import { authHeaders, createConsoleClient } from "./console-api.mjs";
import { mask } from "./redact.mjs";
import { recordFileName, renderRecord, writeRecord } from "./record.mjs";
import { runScenario } from "./scenario.mjs";
import {
	findScenario,
	listScenarios,
	scenarioRequires,
} from "./scenarios/index.mjs";
import { runFeishuSelfCheck } from "./selfcheck-feishu.mjs";
import { ROOT, gitCommit } from "./workspace.mjs";

const RECORDS = resolve(ROOT, "docs/acceptance/records");

export const USAGE = `用法：bun run feishu:acceptance [-- 选项]

  --api <url>         本机 API 地址，默认 http://127.0.0.1:3000
  --public-url <url>  公网回调地址，如 https://example.com/webhooks/feishu-internal
  --chat-id <oc_...>  群收件人；group 拒绝场景必填
  --open-id <ou_...>  授权成员（单聊收件人）；--scenario 时多数必填
  --other-open-id <ou_...>
                      未授权成员，仅 reject 场景需要
  --scenario <id>     运行验收场景；先跑只读自检作为前置
  --list-scenarios    列出可用场景
  --step-timeout <s>  场景单步等待人工动作的秒数，默认用场景内置值
  --managed-db        允许 db-down 场景停启本脚本自建的一次性数据库
  --keep              场景结束后保留一次性容器（默认清理）
  --skip-preflight    跳过场景前置自检（仅本地调试，不能用于真机留证）
  --write             生成验收记录 docs/acceptance/records/<日期>.md
  --force             覆盖同名验收记录
  --help              显示本帮助

自检只读：不会发送业务消息，不写业务数据。
场景会新建验收会话并按提示请你在飞书客户端点击；不修改既有数据。`;

export class UsageError extends Error {}

export function parseArgs(argv) {
	const options = {
		api: "http://127.0.0.1:3000",
		publicUrl: undefined,
		chatId: undefined,
		openId: undefined,
		otherOpenId: undefined,
		scenario: undefined,
		listScenarios: false,
		stepTimeoutMs: undefined,
		managedDb: false,
		keep: false,
		skipPreflight: false,
		write: false,
		force: false,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const [flag, inline] = argv[index].split(/=(.*)/s);
		const value = () => {
			if (inline !== undefined) return inline;
			const next = argv[index + 1];
			if (next === undefined) throw new UsageError(`缺少 ${flag} 的值`);
			index += 1;
			return next;
		};
		if (flag === "--api") options.api = value().replace(/\/+$/, "");
		else if (flag === "--public-url")
			options.publicUrl = value().replace(/\/+$/, "");
		else if (flag === "--chat-id") options.chatId = value();
		else if (flag === "--open-id") options.openId = value();
		else if (flag === "--other-open-id") options.otherOpenId = value();
		else if (flag === "--scenario") options.scenario = value();
		else if (flag === "--list-scenarios") options.listScenarios = true;
		else if (flag === "--step-timeout") {
			const seconds = Number(value());
			if (!Number.isFinite(seconds) || seconds <= 0)
				throw new UsageError("--step-timeout 需要正数秒");
			options.stepTimeoutMs = Math.round(seconds * 1000);
		} else if (flag === "--skip-preflight") options.skipPreflight = true;
		else if (flag === "--managed-db") options.managedDb = true;
		else if (flag === "--keep") options.keep = true;
		else if (flag === "--write") options.write = true;
		else if (flag === "--force") {
			options.write = true;
			options.force = true;
		} else if (flag === "--help" || flag === "-h") options.help = true;
		else throw new UsageError(`未知参数：${flag}`);
	}
	return options;
}

function printScenarioList(log) {
	const items = listScenarios();
	log("可用场景：\n");
	for (const item of items) {
		log(
			`  ${item.id.padEnd(8)} ${item.title}（${item.steps} 步，证据 ${item.evidence}）`,
		);
		if (item.requires.length)
			log(`           ↳ 需要 ${item.requires.map((key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(" / ")}`);
	}
	log("\n场景会请求在飞书客户端完成点击；其余断言与留证由脚本完成。");
}

/**
 * 场景前置自检：fail 非零即中止，避免在错配置上让人白点一遍。
 * @returns {Promise<boolean>} 是否通过
 */
async function runPreflight({ env, options, log }) {
	const checks = createChecks();
	await runFeishuSelfCheck({ env, options, checks });
	printChecks(checks.results, log);
	if (checks.exitCode() === 0) return true;
	log(
		"\n前置自检存在 fail：已中止场景。修复后重跑；仅本地调试可加 --skip-preflight（不能用于真机留证）。",
	);
	return false;
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {{ log?: (line: string) => void, error?: (line: string) => void, now?: () => Date }} [io]
 * @returns {Promise<number>} 进程退出码
 */
export async function main(argv, env, io = {}) {
	const log = io.log ?? console.log;
	const error = io.error ?? console.error;
	const now = io.now ?? (() => new Date());

	let options;
	try {
		options = parseArgs(argv);
	} catch (cause) {
		if (cause instanceof UsageError) {
			error(cause.message);
			return 2;
		}
		throw cause;
	}
	if (options.help) {
		log(USAGE);
		return 0;
	}
	if (options.listScenarios) {
		printScenarioList(log);
		return 0;
	}
	if (options.scenario) {
		const scenario = findScenario(options.scenario);
		if (!scenario) {
			error(
				`未知场景：${options.scenario}（可用：${listScenarios()
					.map((item) => item.id)
					.join(" / ")}）`,
			);
			return 2;
		}
		const requirementFlags = {
			openId: "--open-id <ou_...>",
			otherOpenId: "--other-open-id <ou_...>",
			chatId: "--chat-id <oc_...>",
		};
		for (const requirement of scenarioRequires(scenario.id)) {
			if (!options[requirement]) {
				error(`场景 ${scenario.id} 需要 ${requirementFlags[requirement]}`);
				return 2;
			}
		}
		// #34 之后控制台改用 OAuth 会话：用 ADPULSE_SESSION_COOKIE + PUBLIC_ORIGIN；
		// 未升级的部署仍可用 CONSOLE_TOKEN。凭据缺失时直接拒绝并说明来源。
		const auth = {
			token: env.CONSOLE_TOKEN && env.CONSOLE_TOKEN.length >= 24 ? env.CONSOLE_TOKEN : undefined,
			sessionCookie: env.ADPULSE_SESSION_COOKIE || undefined,
			origin: env.PUBLIC_ORIGIN || undefined,
		};
		try {
			authHeaders(auth);
		} catch (cause) {
			error(cause instanceof Error ? cause.message : String(cause));
			return 2;
		}
		if (!options.skipPreflight) {
			log("== 前置只读自检 ==");
			if (!(await runPreflight({ env, options, log }))) return 1;
			log("\n== 场景 ==");
		}

		const checks = createChecks({ defaultEvidence: EVIDENCE.platformReal });
		const vars = {};
		const effective =
			options.stepTimeoutMs === undefined
				? scenario
				: { ...scenario, timeoutMs: options.stepTimeoutMs };
		const completed = await runScenario(effective, {
			record: checks.record,
			log,
			env,
			options,
			client: createConsoleClient({ baseUrl: options.api, auth }),
			vars,
			now: () => now().getTime(),
		});
		printChecks(checks.results, log);

		if (options.write) {
			const content = renderRecord({
				title: `${scenario.title}（场景编排记录）`,
				generator: "`scripts/feishu-acceptance.mjs --scenario`",
				meta: [
					["执行时间", now().toISOString()],
					["环境 commit", gitCommit()],
					["场景", `${scenario.id}（${scenario.steps.length} 步）`],
					[
						"人工窗口",
						options.stepTimeoutMs === undefined
							? `${scenario.timeoutMs / 1000}s（场景默认）`
							: `${options.stepTimeoutMs / 1000}s（--step-timeout）`,
					],
					["API 地址", options.api],
					["验收会话", vars.sessionId ? mask(vars.sessionId, 8, 0) : "(未建立)"],
				],
				results: checks.results,
				manualItems: [],
				footerLines: [
					"场景记录只证明「人工点击 + 脚本断言」覆盖的部分；未覆盖项保持空白。",
					"只有 platform-real 行可勾选真机验收项；blocked/skip 不计入验收。",
				],
			});
			writeRecord(RECORDS, recordFileName(now(), `scenario-${scenario.id}`), content, {
				force: options.force,
				log,
			});
		}
		// 场景未走完（多为没等到人工动作）不算通过：即使没有 fail 也返回非 0。
		if (!completed.matched) {
			log("\n场景未完成：本次结果不计入验收，按提示完成动作后重跑。");
			return 1;
		}
		return checks.exitCode();
	}

	const checks = createChecks();
	const selfCheck = await runFeishuSelfCheck({ env, options, checks });
	printChecks(checks.results, log);

	if (options.write) {
		const content = renderRecord({
			title: "飞书真机联调记录（自动生成骨架）",
			generator: "`scripts/feishu-acceptance.mjs`",
			meta: selfCheck.meta,
			results: checks.results,
			manualItems: selfCheck.manualItems,
			footerLines: [
				"仅在真机执行且留证的项可勾选；自动自检通过不等于完成 #12 验收。",
			],
		});
		writeRecord(RECORDS, recordFileName(now()), content, {
			force: options.force,
			log,
		});
	}

	return checks.exitCode();
}
