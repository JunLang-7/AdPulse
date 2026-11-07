#!/usr/bin/env node
/**
 * Operator console for the limited source collector (issue #41).
 *
 *   node --env-file=.env scripts/sources.mjs status
 *   node --env-file=.env scripts/sources.mjs list weichai_news
 *   node --env-file=.env scripts/sources.mjs sync weichai_news
 *   node --env-file=.env scripts/sources.mjs purge haier_news
 *   node --env-file=.env scripts/sources.mjs resume haier_news ops@example
 *   node --env-file=.env scripts/sources.mjs prune haier_news
 *
 * sync is the only command that may reach the network, and only when
 * SOURCES_ENABLED=1. purge/resume stay available while collection is off.
 */
import { SOURCE_DEFINITIONS, SourceService } from "../packages/core/dist/index.js";
import { HttpSourceFetcher } from "../packages/runtime/dist/index.js";

const [command, sourceKey, operator] = process.argv.slice(2);

if (!process.env.DATABASE_URL) {
	console.error("DATABASE_URL required; memory storage is not usable here");
	process.exit(2);
}

const { PostgresStorage } = await import("../packages/storage/dist/index.js");
const storage = PostgresStorage.connect(process.env.DATABASE_URL);
await storage.initialize();
const service = new SourceService(
	storage,
	new HttpSourceFetcher(
		[...new Set(Object.values(SOURCE_DEFINITIONS).flatMap((s) => s.allowedHosts))],
	),
	{ enabled: process.env.SOURCES_ENABLED === "1" },
);
const now = new Date().toISOString();

const requireKey = () => {
	if (!sourceKey || !SOURCE_DEFINITIONS[sourceKey]) {
		console.error(
			`unknown source; expected one of ${Object.keys(SOURCE_DEFINITIONS).join(", ")}`,
		);
		process.exit(2);
	}
	return sourceKey;
};

try {
	if (command === "status") {
		const rows = [];
		for (const key of Object.keys(SOURCE_DEFINITIONS)) {
			const last = await service.lastRun(key);
			const items = await service.listItems(key);
			rows.push({
				source: key,
				enabled: process.env.SOURCES_ENABLED === "1",
				lastRun: last?.startedAt ?? null,
				lastOutcome: last?.outcome ?? null,
				lastReason: last?.errorReason ?? null,
				active: items.filter((item) => item.status === "active").length,
				purged: items.filter((item) => item.status === "purged").length,
			});
		}
		console.log(JSON.stringify(rows, null, 2));
	} else if (command === "list") {
		const items = SourceService.visible(await service.listItems(requireKey()));
		console.log(
			JSON.stringify(
				items.map((item) => ({
					title: item.title,
					publishedAt: item.publishedAt,
					url: item.itemUrl,
				})),
				null,
				2,
			),
		);
	} else if (command === "sync") {
		const result = await service.sync(requireKey(), now, { trigger: "manual" });
		console.log(JSON.stringify(result, null, 2));
	} else if (command === "purge") {
		const purged = await service.purge(requireKey(), now);
		console.log(JSON.stringify({ purged }, null, 2));
	} else if (command === "prune") {
		const removed = await service.pruneSnapshots(requireKey(), now);
		console.log(JSON.stringify({ removed }, null, 2));
	} else if (command === "resume") {
		if (!operator) {
			console.error("resume requires an operator identifier");
			process.exit(2);
		}
		console.log(JSON.stringify(await service.resume(requireKey(), now, operator), null, 2));
	} else {
		console.error(
			"usage: sources.mjs <status|list|sync|purge|prune|resume> [source] [operator]",
		);
		process.exit(2);
	}
} finally {
	await storage.close();
}
