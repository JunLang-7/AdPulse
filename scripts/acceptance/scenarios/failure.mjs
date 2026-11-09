// failure 场景：投递失败与业务成功分离，且任务重试复用同一 delivery.id（runbook 第 8 节）。
// 使用本人身份；只连接 failure-server.mjs 的出站故障夹具，不发送真实 IM。
// 业务动作由控制台接口提交；仅替换出站网络，不替换 API/领域/worker。
// 证据为 synthetic：故障夹具替代出站网络，不证明飞书平台行为。

import { OUTBOUND_FAILURE_MESSAGE } from "../fault-injection.mjs";
import { EVIDENCE } from "../checks.mjs";
import { mask } from "../redact.mjs";
import { assertEqual, defineScenario, verdict } from "../scenario.mjs";
import { acceptanceSessionInput, actionRefOf, inboxFor, roundByNo } from "./fixture.mjs";

/**
 * @typedef {import("../console-api.mjs").ConsoleClient} ConsoleClient
 * @typedef {import("../console-api.mjs").SessionDetail} SessionDetail
 * @typedef {import("../scenario.mjs").ScenarioContext} ScenarioContext
 */

/** @param {ScenarioContext} ctx */
const readDetail = async (ctx) => ({
	detail: await /** @type {ConsoleClient} */ (ctx.client).getSession(
		String(ctx.vars.sessionId),
	),
	inbox: undefined,
});

const sendJobs = (/** @type {SessionDetail} */ detail) =>
	detail.jobs.filter((job) => job.task.kind === "send_delivery");

const deliveryForRound = (detail, roundNo) =>
	detail?.deliveries.find((delivery) => delivery.roundId === roundByNo(detail, roundNo)?.id);

const failedDelivery = (/** @type {SessionDetail} */ detail) =>
	detail.deliveries.find((item) => item.status === "failed");

export const failureScenario = defineScenario({
	id: "failure",
	title: "投递失败与业务成功分离",
	evidence: EVIDENCE.synthetic,
	timeoutMs: 180_000,
	setup: async (ctx) => {
		const client = /** @type {ConsoleClient} */ (ctx.client);
		await client.assertFaultInjection();
		const session = await client.createSession(acceptanceSessionInput(ctx));
		const detail = await client.getSession(session.id);
		ctx.vars.sessionId = session.id;
		ctx.vars.baseline = {
			version: detail.session.version,
			snapshots: detail.snapshots.length,
		};
		ctx.log?.(
			`会话已建立 session=${mask(session.id, 8, 0)}；出站故障夹具已确认，不发真实信息。`,
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
							Boolean(delivery) && delivery?.lastError === OUTBOUND_FAILURE_MESSAGE && !delivery?.externalMessageId,
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
				sendJobs(state.detail ?? {}).some((job) => job.status === "failed" && job.task.deliveryId === deliveryForRound(state.detail, 2)?.id),
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
							(item) => item.status === "failed" && item.task.deliveryId === deliveryForRound(detail, 2)?.id,
						);
						ctx.vars.jobId = job?.id;
						ctx.vars.deliveryId = job?.task.deliveryId;
						ctx.vars.leaseBefore = job?.leaseToken;
						ctx.vars.deliveryCount =
							(detail?.deliveries ?? []).length;
						return verdict(
							Boolean(job) &&
								(job?.attempts ?? 0) > 1 && Boolean(job?.leaseToken) &&
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
				const job = state.detail?.jobs.find((item) => item.id === ctx.vars.jobId);
				const delivery = state.detail?.deliveries.find((item) => item.id === ctx.vars.deliveryId);
				return Boolean(ctx.vars.leaseBefore) && job?.status === "failed" && job.attempts > 0 &&
					Boolean(job.leaseToken) && job.leaseToken !== ctx.vars.leaseBefore &&
					delivery?.status === "failed" && delivery.lastError === OUTBOUND_FAILURE_MESSAGE;
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
							Boolean(before) && Boolean(current) && deliveries.length === countBefore &&
								state.detail?.jobs.find((item) => item.id === ctx.vars.jobId)?.task.deliveryId === before,
							`同一 delivery=${Boolean(current)} 条数 ${countBefore} → ${deliveries.length} status=${current?.status ?? "缺失"}`,
							"重试新增了 delivery：平台去重（uuid）语义会被破坏",
						);
					},
				},
				{
					id: "failure.retry-restarted",
					title: "新 worker 执行已再次到达投递失败终态",
					check: (state, ctx) => {
						const jobId = String(ctx.vars.jobId ?? "");
						const job = (state.detail?.jobs ?? []).find((item) => item.id === jobId);
						const before = ctx.vars.leaseBefore;
						return verdict(
							job?.status === "failed" && job.attempts > 0 && Boolean(job.leaseToken) && job.leaseToken !== before,
							`新执行=${Boolean(job?.leaseToken) && job?.leaseToken !== before} attempts=${job?.attempts ?? "-"} status=${job?.status ?? "-"}`,
							"未观察到重试生效：确认 /api/jobs/{id}/retry 只接受 failed 任务",
						);
					},
				},
			],
		},
	],
});
