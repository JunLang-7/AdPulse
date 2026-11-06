import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type {
	InboundChannel,
	InboundResult,
	WebhookRequest,
} from "../contracts.js";
import { jsonResponse, WebhookError } from "../contracts.js";

export interface FeishuInboundConfig {
	accountId: string;
	appId: string;
	tenantKey: string;
	verificationToken: string;
	encryptKey: string;
}
export class FeishuInbound implements InboundChannel {
	constructor(
		private config: FeishuInboundConfig,
		private now = () => Date.now(),
	) {
		if (Object.values(config).some((value) => !value))
			throw new Error("incomplete Feishu inbound configuration");
	}

	async parse(request: WebhookRequest): Promise<InboundResult> {
		if (request.method !== "POST") throw new WebhookError(405, "POST required");
		const timestamp = request.headers["x-lark-request-timestamp"];
		const nonce = request.headers["x-lark-request-nonce"];
		const signature = request.headers["x-lark-signature"];
		// The platform omits the x-lark-* headers when it verifies a callback URL,
		// so a missing signature is only acceptable for that challenge (see below).
		const signed = Boolean(timestamp || nonce || signature);
		if (signed) {
			const timestampMs = timestamp ? parseTimestamp(timestamp) : undefined;
			if (
				!timestamp ||
				!nonce ||
				!signature ||
				timestampMs === undefined ||
				Math.abs(this.now() - timestampMs) > 300_000
			) {
				throw new WebhookError(401, "invalid signature timestamp");
			}
			const expected = createHash("sha256")
				.update(timestamp + nonce + this.config.encryptKey)
				.update(request.rawBody)
				.digest("hex");
			if (!equal(signature, expected))
				throw new WebhookError(401, "invalid signature");
		}
		let payload: Record<string, unknown>;
		let sealed = false;
		try {
			const envelope = object(
				JSON.parse(Buffer.from(request.rawBody).toString("utf8")),
			);
			if (typeof envelope.encrypt === "string") {
				sealed = true;
				const binary = Buffer.from(envelope.encrypt, "base64");
				const key = createHash("sha256")
					.update(this.config.encryptKey)
					.digest();
				const cipher = createDecipheriv(
					"aes-256-cbc",
					key,
					binary.subarray(0, 16),
				);
				payload = object(
					JSON.parse(
						Buffer.concat([
							cipher.update(binary.subarray(16)),
							cipher.final(),
						]).toString("utf8"),
					),
				);
			} else {
				payload = envelope;
			}
		} catch {
			throw new WebhookError(400, "invalid callback payload");
		}
		if (!payload || typeof payload !== "object")
			throw new WebhookError(400, "invalid callback payload");
		if (payload.type === "url_verification") {
			// Successful decryption or a valid signature already proves the caller knows the
			// shared secret; the token check stays for the plaintext handshake.
			if (
				(!signed && !sealed) ||
				!equal(payload.token, this.config.verificationToken) ||
				typeof payload.challenge !== "string"
			) {
				throw new WebhookError(403, "invalid verification token");
			}
			return {
				kind: "response",
				response: jsonResponse({ challenge: payload.challenge }),
			};
		}
		if (!signed) throw new WebhookError(401, "missing signature");
		const header = object(payload.header);
		if (
			!header ||
			!equal(header.token, this.config.verificationToken) ||
			header.app_id !== this.config.appId ||
			header.tenant_key !== this.config.tenantKey
		) {
			throw new WebhookError(403, "callback identity mismatch");
		}
		if (header.event_type !== "card.action.trigger")
			return { kind: "response", response: jsonResponse({}) };
		const event = object(payload.event);
		const operator = object(event.operator);
		const actionRef = object(object(event.action).value).actionRef;
		const actor = operator.open_id;
		if (
			typeof header.event_id !== "string" ||
			!header.event_id ||
			typeof actionRef !== "string" ||
			actionRef.length > 128 ||
			!actionRef ||
			typeof actor !== "string" ||
			!actor ||
			operator.tenant_key !== this.config.tenantKey
		) {
			throw new WebhookError(400, "invalid card action");
		}
		return {
			kind: "choice",
			command: {
				sourceId: this.config.accountId,
				eventId: header.event_id,
				actionRef,
				actor: {
					kind: "platform",
					accountId: this.config.accountId,
					externalId: actor,
				},
			},
			response: jsonResponse({
				toast: {
					type: "info",
					content: "已接收，正在处理。请在控制台查看结果。",
				},
			}),
		};
	}
}
// Accept documented Unix seconds and the signed Go time.Time string observed on
// card callbacks. The original header, not this parsed value, is used for signing.
function parseTimestamp(value: string): number | undefined {
	if (/^\d+$/.test(value)) {
		const ms = Number(value) * 1000;
		return Number.isSafeInteger(ms) ? ms : undefined;
	}
	const match =
		/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))? ([+-])(\d{2})(\d{2}) [A-Za-z]{1,10}(?: m=[+-]\d+\.\d+)?$/.exec(
			value,
		);
	if (!match) return undefined;
	const [, date, time, fraction, sign, hours, minutes] = match;
	if (
		!date ||
		!time ||
		!sign ||
		!hours ||
		!minutes ||
		Number(hours) > 23 ||
		Number(minutes) > 59
	)
		return undefined;
	const millis = (fraction ?? "").padEnd(3, "0").slice(0, 3);
	const local = `${date}T${time}.${millis}Z`;
	const localMs = Date.parse(local);
	if (!Number.isFinite(localMs) || new Date(localMs).toISOString() !== local)
		return undefined;
	const offset = (Number(hours) * 60 + Number(minutes)) * 60_000;
	return localMs + (sign === "+" ? -offset : offset);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new WebhookError(400, "invalid callback object");
	return value as Record<string, unknown>;
}
function equal(actual: unknown, expected: string): boolean {
	if (typeof actual !== "string") return false;
	const a = Buffer.from(actual);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
