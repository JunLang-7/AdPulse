#!/usr/bin/env node
// 导出删除清单为 append-only JSONL（#40 S4b）。
// 清单必须独立于数据库备份保存：恢复一份早于删除请求的备份时，备份里根本没有清单。
//
//   node --env-file=<env> scripts/lifecycle-export-manifest.mjs > manifest.jsonl
//   node --env-file=<env> scripts/lifecycle-export-manifest.mjs --out manifest.jsonl
import { writeFileSync } from "node:fs";
import { PostgresStorage } from "../packages/storage/dist/index.js";
import { serializeManifest } from "../packages/core/dist/index.js";

const args = process.argv.slice(2);
const at = args.indexOf("--out");
const out = at >= 0 ? args[at + 1] : null;
if (!process.env.DATABASE_URL) {
	console.error("DATABASE_URL required; pass --env-file=<path> before the script path");
	process.exit(2);
}

const storage = PostgresStorage.connect(process.env.DATABASE_URL);
try {
	await storage.initialize();
	const rows = await storage.transaction((tx) => tx.lifecycleDeletions.all());
	const text = serializeManifest(rows.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)));
	if (out) writeFileSync(out, text, { mode: 0o600 });
	else process.stdout.write(text);
	console.error(`exported ${rows.length} manifest entr${rows.length === 1 ? "y" : "ies"}`);
} finally {
	await storage.close();
}
