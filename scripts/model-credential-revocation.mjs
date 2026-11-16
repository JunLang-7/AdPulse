// 撤销记录导出/重放（#86 §6.3 + #40）：恢复备份后重新执行删除，防止旧凭据或
// 旧默认选择被“复活”。只处理撤销墓碑，不含密钥、密文或上游错误。
//
// 用法（需要 DATABASE_URL、MODEL_CREDENTIAL_KEYRING、MODEL_CREDENTIAL_ACTIVE_KEY）：
//   node scripts/model-credential-revocation.mjs --export revocations.json
//   node scripts/model-credential-revocation.mjs --replay revocations.json            # 只报告
//   MODEL_REVOCATION_REPLAY_CONFIRM=1 \
//     node scripts/model-credential-revocation.mjs --replay revocations.json --apply
//
// 导出文件应保存在备份之外（例如运维凭据库）；恢复流程必须先 --apply 再放流量。

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createModelCredentialCipher } from "../packages/runtime/dist/index.js";
import { PostgresStorage } from "../packages/storage/dist/index.js";

const reasons = new Set(["credential_removed", "connection_deleted"]);

/** 只保留重放需要的字段；拒绝多余或缺失字段，避免把任意 JSON 写进墓碑表。 */
export function parseRevocations(raw) {
	const parsed = raw;
	if (!Array.isArray(parsed)) throw new Error("revocation file must contain an array");
	return parsed.map((entry) => {
		if (typeof entry !== "object" || entry === null) throw new Error("invalid revocation entry");
		const { ownerId, connectionId, credentialVersion, reason, revokedAt } = entry;
		if (typeof ownerId !== "string" || ownerId.length === 0) throw new Error("invalid ownerId");
		if (typeof connectionId !== "string" || connectionId.length === 0) throw new Error("invalid connectionId");
		if (!Number.isInteger(credentialVersion) || credentialVersion < 1) throw new Error("invalid credentialVersion");
		if (typeof reason !== "string" || !reasons.has(reason)) throw new Error("invalid reason");
		if (typeof revokedAt !== "string" || revokedAt.length === 0) throw new Error("invalid revokedAt");
		return { id: connectionId, ownerId, connectionId, credentialVersion, reason, revokedAt };
	});
}

export function formatReport(report, mode) {
	return JSON.stringify({ mode, ...report });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
	const exportAt = argv.indexOf("--export");
	const replayAt = argv.indexOf("--replay");
	if ((exportAt === -1) === (replayAt === -1)) {
		console.error("choose exactly one of --export <file> or --replay <file>");
		return 2;
	}
	const apply = argv.includes("--apply");
	if (apply && env.MODEL_REVOCATION_REPLAY_CONFIRM !== "1") {
		console.error("set MODEL_REVOCATION_REPLAY_CONFIRM=1 to apply; default is a read-only report");
		return 2;
	}
	if (!env.DATABASE_URL) {
		console.error("DATABASE_URL is required");
		return 2;
	}
	const cipher = createModelCredentialCipher(env);
	if (!cipher) {
		console.error("MODEL_CREDENTIAL_KEYRING / MODEL_CREDENTIAL_ACTIVE_KEY are missing or invalid");
		return 2;
	}
	const { ModelConnectionService } = await import("../packages/core/dist/index.js");
	const storage = PostgresStorage.connect(env.DATABASE_URL);
	try {
		await storage.initialize();
		const service = new ModelConnectionService(storage, cipher);
		if (exportAt !== -1) {
			const file = argv[exportAt + 1];
			if (!file) {
				console.error("--export needs a file path");
				return 2;
			}
			const revocations = await service.listRevocations();
			writeFileSync(file, JSON.stringify(revocations.map(({ ownerId, connectionId, credentialVersion, reason, revokedAt }) => (
				{ ownerId, connectionId, credentialVersion, reason, revokedAt }
			)), null, "\t") + "\n", "utf8");
			console.log(formatReport({ exported: revocations.length }, "export"));
			return 0;
		}
		const file = argv[replayAt + 1];
		if (!file) {
			console.error("--replay needs a file path");
			return 2;
		}
		let entries;
		try {
			entries = parseRevocations(JSON.parse(readFileSync(file, "utf8")));
		} catch (error) {
			console.error(`cannot read revocation file: ${error instanceof Error ? error.message : String(error)}`);
			return 2;
		}
		const report = await service.replayRevocations(entries, { apply });
		console.log(formatReport(report, apply ? "replay-apply" : "replay-check"));
		// 报告模式下只要还有需要停用的条目，就用非 0 退出码提醒不能直接放流量。
		return apply ? 0 : report.disabled === 0 ? 0 : 1;
	} finally {
		await storage.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main();
}
