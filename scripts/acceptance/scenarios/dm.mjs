// dm 场景：单聊卡片 → 点击 → 持久化 → 处理 → 确认（runbook 第 4 节）。
// 人工只做两次点击；投递、状态迁移、时延与留证由脚本断言。

import { EVIDENCE } from "../checks.mjs";
import { mask } from "../redact.mjs";
import { assertEqual, defineScenario, verdict } from "../scenario.mjs";
import {
	actionRefOf,
	confirmationDelivered,
	decisionDelivered,
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

/** @param {SessionDetail} detail */
const processedInboxes = (detail) =>
	detail.inbox.filter((item) => item.status === "processed");

/** @param {ScenarioContext} ctx */
const detailOf = async (ctx) =>
	/** @type {ConsoleClient} */ (ctx.client).getSession(
		String(ctx.vars.sessionId),
	);

export const dmScenario = defineScenario({
	id: "dm",
	title: "单聊全链路",
	evidence: EVIDENCE.platformReal,
	timeoutMs: 180_000,
	setup: async (ctx) => {
		const session = await startAcceptanceSession(ctx);
		ctx.log?.(
			`会话已建立 session=${mask(session.id, 8, 0)}；收件人与真实标识不打印。`,
		);
	},
	steps: [
		{
			id: "dm.card",
			read: detailOf,
			until: (detail) => roundDelivered(detail, 1),
			assertions: [
				{
					id: "dm.card.delivered",
					title: "第 1 轮决策卡已投递",
					check: (detail) => {
						const delivery = detail.deliveries.find(
							(item) => item.roundId === roundByNo(detail, 1)?.id,
						);
						return verdict(
							decisionDelivered(detail, 1),
							`delivery=${delivery?.status ?? "缺失"} purpose=${delivery?.purpose ?? "-"} message=${mask(delivery?.externalMessageId ?? "", 6, 4)}`,
							"卡片未送达：检查 FEISHU_APP_SECRET、机器人权限与 worker 是否运行",
						);
					},
				},
				{
					id: "dm.card.round",
					title: "第 1 轮处于待选择状态",
					check: (detail) =>
						assertEqual(
							[
								roundByNo(detail, 1)?.status,
								detail.session.status,
								detail.session.roundNo,
							],
							["open", "awaiting_input", 1],
							"round1/status/roundNo",
						),
				},
				{
					id: "dm.card.options",
					title: "每个候选只对应一个不透明 actionRef",
					check: (detail) => {
						const round = roundByNo(detail, 1);
						const actions = detail.actions.filter(
							(item) => item.roundId === round?.id,
						);
						const candidates = round?.candidates ?? [];
						return verdict(
							actions.length === candidates.length &&
								candidates.every((candidate) =>
									Boolean(actionRefOf(detail, 1, candidate.id)),
								),
							`候选 ${candidates.length} 个 / 动作 ${actions.length} 个`,
							"候选与动作数量不一致：检查卡片构建与 actionRef 生成",
						);
					},
				},
			],
		},
		{
			id: "dm.round1",
			prompt: "请在飞书单聊中点击「继续观察」（不要点其他按钮）",
			stopOnFail: true,
			read: detailOf,
			// 只等「已答」就判定，避免点错按钮时白等超时；进入第 2 轮单独断言。
			until: (detail) => roundByNo(detail, 1)?.status === "answered",
			assertions: [
				{
					id: "dm.round1.selected",
					title: "第 1 轮记录所选选项与平台操作者",
					check: (detail, ctx) => {
						const round = roundByNo(detail, 1);
						const actor = round?.selectedBy;
						const openId = /** @type {{ openId?: string }} */ (ctx.options)
							?.openId;
						const actorOk =
							actor?.kind === "platform" &&
							Boolean(actor?.externalId) &&
							(!openId || actor?.externalId === openId);
						return verdict(
							round?.selectedOptionId === "observe" && actorOk,
							`option=${round?.selectedOptionId ?? "-"} actor=${actor?.kind ?? "-"}/${mask(actor?.externalId ?? "", 6, 4)}`,
							"应点击「继续观察」；若点了其他选项请新建会话重跑",
						);
					},
				},
				{
					id: "dm.round1.persisted",
					title: "版本递增且快照增加",
					check: (detail, ctx) => {
						const baseline =
							/** @type {{ version: number, snapshots: number }} */ (
								ctx.vars.baseline
							);
						return verdict(
							detail.session.version > baseline.version &&
								detail.snapshots.length > baseline.snapshots,
							`version ${baseline.version} → ${detail.session.version}，快照 ${baseline.snapshots} → ${detail.snapshots.length}`,
							"选择未落到策略快照：检查事务提交与版本校验",
						);
					},
				},
				{
					id: "dm.round1.inbox",
					title: "inbox 已 processed",
					check: (detail) => {
						const inbox = inboxFor(
							detail,
							actionRefOf(detail, 1, roundByNo(detail, 1)?.selectedOptionId),
						);
						return verdict(
							inbox?.status === "processed",
							`inbox=${inbox?.status ?? "缺失"}${inbox?.reason ? ` reason=${inbox.reason}` : ""}`,
							"inbox 非 processed：确认 worker 已处理 process_inbox 任务",
						);
					},
				},
				{
					id: "dm.round1.next-round",
					title: "继续观察后进入第 2 轮并收到新卡",
					check: (detail) =>
						verdict(
							detail.session.roundNo === 2 &&
								roundByNo(detail, 2)?.status === "open" &&
								decisionDelivered(detail, 2),
							`roundNo=${detail.session.roundNo} round2=${roundByNo(detail, 2)?.status ?? "缺失"}`,
							"非完成类选项应产生下一轮；选了完成类选项请新建会话重跑",
						),
				},
				{
					id: "dm.round1.latency",
					title: "服务端处理区间（近似值）",
					check: (_detail, ctx) => {
						const elapsed = Number(ctx.vars.elapsedMs);
						return verdict(
							elapsed <= 3_000,
							`点击后 ${elapsed}ms 内观测到迁移（1s 轮询粒度近似，非服务端 ACK 指标）`,
							"超过 3 秒预算：见 runbook 第 9 节的替代取数与超时判读",
						);
					},
				},
			],
		},
		{
			id: "dm.round2",
			prompt: "请在飞书单聊中点击「确认已阅」完成会话",
			stopOnFail: true,
			read: detailOf,
			until: (detail) =>
				detail.session.status === "completed" &&
				confirmationDelivered(detail),
			assertions: [
				{
					id: "dm.completed",
					title: "会话 completed 且收到结束确认卡",
					check: (detail) => {
						const confirmation = detail.deliveries.find(
							(item) => item.purpose === "confirmation",
						);
						return verdict(
							detail.session.status === "completed" &&
								confirmation?.status === "sent",
							`status=${detail.session.status} confirmation=${confirmation?.status ?? "缺失"}`,
							"未收到结束确认卡：检查 confirmation 投递与 worker",
						);
					},
				},
				{
					id: "dm.round2.selected",
					title: "第 2 轮记录完成类选项",
					check: (detail) => {
						const round = roundByNo(detail, 2);
						return verdict(
							round?.status === "answered" &&
								round?.selectedOptionId === "acknowledge",
							`option=${round?.selectedOptionId ?? "-"} roundStatus=${round?.status ?? "-"}`,
							"应点击「确认已阅」；其他选项不会结束会话",
						);
					},
				},
				{
					id: "dm.round2.persisted",
					title: "两轮共两次快照与两条 processed inbox",
					check: (detail, ctx) => {
						const baseline =
							/** @type {{ version: number, snapshots: number }} */ (
								ctx.vars.baseline
							);
						return verdict(
							detail.snapshots.length === baseline.snapshots + 2 &&
								processedInboxes(detail).length === 2,
							`快照 +${detail.snapshots.length - baseline.snapshots}，processed inbox=${processedInboxes(detail).length}`,
							"轮次未全部落库：核对 rounds 与 inbox 终态",
						);
					},
				},
			],
		},
	],
});
