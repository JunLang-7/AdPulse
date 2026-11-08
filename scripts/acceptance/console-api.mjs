// 控制台 API 客户端：验收场景只经生成契约的 HTTP 接口访问，不直接引用后端源码。

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
 * @property {{ actionRef: string }} command
 *
 * @typedef {Object} DetailDelivery
 * @property {string} id
 * @property {string} status
 * @property {string} purpose
 * @property {string} roundId
 * @property {string} [externalMessageId]
 *
 * @typedef {Object} SessionDetail
 * @property {DetailSession} session
 * @property {DetailRound[]} rounds
 * @property {DetailAction[]} actions
 * @property {DetailInboxEntry[]} inbox
 * @property {DetailDelivery[]} deliveries
 * @property {Array<{ version: number }>} snapshots
 * @property {Array<{ id: string, status: string, task: object }>} jobs
 *
 * @typedef {Object} ChoiceReceipt
 * @property {string} inboxId
 * @property {string} status
 *
 * @typedef {Object} ConsoleClient
 * @property {(input: object) => Promise<DetailSession>} createSession
 * @property {(id: string) => Promise<SessionDetail>} getSession
 * @property {(actionRef: string) => Promise<ChoiceReceipt>} submitChoice
 * @property {(inboxId: string) => Promise<DetailInboxEntry>} getChoice
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
 * @param {{ baseUrl: string, token: string, timeoutMs?: number }} options
 * @returns {ConsoleClient}
 */
export function createConsoleClient({ baseUrl, token, timeoutMs = 10_000 }) {
	if (!baseUrl) throw new Error("缺少 API 地址");
	if (!token) throw new Error("缺少 CONSOLE_TOKEN");
	const base = baseUrl.replace(/\/+$/, "");

	async function request(path, init = {}) {
		const { response, body } = await callJson(
			base + path,
			{
				...init,
				headers: {
					authorization: `Bearer ${token}`,
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
	};
}
