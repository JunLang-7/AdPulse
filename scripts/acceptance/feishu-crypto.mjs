// 飞书回调的本地构造：真实 encrypt key 加密并按平台规则签名。
// 这些请求由本地发起，属 local-real 证据；不能替代平台真实推送。

import { createCipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-CBC：iv(16) + ciphertext，整体 base64，与平台加密推送一致。 */
export function seal(payload, encryptKey) {
	const iv = randomBytes(16);
	const key = createHash("sha256").update(encryptKey).digest();
	const cipher = createCipheriv("aes-256-cbc", key, iv);
	return Buffer.concat([
		iv,
		cipher.update(JSON.stringify(payload)),
		cipher.final(),
	]).toString("base64");
}

/**
 * 构造带回调签名的请求体。签名覆盖 timestamp + nonce + encryptKey + 原始字节。
 * @param {object} payload
 * @param {{ encryptKey: string, encrypt?: boolean, timestamp?: string, nonce?: string, signature?: string }} config
 */
export function signedRequest(payload, config) {
	const timestamp =
		config.timestamp ?? String(Math.floor(Date.now() / 1000));
	const nonce = config.nonce ?? randomBytes(8).toString("hex");
	const body = config.encrypt
		? { encrypt: seal(payload, config.encryptKey) }
		: payload;
	const rawBody = Buffer.from(JSON.stringify(body));
	const signature = createHash("sha256")
		.update(timestamp + nonce + config.encryptKey)
		.update(rawBody)
		.digest("hex");
	return {
		method: "POST",
		rawBody,
		headers: {
			"content-type": "application/json",
			"x-lark-request-timestamp": timestamp,
			"x-lark-request-nonce": nonce,
			"x-lark-signature": config.signature ?? signature,
		},
	};
}

export function challengePayload(verificationToken, overrides = {}) {
	return {
		type: "url_verification",
		token: overrides.token ?? verificationToken,
		challenge: overrides.challenge ?? randomBytes(8).toString("hex"),
	};
}

/**
 * 卡片动作回调（card.action.trigger）。
 * @param {{ appId: string, tenantKey: string, verificationToken: string }} config
 */
export function actionPayload(config, overrides = {}) {
	return {
		schema: "2.0",
		header: {
			event_id: overrides.eventId ?? `acceptance-${Date.now()}`,
			token: config.verificationToken,
			app_id: config.appId,
			tenant_key: overrides.tenantKey ?? config.tenantKey,
			event_type: "card.action.trigger",
		},
		event: {
			operator: {
				open_id: overrides.actor ?? "ou_acceptance_selfcheck",
				tenant_key: overrides.tenantKey ?? config.tenantKey,
			},
			action: { value: { actionRef: overrides.actionRef ?? "acceptance" } },
		},
	};
}
