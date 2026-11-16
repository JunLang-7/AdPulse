// 个人模型凭据的加解密装配（#86 PR1）。
// AES-256-GCM、每次随机 nonce、AAD 由 core 生成；主密钥只来自部署配置，
// 不进数据库、不进浏览器，也不作为命令行参数打印。
// 密钥环缺失或不合法时返回 undefined：调用方据此失败关闭，不存在明文兜底。

import crypto from "node:crypto";
import type { ModelCredentialCipher } from "@adpluse/core";

const algorithm = "aes-256-gcm" as const;
const nonceBytes = 12;
const keyBytes = 32;
const keyIdPattern = /^[A-Za-z0-9._-]{1,32}$/;

export interface CredentialKeyring {
	keys: ReadonlyMap<string, Buffer>;
	activeKeyId: string;
}

/**
 * 解析 `MODEL_CREDENTIAL_KEYRING`：逗号分隔的 `keyId:base64-32bytes`。
 * 顺序即轮换顺序，最后一支默认成为 active；也可用 `MODEL_CREDENTIAL_ACTIVE_KEY` 显式指定。
 */
export function parseModelCredentialKeyring(
	value: string | undefined,
	activeKey?: string,
): CredentialKeyring | undefined {
	if (!value?.trim()) return;
	const keys = new Map<string, Buffer>();
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const separator = trimmed.indexOf(":");
		if (separator <= 0) return;
		const keyId = trimmed.slice(0, separator);
		const encoded = trimmed.slice(separator + 1);
		if (!keyIdPattern.test(keyId) || keys.has(keyId)) return;
		const decoded = Buffer.from(encoded, "base64");
		const canonical = decoded.toString("base64");
		if (decoded.length !== keyBytes || (encoded !== canonical && encoded !== canonical.slice(0, -1))) return;
		keys.set(keyId, decoded);
	}
	if (keys.size === 0) return;
	const activeKeyId = activeKey?.trim() || [...keys.keys()].at(-1)!;
	if (!keys.has(activeKeyId)) return;
	return { keys, activeKeyId };
}

export function createModelCredentialCipher(
	env: Record<string, string | undefined>,
): ModelCredentialCipher | undefined {
	const keyring = parseModelCredentialKeyring(
		env.MODEL_CREDENTIAL_KEYRING,
		env.MODEL_CREDENTIAL_ACTIVE_KEY,
	);
	if (!keyring) return;
	return {
		activeKeyId: keyring.activeKeyId,
		encrypt({ plaintext, aad }) {
			const key = keyring.keys.get(keyring.activeKeyId);
			if (!key) throw new Error("active credential key is unavailable");
			const nonce = crypto.randomBytes(nonceBytes);
			const cipher = crypto.createCipheriv(algorithm, key, nonce);
			cipher.setAAD(Buffer.from(aad, "utf8"));
			const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
			return {
				keyId: keyring.activeKeyId,
				algorithm,
				nonce: nonce.toString("base64"),
				ciphertext: ciphertext.toString("base64"),
				authTag: cipher.getAuthTag().toString("base64"),
			};
		},
		decrypt({ ciphertext, aad }) {
			// 未知 keyId、被篡改的密文/tag、AAD 不匹配都按失败关闭处理。
			try {
				const key = keyring.keys.get(ciphertext.keyId);
				if (!key || ciphertext.algorithm !== algorithm) return null;
				const nonce = Buffer.from(ciphertext.nonce, "base64");
				const tag = Buffer.from(ciphertext.authTag, "base64");
				if (nonce.length !== nonceBytes || tag.length !== 16) return null;
				const decipher = crypto.createDecipheriv(
					algorithm,
					key,
					nonce,
				);
				decipher.setAAD(Buffer.from(aad, "utf8"));
				decipher.setAuthTag(tag);
				return Buffer.concat([
					decipher.update(Buffer.from(ciphertext.ciphertext, "base64")),
					decipher.final(),
				]).toString("utf8");
			} catch {
				return null;
			}
		},
	};
}
