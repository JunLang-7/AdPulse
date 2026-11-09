// 控制台 API 客户端：验收场景只经生成契约的 HTTP 接口访问，不直接引用后端源码。

import { FAULT_HEADER, FAULT_MARKER } from "./fault-injection.mjs";
import { randomUUID } from "node:crypto";

import { callJson } from "./http.mjs";
import { maskBody } from "./redact.mjs";

/**
 * 会话详情里场景断言用到的字段子集（与 contracts/openapi.json 的 SessionDetail 对应）。
 * @typedef {Object} DetailSession
 * @property {string} id
 * @property {string} status
 * @property {number} version
 * @property {number} roundNo
 * @property {string} [expiresAt]
 *
 * @typedef {Object} DetailRound
 * @property {string} id
 * @property {number} roundNo
 * @property {string} status
 * @property {string} [selectedOptionId]
 * @property {{ kind: string, externalId?: string, userId?: string }} [selectedBy]
 * @property {Array<{ id: string, label: string, complete: boolean }>} candidates
 *
 * @typedef {Object} DetailAction
 * @property {string} id
 * @property {string} roundId
 * @property {string} optionId
 *
 * @typedef {Object} DetailInboxEntry
 * @property {string} id
 * @property {string} status
 * @property {string} [reason]
 * @property {{ actionRef: string, actor?: { kind: string, externalId?: string, userId?: string } }} command
 *
 * @typedef {Object} DetailDelivery
 * @property {string} id
 * @property {string} status
 * @property {string} purpose
 * @property {string} roundId
 * @property {string} [externalMessageId]
 * @property {string} [lastError]
 *
 * @typedef {Object} SessionDetail
 * @property {DetailSession} session
 * @property {DetailRound[]} rounds
 * @property {DetailAction[]} actions
 * @property {DetailInboxEntry[]} inbox
 * @property {DetailDelivery[]} deliveries
 * @property {Array<{ version: number }>} snapshots
 * @property {Array<{ id: string, status: string, attempts: number, leaseToken?: string, lastError?: string, task: { kind: string, deliveryId?: string } }>} jobs
 *
 * @typedef {Object} ChoiceReceipt
 * @property {string} inboxId
 * @property {string} status
 *
 * @typedef {Object} ConsoleAuth
 * @property {string} [token] 旧方案：静态 Bearer（#34 之后不再存在）
 * @property {string} [sessionCookie] `adpulse_session` 的值
 * @property {string} [origin] 与 PUBLIC_ORIGIN 一致的同源 Origin
 *
 * @typedef {Object} ConsoleClient
 * @property {() => Promise<void>} assertFaultInjection
 * @property {(input: object) => Promise<DetailSession>} createSession
 * @property {(id: string) => Promise<SessionDetail>} getSession
 * @property {(actionRef: string) => Promise<ChoiceReceipt>} submitChoice
 * @property {(inboxId: string) => Promise<DetailInboxEntry>} getChoice
 * @property {(jobId: string) => Promise<{ ok: boolean }>} retryJob
 */

export class ConsoleApiError extends Error {
	constructor(message, status, body) {
		super(message);
		this.name = "ConsoleApiError";
		this.status = status;
		this.body = body;
	}
}

/**
 * 构造鉴权头：#34 之后控制台只有 OAuth 会话 Cookie，且副作用请求要求同源 Origin；
 * 同时保留旧的 Bearer 分支，便于在未升级的部署上继续跑验收。
 * @param {ConsoleAuth} auth
 * @param {string} [method]
 */
export function authHeaders(auth, method = "GET") {
	if (auth.sessionCookie) {
		const headers = { cookie: `adpulse_session=${auth.sessionCookie}` };
		// 同源检查只作用于副作用请求；GET 不需要。
		if (auth.origin && method !== "GET") headers.origin = auth.origin;
		return headers;
	}
	if (auth.token) return { authorization: `Bearer ${auth.token}` };
	throw new Error(
		"缺少控制台凭据：设置 ADPULSE_SESSION_COOKIE（#34 之后）或 CONSOLE_TOKEN（旧部署）",
	);
}

/**
 * @param {{ baseUrl: string, auth?: ConsoleAuth, timeoutMs?: number }} options
 * @returns {ConsoleClient}
 */
export function createConsoleClient({ baseUrl, auth, timeoutMs = 10_000 }) {
	if (!baseUrl) throw new Error("缺少 API 地址");
	const base = baseUrl.replace(/\/+$/, "");

	async function request(path, init = {}) {
		const { response, body } = await callJson(
			base + path,
			{
				...init,
				headers: {
					...authHeaders(/** @type {ConsoleAuth} */ (auth), init.method),
					"content-type": "application/json",
					...(init.headers ?? {}),
				},
			},
			{ timeoutMs },
		);
		if (!response.ok)
			throw new ConsoleApiError(
				`${init.method ?? "GET"} ${path} → HTTP ${response.status} ${maskBody(body)}`,
				response.status,
				body,
			);
		return body;
	}

	return {
		async assertFaultInjection() {
			const { response } = await callJson(base + "/api/me", { headers: authHeaders(auth) }, { timeoutMs });
			if (!response.ok || response.headers.get(FAULT_HEADER) !== FAULT_MARKER)
				throw new Error("该场景只允许 scripts/acceptance/failure-server.mjs 的隔离出站故障夹具；尚未创建会话");
		},
		/** 每次新建会话用独立幂等键；同键重放由服务端返回原会话。 */
		createSession: (input) =>
			request("/api/sessions", {
				method: "POST",
				headers: { "idempotency-key": randomUUID() },
				body: JSON.stringify(input),
			}),
		getSession: (id) => request(`/api/sessions/${encodeURIComponent(id)}`),
		/** 202 只表示已接收；终态用 getChoice 查询。 */
		submitChoice: (actionRef) =>
			request("/api/choices", {
				method: "POST",
				headers: { "idempotency-key": randomUUID() },
				body: JSON.stringify({ actionRef }),
			}),
		getChoice: (inboxId) =>
			request(`/api/choices/${encodeURIComponent(inboxId)}`),
		/** 仅允许所属用户重试 failed 任务；复用同一 delivery.id。 */
		retryJob: (jobId) =>
			request(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
				method: "POST",
				headers: { "idempotency-key": randomUUID() },
			}),
	};
}
