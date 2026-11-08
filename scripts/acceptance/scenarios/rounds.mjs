// rounds 场景：旧卡、同轮重复与过期操作必须被拒绝（runbook 第 7 节）。
// 只做一次人工点击建立「已答轮次」；其余拒绝判定由脚本驱动并断言，
// 拒绝来自服务端领域校验，不是前端隐藏按钮。

import { EVIDENCE } from "../checks.mjs";
import { pollUntil, sleep } from "../poll.mjs";
import { mask } from "../redact.mjs";
import { assertEqual, defineScenario, verdict } from "../scenario.mjs";
import {
	acceptanceSessionInput,
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
 * @typedef {{ detail: SessionDetail, choices: DetailInboxEntry[] }} RoundsState
 */

const TERMINAL = ["processed", "rejected", "failed"];

/** @param {ScenarioContext} ctx */
const done = (ctx) => ctx.sleep ?? sleep;

/** 等到全部提交进入终态；只有 pending 才继续轮询。 */
const allTerminal = (choices) =>
	choices.length > 0 &&
	choices.every((item) => TERMINAL.includes(item.status ?? "pending"));

/** 记录一条拒绝结果的判定，reason 直接取服务端返回值。 */
function rejected(choice, expectedReason, label) {
	return verdict(
		choice?.status === "rejected" && choice?.reason === expectedReason,
		`${label}：status=${choice?.status ?? "缺失"} reason=${choice?.reason ?? "-"}`,
		`预期 rejected/${expectedReason}：若为 processed，说明服务端接受类校验存在缺口`,
	);
}

export const roundsScenario = defineScenario({
	id: "rounds",
	title: "旧卡 / 同轮重复 / 过期拒绝",
	evidence: EVIDENCE.platformReal,
	timeoutMs: 120_000,
	setup: async (ctx) => {
		const session = await startAcceptanceSession(ctx);
		ctx.log?.(
			`会话已建立 session=${mask(session.id, 8, 0)}；本轮只点一次卡片，其余由脚本驱动。`,
		);
	},
	steps: [
		{
			id: "rounds.card",
			read: async (ctx) => ({
				detail: await /** @type {ConsoleClient} */ (ctx.client).getSession(
					String(ctx.vars.sessionId),
				),
				choices: [],
			}),
			until: (state) => roundDelivered(state.detail, 1),
			assertions: [
				{
					id: "rounds.card.delivered",
					title: "第 1 轮决策卡已投递",
					check: (state) =>
						verdict(
							roundByNo(state.detail, 1)?.status === "open",
							`round1=${roundByNo(state.detail, 1)?.status ?? "缺失"} deliveries=${state.detail.deliveries.length}`,
							"卡片未送达：先修投递，再复验拒绝场景",
						),
				},
			],
		},
		{
			id: "rounds.round1",
			prompt: "请在飞书单聊中点击「继续观察」（本轮唯一的人工动作）",
			stopOnFail: true,
			read: async (ctx) => ({
				detail: await /** @type {ConsoleClient} */ (ctx.client).getSession(
					String(ctx.vars.sessionId),
				),
				choices: [],
			}),
			until: (state) =>
				roundByNo(state.detail, 1)?.status === "answered" &&
				state.detail.session.roundNo === 2,
			assertions: [
				{
					id: "rounds.round1.answered",
					title: "第 1 轮 answered 并进入第 2 轮",
					check: (state) =>
						assertEqual(
							[
								roundByNo(state.detail, 1)?.status,
								state.detail.session.roundNo,
								state.detail.session.version,
							],
							["answered", 2, 1],
							"round1/roundNo/version",
						),
				},
				{
					id: "rounds.round1.inbox",
					title: "首次点击 inbox 已 processed",
					check: (state) => {
						const inbox = inboxFor(
							state.detail,
							actionRefOf(state.detail, 1, "observe"),
						);
						return verdict(
							inbox?.status === "processed",
							`inbox=${inbox?.status ?? "缺失"}`,
							"首次点击未处理：拒绝场景的前提不成立",
						);
					},
				},
			],
		},
		{
			id: "rounds.repeat",
			before: async (ctx) => {
				const client = /** @type {ConsoleClient} */ (ctx.client);
				const detail = await client.getSession(String(ctx.vars.sessionId));
				const staleRef = actionRefOf(detail, 1, "observe");
				if (!staleRef) throw new Error("第 1 轮缺少 observe 动作，无法构造旧卡提交");
				const first = await client.submitChoice(staleRef);
				const second = await client.submitChoice(staleRef);
				ctx.vars.staleInboxId = first.inboxId;
				ctx.vars.repeatInboxId = second.inboxId;
				ctx.vars.staleSubmittedAt = new Date().toISOString();
			},
			read: async (ctx) => {
				const client = /** @type {ConsoleClient} */ (ctx.client);
				return {
					detail: await client.getSession(String(ctx.vars.sessionId)),
					choices: [
						await client.getChoice(String(ctx.vars.staleInboxId)),
						await client.getChoice(String(ctx.vars.repeatInboxId)),
					],
				};
			},
			until: (state) => allTerminal(state.choices),
			assertions: [
				{
					id: "rounds.stale.rejected",
					title: "旧卡（上一轮 actionRef）被拒",
					check: (state) =>
						rejected(state.choices[0], "already_handled", "旧卡"),
				},
				{
					id: "rounds.repeat.rejected",
					title: "同轮重复提交被拒",
					check: (state) =>
						rejected(state.choices[1], "already_handled", "重复提交"),
				},
				{
					id: "rounds.repeat.no-effect",
					title: "策略不重复生效",
					check: (state, ctx) => {
						const baseline =
							/** @type {{ version: number, snapshots: number }} */ (
								ctx.vars.baseline
							);
						return assertEqual(
							[
								state.detail.session.version,
								state.detail.snapshots.length,
							],
							[baseline.version + 1, baseline.snapshots + 1],
							"version/snapshots",
						);
					},
				},
			],
		},
		{
			id: "rounds.expired",
			timeoutMs: 90_000,
			before: async (ctx) => {
				const client = /** @type {ConsoleClient} */ (ctx.client);
				const now = ctx.now ?? Date.now;
				const expiresInMs = 15_000;
				const shortLived = await client.createSession(
					acceptanceSessionInput(ctx, { expiresInMs }),
				);
				ctx.vars.shortLivedSessionId = shortLived.id;
				const delivered = await pollUntil({
					read: () => client.getSession(shortLived.id),
					until: (detail) => roundDelivered(detail, 1),
					intervalMs: 500,
					timeoutMs: expiresInMs,
					sleep: ctx.sleep,
					now: ctx.now,
				});
				if (!delivered.matched) {
					ctx.vars.expiredSkipped = `短有效期会话未在 ${expiresInMs}ms 内送出第 1 轮卡片`;
					return;
				}
				const waitMs = Date.parse(shortLived.expiresAt) - now() + 500;
				if (waitMs > 0) await done(ctx)(waitMs);
				const actionRef = actionRefOf(delivered.state, 1, "observe");
				if (!actionRef) {
					ctx.vars.expiredSkipped = "第 1 轮缺少 observe 动作，无法构造过期提交";
					return;
				}
				const receipt = await client.submitChoice(actionRef);
				ctx.vars.expiredInboxId = receipt.inboxId;
			},
			read: async (ctx) => {
				const client = /** @type {ConsoleClient} */ (ctx.client);
				const choices = ctx.vars.expiredInboxId
					? [await client.getChoice(String(ctx.vars.expiredInboxId))]
					: [];
				return {
					detail: await client.getSession(
						String(ctx.vars.shortLivedSessionId),
					),
					choices,
				};
			},
			until: (state, ctx) =>
				Boolean(ctx.vars.expiredSkipped) || allTerminal(state.choices),
			assertions: [
				{
					id: "rounds.expired.rejected",
					title: "过期会话提交被拒",
					check: (state, ctx) =>
						ctx.vars.expiredSkipped
							? {
									status: "skip",
									detail: `未覆盖：${ctx.vars.expiredSkipped}`,
									hint: "提高本机 worker 吞吐或延长 expiresInMs 后重跑",
								}
							: rejected(state.choices[0], "expired", "过期提交"),
				},
			],
		},
	],
});
