// failure 场景：投递失败与业务成功分离，且任务重试复用同一 delivery.id（runbook 第 8 节）。
// 不需要真实收件人：故意用一个不存在的 open_id，让平台真实返回发送失败。
// 业务动作由控制台接口提交（local-real），因此证明「失败的是投递，不是业务」。
// 证据为 local-real：请求由本脚本发起，不是平台推送或用户交互。

import { EVIDENCE } from "../checks.mjs";
import { mask } from "../redact.mjs";
import { assertEqual, defineScenario, verdict } from "../scenario.mjs";
import { acceptanceSessionInput, actionRefOf, inboxFor, roundByNo } from "./fixture.mjs";

/**
 * @typedef {import("../console-api.mjs").ConsoleClient} ConsoleClient
 * @typedef {import("../console-api.mjs").SessionDetail} SessionDetail
 * @typedef {import("../scenario.mjs").ScenarioContext} ScenarioContext
 */

/** 平台必然拒绝的收件人：格式正确但不存在。 */
const UNREACHABLE_OPEN_ID = "ou_0000000000000000000000000000000000";

/** @param {ScenarioContext} ctx */
const readDetail = async (ctx) => ({
	detail: await /** @type {ConsoleClient} */ (ctx.client).getSession(
		String(ctx.vars.sessionId),
	),
	inbox: undefined,
});

const sendJobs = (/** @type {SessionDetail} */ detail) =>
	detail.jobs.filter((job) => job.task.kind === "send_delivery");

const failedDelivery = (/** @type {SessionDetail} */ detail) =>
	detail.deliveries.find((item) => item.status === "failed");

export const failureScenario = defineScenario({
	id: "failure",
	title: "投递失败与业务成功分离",
	evidence: EVIDENCE.localReal,
	timeoutMs: 180_000,
	setup: async (ctx) => {
		const client = /** @type {ConsoleClient} */ (ctx.client);
		const session = await client.createSession(
			acceptanceSessionInput(ctx, {
				// 收件人不可达：投递注定失败，业务侧仍可继续。
				recipient: {
					accountId: ctx.env?.FEISHU_ACCOUNT_ID ?? "feishu-internal",
					kind: "user",
					externalId: UNREACHABLE_OPEN_ID,
				},
			}),
		);
		const detail = await client.getSession(session.id);
		ctx.vars.sessionId = session.id;
		ctx.vars.baseline = {
			version: detail.session.version,
			snapshots: detail.snapshots.length,
		};
		ctx.log?.(
			`会话已建立 session=${mask(session.id, 8, 0)}；收件人故意不可达，不发真实信息。`,
		);
	},
	steps: [
		{
			id: "failure.round1",
			read: readDetail,
			until: (state) =>
				Boolean(roundByNo(state.detail ?? {}, 1)) &&
				Boolean(failedDelivery(state.detail ?? {})) &&
				sendJobs(state.detail ?? {}).some((job) => job.status === "failed"),
			assertions: [
				{
					id: "failure.round1.delivery-failed",
					title: "第 1 轮决策卡投递失败且带可定位错误",
					check: (state) => {
						const delivery = failedDelivery(state.detail ?? {});
						return verdict(
							Boolean(delivery) && Boolean(delivery?.lastError) && !delivery?.externalMessageId,
							`status=${delivery?.status ?? "缺失"} message=${mask(delivery?.externalMessageId ?? "", 6, 4)} 错误=${(delivery?.lastError ?? "-").slice(0, 60)}`,
							"投递未标记失败：确认出站适配器把平台错误向上抛出",
						);
					},
				},
				{
					id: "failure.round1.round-open",
					title: "投递失败不影响会话与轮次状态",
					check: (state, ctx) => {
						const detail = state.detail;
						const baseline =
							/** @type {{ version: number, snapshots: number }} */ (
								ctx.vars.baseline
							);
						return assertEqual(
							[
								roundByNo(detail ?? {}, 1)?.status,
								detail?.session.version,
								detail?.snapshots.length,
							],
							["open", baseline.version, baseline.snapshots],
							"round1/version/snapshots",
						);
					},
				},
			],
		},
		{
			id: "failure.business",
			before: async (ctx) => {
				const client = /** @type {ConsoleClient} */ (ctx.client);
				const detail = await client.getSession(String(ctx.vars.sessionId));
				const actionRef = actionRefOf(detail, 1, "observe");
				if (!actionRef) throw new Error("第 1 轮缺少 observe 动作");
				await client.submitChoice(actionRef);
			},
			read: readDetail,
			until: (state) =>
				roundByNo(state.detail ?? {}, 1)?.status === "answered" &&
				Boolean(failedDelivery(state.detail ?? {})),
			assertions: [
				{
					id: "failure.business-succeeded",
					title: "业务动作成功：轮次已答、版本与快照落库",
					check: (state, ctx) => {
						const detail = state.detail;
						const baseline =
							/** @type {{ version: number, snapshots: number }} */ (
								ctx.vars.baseline
							);
						const inbox = inboxFor(
							detail ?? {},
							actionRefOf(detail ?? {}, 1, "observe"),
						);
						return verdict(
							roundByNo(detail ?? {}, 1)?.status === "answered" &&
								detail?.session.version === baseline.version + 1 &&
								detail?.snapshots.length === baseline.snapshots + 1 &&
								inbox?.status === "processed",
							`round1=${roundByNo(detail ?? {}, 1)?.status ?? "-"} version=${baseline.version}→${detail?.session.version ?? "-"} 快照+${(detail?.snapshots.length ?? 0) - baseline.snapshots} inbox=${inbox?.status ?? "-"}`,
							"业务侧未成功：投递失败不应阻塞决策提交",
						);
					},
				},
				{
					id: "failure.delivery-still-failed",
					title: "投递仍然失败，并被记录为独立状态",
					check: (state, ctx) => {
						const detail = state.detail;
						const job = sendJobs(detail ?? {}).find(
							(item) => item.status === "failed",
						);
						ctx.vars.jobId = job?.id;
						ctx.vars.deliveryId = job?.task.deliveryId;
						ctx.vars.attemptsBefore = job?.attempts ?? 0;
						ctx.vars.deliveryCount =
							(detail?.deliveries ?? []).length;
						return verdict(
							Boolean(job) &&
								(job?.attempts ?? 0) > 1 &&
								(detail?.deliveries ?? []).some(
									(item) => item.id === job?.task.deliveryId && item.status === "failed",
								),
							`job=${job?.status ?? "缺失"} attempts=${job?.attempts ?? 0} delivery=${mask(job?.task.deliveryId ?? "", 8, 0)}`,
							"未观察到投递失败：确认第 2 轮卡片确实尝试发送且失败",
						);
					},
				},
			],
		},
		{
			id: "failure.retry",
			before: async (ctx) => {
				const client = /** @type {ConsoleClient} */ (ctx.client);
				await client.retryJob(String(ctx.vars.jobId));
			},
			read: readDetail,
			until: (state, ctx) => {
				const before = Number(ctx.vars.attemptsBefore ?? 0);
				const jobId = String(ctx.vars.jobId ?? "");
				const job = (state.detail?.jobs ?? []).find((item) => item.id === jobId);
				return Boolean(job) && (job !== undefined && (job.attempts < before || job.status === "pending"));
			},
			assertions: [
				{
					id: "failure.retry-same-delivery",
					title: "重试复用同一 delivery.id",
					check: (state, ctx) => {
						const before = String(ctx.vars.deliveryId ?? "");
						const countBefore = Number(ctx.vars.deliveryCount ?? 0);
						const deliveries = state.detail?.deliveries ?? [];
						const current = deliveries.find((item) => item.id === before);
						return verdict(
							Boolean(before) && Boolean(current) && deliveries.length === countBefore,
							`同一 delivery=${Boolean(current)} 条数 ${countBefore} → ${deliveries.length} status=${current?.status ?? "缺失"}`,
							"重试新增了 delivery：平台去重（uuid）语义会被破坏",
						);
					},
				},
				{
					id: "failure.retry-restarted",
					title: "重试确实重新执行（attempts 归零后重跑）",
					check: (state, ctx) => {
						const jobId = String(ctx.vars.jobId ?? "");
						const job = (state.detail?.jobs ?? []).find((item) => item.id === jobId);
						const before = Number(ctx.vars.attemptsBefore ?? 0);
						return verdict(
							Boolean(job) && (job?.attempts ?? 0) < before,
							`attempts ${before} → ${job?.attempts ?? "-"} status=${job?.status ?? "-"}`,
							"未观察到重试生效：确认 /api/jobs/{id}/retry 只接受 failed 任务",
						);
					},
				},
			],
		},
	],
});
