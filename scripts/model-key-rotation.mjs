// 主密钥轮换/恢复演练脚本（#86 §6.2）。
// 只读取/重写凭据密文，不输出密钥、owner、连接 id 或上游错误。
// 用法：
//   node scripts/model-key-rotation.mjs --check   # 只验证现有密文能否用当前 keyring 解密
//   MODEL_KEY_ROTATION_CONFIRM=1 node scripts/model-key-rotation.mjs --rotate
// 需要 DATABASE_URL、MODEL_CREDENTIAL_KEYRING、MODEL_CREDENTIAL_ACTIVE_KEY。

import { pathToFileURL } from "node:url";
import { modelCredentialAad } from "../packages/core/dist/index.js";
import { createModelCredentialCipher } from "../packages/runtime/dist/index.js";
import { PostgresStorage } from "../packages/storage/dist/index.js";

/**
 * 逐条核对：密文能否用当前 keyring 解开；不写库。
 * 返回计数，不返回任何可识别信息。
 */
export function inspectRotation({ credentials, connections, cipher }) {
	let ok = 0;
	let failed = 0;
	let retired = 0;
	for (const credential of credentials) {
		const connection = connections.get(credential.connectionId);
		if (!connection || connection.ownerId !== credential.ownerId) {
			failed++;
			continue;
		}
		if (credential.keyId !== cipher.activeKeyId) retired++;
		const plaintext = cipher.decrypt({
			ciphertext: {
				keyId: credential.keyId,
				algorithm: credential.algorithm,
				nonce: credential.nonce,
				ciphertext: credential.ciphertext,
				authTag: credential.authTag,
			},
			aad: modelCredentialAad({
				ownerId: credential.ownerId,
				connectionId: credential.connectionId,
				credentialVersion: credential.credentialVersion,
				baseUrl: connection.baseUrl,
				protocol: connection.protocol,
			}),
		});
		if (plaintext === null) failed++;
		else ok++;
	}
	return { ok, failed, retired };
}

/** 从存储读出全部凭据与连接，再做只读核对。 */
export async function checkRotation(storage, cipher) {
	const { credentials, connections } = await storage.transaction(async (tx) => ({
		credentials: await tx.userModelCredentials.all(),
		connections: new Map((await tx.userModelConnections.all()).map((item) => [item.id, item])),
	}));
	return inspectRotation({ credentials, connections, cipher });
}

export function formatSummary(summary, mode) {
	return JSON.stringify({
		mode,
		activeKeyId: summary.activeKeyId,
		readable: summary.ok,
		failed: summary.failed,
		awaitingRotation: summary.retired,
		...(summary.rotated === undefined ? {} : { rotated: summary.rotated }),
	});
}

export async function main(argv = process.argv.slice(2), env = process.env) {
	const check = argv.includes("--check");
	const rotate = argv.includes("--rotate");
	if (check === rotate) {
		console.error("choose exactly one of --check or --rotate");
		return 2;
	}
	if (rotate && env.MODEL_KEY_ROTATION_CONFIRM !== "1") {
		console.error("set MODEL_KEY_ROTATION_CONFIRM=1 to rotate; --check is read-only");
		return 2;
	}
	if (!env.DATABASE_URL) {
		console.error("DATABASE_URL is required");
		return 2;
	}
	const cipher = createModelCredentialCipher(env);
	if (!cipher) {
		// 主密钥缺失或格式不对：绝不退回明文，也不动数据。
		console.error("MODEL_CREDENTIAL_KEYRING / MODEL_CREDENTIAL_ACTIVE_KEY are missing or invalid");
		return 2;
	}
	const storage = PostgresStorage.connect(env.DATABASE_URL);
	try {
		await storage.initialize();
		const before = await checkRotation(storage, cipher);
		if (check) {
			console.log(formatSummary({ ...before, activeKeyId: cipher.activeKeyId }, "check"));
			return before.failed === 0 ? 0 : 1;
		}
		const { ModelConnectionService } = await import("../packages/core/dist/index.js");
		const result = await new ModelConnectionService(storage, cipher).rotateCredentials();
		const after = await checkRotation(storage, cipher);
		console.log(formatSummary({
			...after,
			activeKeyId: cipher.activeKeyId,
			ok: after.ok,
			retired: after.retired,
			rotated: result.rotated,
			failed: result.failed + after.failed,
		}, "rotate"));
		return result.failed === 0 && after.failed === 0 ? 0 : 1;
	} finally {
		await storage.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main();
}
