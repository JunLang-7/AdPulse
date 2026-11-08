// db-down 场景：落库前失败不产生成功 ACK，恢复后只处理一次（runbook 第 6 节）。
// 只在 API 明确指向本脚本自建的一次性数据库时才会停库；否则记 skip，绝不碰生产库。
// 证据为 local-real：回调由本脚本按真实密钥签名，不是平台推送。

import { EVIDENCE } from "../checks.mjs";
import { createManagedDocker, pointsAtManagedDb } from "../docker.mjs";
import { actionPayload, signedRequest } from "../feishu-crypto.mjs";
import { callJson } from "../http.mjs";
import { mask } from "../redact.mjs";
import { defineScenario, verdict } from "../scenario.mjs";
import {
	actionRefOf,
	roundByNo,
	startAcceptanceSession,
} from "./fixture.mjs";

/**
 * @typedef {import("../console-api.mjs").ConsoleClient} ConsoleClient
 * @typedef {import("../console-api.mjs").SessionDetail} SessionDetail
 * @typedef {import("../scenario.mjs").ScenarioContext} ScenarioContext
 * @typedef {{ detail: SessionDetail | undefined, status: number, skipped?: boolean }} DbDownState
 */

const webhookUrl = (/** @type {ScenarioContext} */ ctx) =>
	`${String(ctx.options?.api)}/webhooks/${ctx.env?.FEISHU_ACCOUNT_ID ?? "feishu-internal"}`;

const readDetail = async (/** @type {ScenarioContext} */ ctx) => {
	// 未授权停库时不建会话，也就没有可读的会话：直接返回 skip 态。
	if (ctx.vars.skipReason) return { detail: undefined, status: 0, skipped: true };
	return {
		detail: await /** @type {ConsoleClient} */ (ctx.client).getSession(
			String(ctx.vars.sessionId),
		),
		status: 0,
	};
};

/** 用真实 encrypt key 构造并发送一次卡片动作回调。 */
async function sendSignedAction(ctx, eventId) {
	const request = signedRequest(
		actionPayload(
			{
				appId: ctx.env?.FEISHU_APP_ID ?? "",
				tenantKey: ctx.env?.FEISHU_TENANT_KEY ?? "",
				verificationToken: ctx.env?.FEISHU_VERIFICATION_TOKEN ?? "",
			},
			{
				eventId,
				actor: String(ctx.options?.openId),
				actionRef: String(ctx.vars.actionRef),
			},
		),
		{ encryptKey: ctx.env?.FEISHU_ENCRYPT_KEY ?? "", encrypt: true },
	);
	const result = await callJson(
		webhookUrl(ctx),
		{
			method: "POST",
			headers: request.headers,
			body: request.rawBody.toString("utf8"),
		},
		{ timeoutMs: 15_000 },
	).catch(() => ({ response: { status: 0 } }));
	return { detail: undefined, status: result.response.status };
}

const skipped = (/** @type {string} */ reason) => ({
	status: "skip",
	detail: `未覆盖：${reason}`,
	hint: "按 docs/development.md 用隔离实例验证；不要对生产库停库",
});

export const dbDownScenario = defineScenario({
	id: "db-down",
	title: "落库前失败与恢复后单次处理",
	evidence: EVIDENCE.localReal,
	timeoutMs: 180_000,
	setup: async (ctx) => {
		const databaseUrl = ctx.env?.DATABASE_URL ?? "";
		if (!ctx.options?.managedDb)
			ctx.vars.skipReason = "未提供 --managed-db，拒绝停库";
		else if (!pointsAtManagedDb(databaseUrl))
			ctx.vars.skipReason = `DATABASE_URL 不指向受管容器（需 127.0.0.1:5433/adpulse_acceptance）：${mask(databaseUrl, 12, 0)}`;
		if (ctx.vars.skipReason) {
			ctx.log?.(`跳过停库注入：${ctx.vars.skipReason}`);
			return;
		}
		const docker = createManagedDocker({ log: ctx.log });
		ctx.vars.docker = docker;
		docker.ensureDb();
		await docker.waitReady();

		// 收件人不可达：本场景只需要 actionRef，不期望卡片真的送达。
		const session = await startAcceptanceSession(ctx, {
			recipient: {
				accountId: ctx.env?.FEISHU_ACCOUNT_ID ?? "feishu-internal",
				kind: "user",
				externalId: "ou_0000000000000000000000000000000000",
			},
		});
		ctx.log?.(`隔离会话 session=${mask(session.id, 8, 0)}`);
	},
	steps: [
		{
			id: "db-down.prepare",
			read: readDetail,
			until: (state, ctx) =>
				Boolean(ctx.vars.skipReason) ||
				Boolean(actionRefOf(state.detail ?? {}, 1, "observe")),
			assertions: [
				{
					id: "db-down.prepare.action",
					title: "取得可提交的动作标识",
					check: (state, ctx) => {
						if (ctx.vars.skipReason) return skipped(String(ctx.vars.skipReason));
						const actionRef = actionRefOf(state.detail ?? {}, 1, "observe");
						ctx.vars.actionRef = actionRef;
						return verdict(
							Boolean(actionRef),
							`actionRef=${mask(actionRef ?? "", 8, 0)}`,
							"第 1 轮缺少动作：确认 prepare_round 已执行",
						);
					},
				},
			],
		},
		{
			id: "db-down.down",
			before: async (ctx) => {
				if (ctx.vars.skipReason) return;
				const docker = /** @type {ReturnType<typeof createManagedDocker>} */ (
					ctx.vars.docker
				);
				docker.stopDb();
				ctx.vars.downEventId = `acceptance-dbdown-${Date.now()}`;
				ctx.log?.("已停止一次性数据库容器，注入落库失败");
			},
			read: async (ctx) =>
				ctx.vars.skipReason
					? { detail: undefined, status: 0, skipped: true }
					: sendSignedAction(ctx, String(ctx.vars.downEventId)),
			until: () => true,
			assertions: [
				{
					id: "db-down.down.no-ack",
					title: "落库失败时不返回成功 ACK",
					check: (state, ctx) => {
						if (ctx.vars.skipReason) return skipped(String(ctx.vars.skipReason));
						return verdict(
							state.status >= 500 || state.status === 0,
							`HTTP ${state.status || "无响应"}（预期 5xx，未返回 challenge/ACK）`,
							"数据库不可用时接口返回 2xx：刷新前 ACK 语义不成立",
						);
					},
				},
			],
		},
		{
			id: "db-down.recover",
			before: async (ctx) => {
				if (ctx.vars.skipReason) return;
				const docker = /** @type {ReturnType<typeof createManagedDocker>} */ (
					ctx.vars.docker
				);
				docker.startDb();
				await docker.waitReady();
				ctx.log?.("数据库已恢复，重放同一事件");
			},
			read: async (ctx) =>
				ctx.vars.skipReason
					? { detail: undefined, status: 0, skipped: true }
					: sendSignedAction(ctx, String(ctx.vars.downEventId)),
			until: (state) => Boolean(state.skipped) || state.status >= 200,
			assertions: [
				{
					id: "db-down.recover.accepted",
					title: "恢复后同一事件被接受",
					check: (state, ctx) => {
						if (ctx.vars.skipReason) return skipped(String(ctx.vars.skipReason));
						return verdict(
							state.status === 200 || state.status === 202,
							`HTTP ${state.status || "无响应"}`,
							"恢复后仍失败：确认连接池能重连（见 #28）",
						);
					},
				},
			],
		},
		{
			id: "db-down.once",
			read: readDetail,
			until: (state, ctx) =>
				Boolean(ctx.vars.skipReason) ||
				(state.detail?.inbox ?? []).some((item) => item.status === "processed"),
			assertions: [
				{
					id: "db-down.once.processed",
					title: "恢复后只处理一次，策略只生效一次",
					check: (state, ctx) => {
						if (ctx.vars.skipReason) return skipped(String(ctx.vars.skipReason));
						const detail = state.detail;
						const inboxes = detail?.inbox ?? [];
						const answered = (detail?.rounds ?? []).filter(
							(round) => round.status === "answered",
						);
						return verdict(
							inboxes.length === 1 &&
								inboxes[0]?.status === "processed" &&
								answered.length === 1,
							`inbox=${inboxes.length} 状态=${inboxes[0]?.status ?? "-"} answered=${answered.length} version=${detail?.session.version ?? "-"}`,
							"出现重复处理：确认失败请求未留下 pending inbox",
						);
					},
				},
				{
					id: "db-down.once.round",
					title: "第 1 轮已按提交的选项推进",
					check: (state, ctx) => {
						if (ctx.vars.skipReason) return skipped(String(ctx.vars.skipReason));
						return verdict(
							roundByNo(state.detail ?? {}, 1)?.status === "answered",
							`round1=${roundByNo(state.detail ?? {}, 1)?.status ?? "缺失"}`,
							"轮次未推进：确认恢复后提交确实被处理",
						);
					},
				},
			],
		},
	],
	teardown: async (ctx) => {
		const docker = ctx.vars.docker;
		if (!docker || ctx.options?.keep) return;
		/** @type {ReturnType<typeof createManagedDocker>} */ (docker).cleanup();
	},
});
