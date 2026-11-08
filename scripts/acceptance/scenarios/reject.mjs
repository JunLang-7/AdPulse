// reject 场景：非允许成员的点击必须被拒，且策略不被修改（runbook 第 7 节）。
// 用群聊是因为需要第二个真实用户参与：未授权成员点 → rejected/forbidden，
// 随后授权成员点 → 正常生效，证明拒绝只针对未授权者，而不是整条链路不可用。

import { EVIDENCE } from "../checks.mjs";
import { mask } from "../redact.mjs";
import { assertEqual, defineScenario, verdict } from "../scenario.mjs";
import {
	actionRefOf,
	inboxFor,
	roundByNo,
	roundDelivered,
	startAcceptanceSession,
} from "./fixture.mjs";

/**
 * @typedef {import("../console-api.mjs").ConsoleClient} ConsoleClient
 * @typedef {import("../console-api.mjs").SessionDetail} SessionDetail
 * @typedef {import("../console-api.mjs").DetailInboxEntry} DetailInboxEntry
 * @typedef {import("../scenario.mjs").ScenarioContext} ScenarioContext
 */

/** @param {ScenarioContext} ctx */
const detailOf = async (ctx) =>
	/** @type {ConsoleClient} */ (ctx.client).getSession(
		String(ctx.vars.sessionId),
	);

/** 非 pending 的 inbox 已进入终态。 */
const settled = (/** @type {SessionDetail} */ detail) =>
	detail.inbox.filter((item) => item.status !== "pending");

const actorIdOf = (/** @type {DetailInboxEntry | undefined} */ inbox) =>
	inbox?.command.actor?.externalId;

export const rejectScenario = defineScenario({
	id: "reject",
	title: "非允许成员点击被拒",
	evidence: EVIDENCE.platformReal,
	timeoutMs: 600_000,
	setup: async (ctx) => {
		// 群聊收件人 + 只授权一位成员：另一位成员即为未授权者。
		const session = await startAcceptanceSession(ctx, { kind: "group" });
		ctx.log?.(
			`会话已建立 session=${mask(session.id, 8, 0)}；群成员不自动获得决策权。`,
		);
	},
	steps: [
		{
			id: "reject.card",
			read: detailOf,
			until: (detail) => roundDelivered(detail, 1),
			assertions: [
				{
					id: "reject.card.delivered",
					title: "群内第 1 轮决策卡已投递",
					check: (detail) =>
						verdict(
							roundDelivered(detail, 1),
							`round1=${roundByNo(detail, 1)?.status ?? "缺失"} roundNo=${detail.session.roundNo}`,
							"卡片未送达：先修投递，再复验拒绝场景",
						),
				},
			],
		},
		{
			id: "reject.forbidden",
			stopOnFail: true,
			prompt:
				"请让**未被授权**的群成员（--other-open-id 那位）在群里点任意一个按钮",
			read: detailOf,
			until: (detail) => settled(detail).length > 0,
			assertions: [
				{
					id: "reject.forbidden.rejected",
					title: "未授权成员点击被拒（forbidden）",
					check: (detail) => {
						const inbox = settled(detail)[0];
						return verdict(
							inbox?.status === "rejected" && inbox?.reason === "forbidden",
							`status=${inbox?.status ?? "缺失"} reason=${inbox?.reason ?? "-"} actor=${mask(actorIdOf(inbox) ?? "", 6, 4)}`,
							"预期 rejected/forbidden：若为 processed，说明群成员被默认授予决策权",
						);
					},
				},
				{
					id: "reject.forbidden.no-effect",
					title: "策略与轮次未被修改",
					check: (detail, ctx) => {
						const baseline =
							/** @type {{ version: number, snapshots: number }} */ (
								ctx.vars.baseline
							);
						return assertEqual(
							[
								detail.session.version,
								detail.snapshots.length,
								roundByNo(detail, 1)?.status,
							],
							[baseline.version, baseline.snapshots, "open"],
							"version/snapshots/round1",
						);
					},
				},
				{
					id: "reject.forbidden.actor",
					title: "被拒的确实是未授权账户",
					check: (detail, ctx) => {
						const inbox = settled(detail)[0];
						const other = /** @type {{ otherOpenId?: string }} */ (ctx.options)
							?.otherOpenId;
						const actorId = actorIdOf(inbox);
						return verdict(
							Boolean(actorId) &&
								actorId !==
									/** @type {{ openId?: string }} */ (ctx.options)?.openId &&
								(!other || actorId === other),
							`actor=${mask(actorId ?? "", 6, 4)} 与授权成员不同=${actorId !== /** @type {{ openId?: string }} */ (ctx.options)?.openId}`,
							"点击者与 --other-open-id 不一致：确认点名的那位成员操作的是这张卡",
						);
					},
				},
			],
		},
		{
			id: "reject.authorized",
			stopOnFail: true,
			prompt: "请由**已授权**成员（--open-id 那位）在群里点「继续观察」",
			read: detailOf,
			until: (detail) => roundByNo(detail, 1)?.status === "answered",
			assertions: [
				{
					id: "reject.authorized.processed",
					title: "授权成员点击正常生效",
					check: (detail, ctx) => {
						const baseline =
							/** @type {{ version: number, snapshots: number }} */ (
								ctx.vars.baseline
							);
						const inbox = inboxFor(
							detail,
							actionRefOf(detail, 1, "observe"),
						);
						const actorId = actorIdOf(inbox);
						const openId = /** @type {{ openId?: string }} */ (ctx.options)
							?.openId;
						return verdict(
							inbox?.status === "processed" &&
								detail.session.version === baseline.version + 1 &&
								(!openId || actorId === openId),
							`inbox=${inbox?.status ?? "缺失"} version=${baseline.version}→${detail.session.version} actor=${mask(actorId ?? "", 6, 4)}`,
							"授权成员点击未生效：检查 allowedActorIds 与投递账户是否一致",
						);
					},
				},
				{
					id: "reject.authorized.rejected-stays",
					title: "被拒记录保持 rejected，不因授权点击而改写",
					check: (detail) => {
						const rejected = detail.inbox.filter(
							(item) => item.status === "rejected",
						);
						return verdict(
							rejected.length === 1 && rejected[0]?.reason === "forbidden",
							`rejected=${rejected.length} reason=${rejected[0]?.reason ?? "-"}`,
							"拒绝记录被改写：inbox 终态应不可变",
						);
					},
				},
			],
		},
	],
});
