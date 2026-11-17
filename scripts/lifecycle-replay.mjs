#!/usr/bin/env node
// 恢复后重放删除清单（#40 S4b）：写回清单、立即限访，并按到期规则清理。
//
//   node --env-file=<目标库 env> scripts/lifecycle-replay.mjs manifest.jsonl [--now <iso>]
//
// 顺序要求：先重放清单，再启用 API/worker。只操作 `--env-file` 指向的库。
import { readFileSync } from "node:fs";
import { PostgresStorage } from "../packages/storage/dist/index.js";
import {
	AuthenticationService,
	LifecycleCleanupService,
	LifecycleDeletionService,
	parseManifest,
	replayPlan,
} from "../packages/core/dist/index.js";

const argv = process.argv.slice(2);
const [file] = argv.filter((arg) => !arg.startsWith("--"));
const nowIndex = argv.indexOf("--now");
const now = nowIndex >= 0 ? argv[nowIndex + 1] : new Date().toISOString();
if (!file) {
	console.error("usage: lifecycle-replay.mjs <manifest.jsonl> [--now <iso>]");
	process.exit(2);
}
if (!process.env.DATABASE_URL) {
	console.error("DATABASE_URL required; pass --env-file=<path> before the script path");
	process.exit(2);
}
if (!Number.isFinite(Date.parse(now))) {
	console.error("--now must be an ISO timestamp");
	process.exit(2);
}

const entries = parseManifest(readFileSync(file, "utf8"));
const plan = replayPlan(entries, new Date(now));
const storage = PostgresStorage.connect(process.env.DATABASE_URL);
const clock = () => now;
try {
	await storage.initialize();
	// 顺序不能反：#40 要求「先应用删除/到期/撤销规则，再启用入口与 worker」。
	const replayed = await new LifecycleDeletionService(storage, clock).replay(plan.applicable);
	const cleaned = await new LifecycleCleanupService(storage, clock).runOnce();
	// 恢复出来的浏览器会话一律作废，必须重新走飞书认证。
	const revokedSessions = await new AuthenticationService(storage, clock).revokeAllSessions(now);
	process.stdout.write(`${JSON.stringify({
		file,
		now,
		entries: entries.length,
		applicable: plan.applicable.length,
		dueNow: plan.dueNow.length,
		inserted: replayed.inserted,
		kept: replayed.kept,
		cleanupManifests: cleaned.manifests,
		cleanupFailed: cleaned.failed,
		revokedSessions,
		note: "重放后已删任务立即限访、恢复出的会话全部作废；未到期清单保持 pending，由在线清理按 7 天处理",
	}, null, 2)}\n`);
} finally {
	await storage.close();
}
