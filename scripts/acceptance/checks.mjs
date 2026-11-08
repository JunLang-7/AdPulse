// 检查结果收集、证据分级与输出格式。
// 输出格式与退出码口径是既有约定（#21 落地），改动需同时更新 runbook 判读说明。

/**
 * 证据分级。只有 platform-real 能支撑真机验收勾选：
 * - platform-real：平台真实推送或真实用户交互产生的证据。
 * - local-real：真实凭据或真实平台 API，但由本地脚本发起；可证明配置与连通，不可勾选真机项。
 * - synthetic：假凭据或 mock，只能证明代码路径。
 */
export const EVIDENCE = {
	platformReal: "platform-real",
	localReal: "local-real",
	synthetic: "synthetic",
};

export const EVIDENCE_LEVELS = Object.values(EVIDENCE);

export const EVIDENCE_NOTES = {
	[EVIDENCE.platformReal]: "平台真实推送或真实用户交互，可支撑真机验收勾选",
	[EVIDENCE.localReal]: "真实凭据或真实平台 API 由本地发起，不可勾选真机项",
	[EVIDENCE.synthetic]: "假凭据或 mock，只能证明代码路径",
};

/** 通过 / 警告 / 跳过 / 失败 / 阻塞。blocked 与 skip 一样不计入验收。 */
export const STATUS = {
	ok: "ok",
	warn: "warn",
	skip: "skip",
	fail: "fail",
	blocked: "blocked",
};

const ICONS = {
	ok: "✅",
	warn: "⚠️",
	skip: "⏭️",
	fail: "❌",
	blocked: "⏸️",
};

/**
 * 创建一次执行的结果收集器。
 * @param {{ defaultEvidence?: string }} [options]
 */
export function createChecks(options = {}) {
	const defaultEvidence = options.defaultEvidence ?? EVIDENCE.localReal;
	const results = [];

	/**
	 * @param {string} id 稳定标识，供判读与回归对比
	 * @param {string} title 人类可读标题
	 * @param {string} status STATUS 之一
	 * @param {string} [detail] 判定依据，已脱敏
	 * @param {string} [hint] 未通过时的处理建议
	 * @param {{ evidence?: string }} [meta]
	 */
	function record(id, title, status, detail, hint, meta = {}) {
		const evidence = meta.evidence ?? defaultEvidence;
		if (!EVIDENCE_LEVELS.includes(evidence))
			throw new Error(`未知证据等级：${evidence}（${id}）`);
		if (!Object.hasOwn(STATUS, status))
			throw new Error(`未知状态：${status}（${id}）`);
		results.push({ id, title, status, detail, hint, evidence });
	}

	function counts() {
		const tally = { ok: 0, warn: 0, skip: 0, fail: 0, blocked: 0 };
		for (const item of results) tally[item.status] += 1;
		return tally;
	}

	/** fail 必须修复；blocked/skip 不计入验收但不算失败。 */
	function exitCode() {
		return results.some((item) => item.status === STATUS.fail) ? 1 : 0;
	}

	return { record, results, counts, exitCode };
}

/** 与 #21 一致的终端输出，不做额外修饰。 */
export function printChecks(results, log = console.log) {
	for (const item of results) {
		log(`[${item.status.padEnd(4)}] ${item.id.padEnd(22)} ${item.detail ?? ""}`);
		if (item.status !== STATUS.ok && item.hint) log(`          ↳ ${item.hint}`);
	}
	const tally = { ok: 0, warn: 0, skip: 0, fail: 0, blocked: 0 };
	for (const item of results) tally[item.status] += 1;
	log(
		`\n通过 ${tally.ok} / 警告 ${tally.warn} / 跳过 ${tally.skip} / 失败 ${tally.fail}`,
	);
	if (tally.blocked) log(`阻塞 ${tally.blocked}（等待外部动作或超时，不计入验收）`);
	if (tally.skip) log("跳过的检查不计入验收：真机联调前请补齐或用人工步骤留证。");
}

export function iconOf(status) {
	return ICONS[status] ?? "❔";
}
