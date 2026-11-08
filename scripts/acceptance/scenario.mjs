// 场景描述与执行：人只负责外部动作（点击卡片、撤权等），断言与留证由脚本完成。
// 场景是数据，不是流程代码；新增场景只描述 setup / prompt / read / until / assertions。

import { EVIDENCE, STATUS } from "./checks.mjs";
import { errorReason } from "./http.mjs";
import { pollUntil } from "./poll.mjs";

/**
 * 断言结果。用 verdict 产出，避免各场景自行拼状态字符串。
 * @param {boolean} passed
 * @param {string} detail 判定依据，必须已脱敏
 * @param {string} [hint] 未通过时的处理建议
 * @returns {{ status: string, detail: string, hint?: string }}
 */
export function verdict(passed, detail, hint) {
	const status = passed ? STATUS.ok : STATUS.fail;
	return hint === undefined ? { status, detail } : { status, detail, hint };
}

export function assertEqual(actual, expected, label) {
	const passed = JSON.stringify(actual) === JSON.stringify(expected);
	return verdict(
		passed,
		`${label}：实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`,
		passed ? undefined : "对照 runbook 判读标准核对状态流转与持久化结果",
	);
}

/**
 * 断言：check 拿到 read 返回的状态，返回 verdict 结果。
 * @typedef {Object} ScenarioAssertion
 * @property {string} id 稳定标识
 * @property {string} title 人类可读标题
 * @property {string} [evidence] 证据等级，默认继承场景
 */
/**
 * 场景描述。state 类型由 read 推导。
 * @typedef {Object} ScenarioSpecBase
 * @property {string} id
 * @property {string} title
 * @property {string} [evidence] 默认 local-real；只有 platform-real 可支撑真机勾选
 * @property {(ctx: ScenarioContext) => Promise<void>} [setup] 建会话、预置前置条件
 * @property {string} [prompt] 需要人工执行的动作说明
 * @property {number} [intervalMs]
 * @property {number} [timeoutMs]
 */
/**
 * @typedef {Object} ScenarioContext
 * @property {(id: string, title: string, status: string, detail?: string, hint?: string, meta?: { evidence?: string }) => void} record
 * @property {(line: string) => void} [log]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 */

const REQUIRED = ["id", "title", "read", "until", "assertions"];

/**
 * @template T
 * @param {ScenarioSpecBase & {
 *   read: (ctx: ScenarioContext) => Promise<T>,
 *   until: (state: T, ctx: ScenarioContext) => boolean,
 *   assertions: Array<ScenarioAssertion & {
 *     check: (state: T, ctx: ScenarioContext) => { status: string, detail: string, hint?: string },
 *   }>,
 * }} spec
 */
export function defineScenario(spec) {
	for (const key of REQUIRED) {
		if (spec[key] === undefined) throw new Error(`场景缺少 ${key}`);
	}
	if (!Array.isArray(spec.assertions) || spec.assertions.length === 0)
		throw new Error(`场景 ${spec.id} 必须至少有一个断言`);
	for (const assertion of spec.assertions) {
		if (!assertion.id || !assertion.title || typeof assertion.check !== "function")
			throw new Error(`场景 ${spec.id} 的断言缺少 id / title / check`);
	}
	return {
		evidence: EVIDENCE.localReal,
		intervalMs: 1_000,
		timeoutMs: 120_000,
		...spec,
	};
}

/**
 * 执行一个场景。超时或读取失败记 blocked：它表示「没有等到人工动作」，
 * 不是被测系统失败，因此不计入验收也不判 fail。
 *
 * @template T
 * @param {Parameters<typeof defineScenario<T>>[0]} spec
 * @param {ScenarioContext} ctx
 * @returns {Promise<{ matched: boolean, results: Array<{ status: string, detail: string, hint?: string }>, state: T | undefined, elapsedMs?: number }>}
 */
export async function runScenario(spec, ctx) {
	const scenario = defineScenario(spec);
	const log = ctx.log ?? console.log;
	const evidence = scenario.evidence;

	if (scenario.setup) await scenario.setup(ctx);
	if (scenario.prompt) log(`\n▶ ${scenario.id}：${scenario.prompt}`);

	const polled = await pollUntil({
		read: () => scenario.read(ctx),
		until: (state) => scenario.until(state, ctx),
		intervalMs: scenario.intervalMs,
		timeoutMs: scenario.timeoutMs,
		sleep: ctx.sleep,
		now: ctx.now,
	});

	if (polled.error) {
		ctx.record(
			`${scenario.id}.read`,
			`${scenario.title}（读取状态）`,
			STATUS.blocked,
			`读取失败（${errorReason(polled.error)}），已等待 ${polled.elapsedMs}ms`,
			"确认 API 可访问与 CONSOLE_TOKEN 有效后重试",
			{ evidence },
		);
		return { matched: false, results: [], state: polled.state };
	}
	if (!polled.matched) {
		ctx.record(
			scenario.id,
			scenario.title,
			STATUS.blocked,
			`等待状态迁移超时（${polled.elapsedMs}ms，采样 ${polled.samples} 次）`,
			"疑似未在客户端完成操作：完成动作后重跑本场景",
			{ evidence },
		);
		return { matched: false, results: [], state: polled.state };
	}

	const results = scenario.assertions.map((assertion) => {
		const outcome = assertion.check(polled.state, ctx);
		ctx.record(
			assertion.id,
			assertion.title,
			outcome.status,
			outcome.detail,
			outcome.hint,
			{ evidence: assertion.evidence ?? evidence },
		);
		return outcome;
	});
	return { matched: true, results, state: polled.state, elapsedMs: polled.elapsedMs };
}
