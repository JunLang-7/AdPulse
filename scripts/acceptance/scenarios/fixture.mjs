// 场景共用的会话夹具与判据查询：只新建/读取，不删除或改写既有数据。

import { randomUUID } from "node:crypto";

/**
 * @typedef {import("./console-api.mjs").SessionDetail} SessionDetail
 * @typedef {import("./console-api.mjs").DetailRound} DetailRound
 * @typedef {import("./console-api.mjs").DetailInboxEntry} DetailInboxEntry
 * @typedef {import("../scenario.mjs").ScenarioContext} ScenarioContext
 */

/** 验收会话的固定策略与限额；与 runbook 第 4 节示例保持一致。 */
export function acceptanceSessionInput(ctx, overrides = {}) {
	const accountId = ctx.env?.FEISHU_ACCOUNT_ID ?? "feishu-internal";
	const { expiresInMs = 3_600_000, ...rest } = overrides;
	return {
		recipient: { accountId, kind: "user", externalId: ctx.options?.openId },
		allowedActorIds: [ctx.options?.openId],
		strategy: {
			objective: "验收编排会话",
			audience: [],
			channels: {},
			sellingPoints: [],
		},
		limits: { maxBudgetChangeRatio: 0.2, maxBidChangeRatio: 0.2 },
		signal: {
			id: randomUUID(),
			title: "验收编排信号",
			summary: "合成内容，仅用于真机验收编排，不代表真实市场变化。",
			evidence: [{ label: "来源", value: "scripts/acceptance" }],
		},
		expiresAt: new Date(
			(ctx.now?.() ?? Date.now()) + expiresInMs,
		).toISOString(),
		...rest,
	};
}

/**
 * 建会话并把 sessionId 与基线写入 ctx.vars，供断言「版本递增 / 快照增加」。
 * @param {ScenarioContext & { client: import("../console-api.mjs").ConsoleClient }} ctx
 */
export async function startAcceptanceSession(ctx, overrides = {}) {
	const session = await ctx.client.createSession(
		acceptanceSessionInput(ctx, overrides),
	);
	const detail = await ctx.client.getSession(session.id);
	ctx.vars.sessionId = session.id;
	// 建会话时已存在一条 version=0 的初始快照，基线必须取真实数量，
	// 否则「快照增加」类断言会差一（真机数据暴露过这个问题）。
	ctx.vars.baseline = {
		version: detail.session.version,
		snapshots: detail.snapshots.length,
	};
	return session;
}

/** @param {SessionDetail} detail */
export function roundByNo(detail, roundNo) {
	return detail.rounds.find((round) => round.roundNo === roundNo);
}

/** 某一轮某选项的动作标识；卡片按钮只带这个不透明 actionRef。 */
export function actionRefOf(detail, roundNo, optionId) {
	const round = roundByNo(detail, roundNo);
	if (!round) return undefined;
	return detail.actions.find(
		(item) => item.roundId === round.id && item.optionId === optionId,
	)?.id;
}

/** @param {SessionDetail} detail */
export function inboxFor(detail, actionRef) {
	if (!actionRef) return undefined;
	return detail.inbox.find((item) => item.command.actionRef === actionRef);
}

/** 某一轮决策卡是否已送达：purpose=decision 且已 sent。 */
export function decisionDelivered(detail, roundNo) {
	const round = roundByNo(detail, roundNo);
	if (!round) return false;
	return detail.deliveries.some(
		(delivery) =>
			delivery.roundId === round.id &&
			delivery.purpose === "decision" &&
			delivery.status === "sent",
	);
}

export function confirmationDelivered(detail) {
	return detail.deliveries.some(
		(delivery) =>
			delivery.purpose === "confirmation" && delivery.status === "sent",
	);
}

/** 该轮已开卡、会话在等选择、且决策卡已 sent。 */
export function roundDelivered(detail, roundNo) {
	const round = roundByNo(detail, roundNo);
	return (
		round?.status === "open" &&
		detail.session.roundNo === roundNo &&
		detail.session.status === "awaiting_input" &&
		decisionDelivered(detail, roundNo)
	);
}
