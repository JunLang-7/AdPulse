// 场景描述与执行：人只负责外部动作（点击卡片、撤权等），断言与留证由脚本完成。
// 场景是数据，不是流程代码；新增场景只描述 setup / before / prompt / read / until / assertions。
// 每个场景的 read 返回同一种状态形状，单测与类型推导都依赖这一点。

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
 * @typedef {Object} ScenarioContext
 * @property {(id: string, title: string, status: string, detail?: string, hint?: string, meta?: { evidence?: string }) => void} record
 * @property {(line: string) => void} [log]
 * @property {Record<string, string | undefined>} [env]
 * @property {Record<string, unknown>} [options]
 * @property {unknown} [client] 由入口注入的控制台 API 客户端
 * @property {Record<string, unknown>} [vars] setup 与各步骤共享的变量
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 */

/**
 * @typedef {Object} ScenarioAssertion
 * @property {string} id 稳定标识
 * @property {string} title 人类可读标题
 * @property {string} [evidence] 证据等级，默认继承场景
 */

const REQUIRED_STEP_KEYS = ["read", "until"];

/**
 * @template T
 * @param {{
 *   id: string,
 *   title: string,
 *   evidence?: string,
 *   setup?: (ctx: ScenarioContext) => Promise<void>,
 *   teardown?: (ctx: ScenarioContext) => Promise<void>,
 *   intervalMs?: number,
 *   timeoutMs?: number,
 *   steps: Array<{
 *     id?: string,
 *     prompt?: string | ((ctx: ScenarioContext) => string),
 *     before?: (ctx: ScenarioContext) => Promise<void>,
 *     read: (ctx: ScenarioContext) => Promise<T>,
 *     until: (state: T, ctx: ScenarioContext) => boolean,
 *     intervalMs?: number,
 *     timeoutMs?: number,
 *     stopOnFail?: boolean,
 *     assertions?: Array<ScenarioAssertion & {
 *       check: (state: T, ctx: ScenarioContext) => { status: string, detail: string, hint?: string },
 *     }>,
 *   }>,
 * }} spec
 */
export function defineScenario(spec) {
	if (!spec.id) throw new Error("场景缺少 id");
	if (!spec.title) throw new Error("场景缺少 title");
	if (!Array.isArray(spec.steps) || spec.steps.length === 0)
		throw new Error(`场景 ${spec.id} 必须至少有一个步骤`);
	for (const [index, step] of spec.steps.entries()) {
		const label = step.id ?? `${spec.id}.step${index + 1}`;
		for (const key of REQUIRED_STEP_KEYS) {
			if (typeof step[key] !== "function")
				throw new Error(`场景步骤 ${label} 缺少 ${key}`);
		}
		for (const assertion of step.assertions ?? []) {
			if (!assertion.id || !assertion.title || typeof assertion.check !== "function")
				throw new Error(`场景步骤 ${label} 的断言缺少 id / title / check`);
		}
	}
	return {
		evidence: EVIDENCE.localReal,
		intervalMs: 1_000,
		timeoutMs: 120_000,
		...spec,
	};
}

/**
 * 执行场景。超时或读取失败记 blocked：它表示「没有等到人工动作」，
 * 不是被测系统失败，因此不计入验收也不判 fail。
 *
 * @template T
 * @param {Parameters<typeof defineScenario<T>>[0]} spec
 * @param {ScenarioContext} ctx
 * @returns {Promise<{ matched: boolean, aborted: boolean, results: Array<{ status: string, detail: string, hint?: string }>, state: T | undefined, elapsedMs: number }>}
 */
export async function runScenario(spec, ctx) {
	const scenario = defineScenario(spec);
	try {
		return await runSteps(scenario, ctx);
	} finally {
		// 清理必须执行，即便前面 blocked 或提前返回；失败只记 warn，不覆盖结论。
		if (scenario.teardown) {
			try {
				await scenario.teardown(ctx);
			} catch (error) {
				ctx.record(
					`${scenario.id}.teardown`,
					`${scenario.title}（清理）`,
					STATUS.warn,
					`清理失败（${errorReason(error)}）`,
					"手动确认一次性容器是否残留",
				);
			}
		}
	}
}

/** @param {ReturnType<typeof defineScenario>} scenario */
async function runSteps(scenario, ctx) {
	const log = ctx.log ?? console.log;
	const evidence = scenario.evidence;
	ctx.vars = ctx.vars ?? {};

	if (scenario.setup) {
		try {
			await scenario.setup(ctx);
		} catch (error) {
			// 建会话失败属于环境/配置问题，不是被测系统失败：记 blocked 并中止。
			ctx.record(
				`${scenario.id}.setup`,
				`${scenario.title}（准备会话）`,
				STATUS.blocked,
				`无法准备验收会话（${errorReason(error)}）`,
				"核对 API 地址、CONSOLE_TOKEN、FEISHU_ACCOUNT_ID 与收件人可用范围",
				{ evidence },
			);
			return { matched: false, aborted: true, results: [], state: undefined, elapsedMs: 0 };
		}
	}

	let lastState;
	for (const [index, step] of scenario.steps.entries()) {
		const stepId = step.id ?? `${scenario.id}.step${index + 1}`;
		if (step.before) await step.before(ctx);

		const prompt =
			typeof step.prompt === "function" ? step.prompt(ctx) : step.prompt;
		if (prompt) log(`\n▶ ${stepId}：${prompt}`);

		const polled = await pollUntil({
			read: () => step.read(ctx),
			until: (state) => step.until(state, ctx),
			intervalMs: step.intervalMs ?? scenario.intervalMs,
			timeoutMs: step.timeoutMs ?? scenario.timeoutMs,
			sleep: ctx.sleep,
			now: ctx.now,
		});
		lastState = polled.state;
		ctx.vars.elapsedMs = polled.elapsedMs;

		if (polled.error) {
			ctx.record(
				`${stepId}.read`,
				`${scenario.title}（${stepId} 读取状态）`,
				STATUS.blocked,
				`读取失败（${errorReason(polled.error)}），已等待 ${polled.elapsedMs}ms`,
				"确认 API 可访问与 CONSOLE_TOKEN 有效后重跑该场景",
				{ evidence },
			);
			return {
				matched: false,
				aborted: true,
				results: [],
				state: lastState,
				elapsedMs: polled.elapsedMs,
			};
		}
		if (!polled.matched) {
			ctx.record(
				stepId,
				`${scenario.title}（${stepId} 等待状态迁移）`,
				STATUS.blocked,
				`等待超时（${polled.elapsedMs}ms，采样 ${polled.samples} 次）`,
				"疑似未在客户端完成操作：完成动作后重跑该场景",
				{ evidence },
			);
			return {
				matched: false,
				aborted: true,
				results: [],
				state: polled.state,
				elapsedMs: polled.elapsedMs,
			};
		}

		const results = [];
		for (const assertion of step.assertions ?? []) {
			const outcome = assertion.check(polled.state, ctx);
			ctx.record(
				assertion.id,
				assertion.title,
				outcome.status,
				outcome.detail,
				outcome.hint,
				{ evidence: assertion.evidence ?? evidence },
			);
			results.push(outcome);
		}

		const failed = results.some((item) => item.status === STATUS.fail);
		if (failed && step.stopOnFail) {
			const remaining = scenario.steps.slice(index + 1);
			if (remaining.length)
				ctx.record(
					`${scenario.id}.aborted`,
					`${scenario.title}（后续步骤未执行）`,
					STATUS.skip,
					`前置步骤 ${stepId} 未通过：未执行 ${remaining
						.map((item, offset) => item.id ?? `${scenario.id}.step${index + offset + 2}`)
						.join(" / ")}`,
					"先处理失败断言，再重跑本场景",
					{ evidence },
				);
			return {
				matched: true,
				aborted: true,
				results,
				state: polled.state,
				elapsedMs: polled.elapsedMs,
			};
		}
	}

	return {
		matched: true,
		aborted: false,
		results: [],
		state: lastState,
		elapsedMs: ctx.vars.elapsedMs ?? 0,
	};
}
