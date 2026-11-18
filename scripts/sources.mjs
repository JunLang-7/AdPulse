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
 * discover searches the public index independently of the database.
 * sync reaches source sites only when SOURCES_ENABLED=1.
 */
import { DiscoveryLeadService, SOURCE_DEFINITIONS, SourceService } from "../packages/core/dist/index.js";
import { discoverSource, discoverXiaohongshu, HttpSourceFetcher } from "../packages/runtime/dist/index.js";

const [command, sourceKey, operator] = process.argv.slice(2);

/** 声明式主体：`brand:海尔` 或 `competitor:竞品A`；不写名时返回 null，不猜。 */
const parseSubject = (raw) => {
	if (!raw) return null;
	const idx = raw.indexOf(":");
	const kind = raw.slice(0, idx).trim() === "competitor" ? "competitor" : "brand";
	const name = idx >= 0 ? raw.slice(idx + 1).trim() : raw.trim();
	return name ? { kind, name } : null;
};

if (command === "discover") {
	try {
		const discoverArgs = process.argv.slice(3);
		const dSourceKey = discoverArgs[0];
		const dTopic = discoverArgs[1];
		const flags = { persist: null, subject: null };
		let persistFlag = false;
		for (let i = 2; i < discoverArgs.length; i++) {
			if (discoverArgs[i] === "--persist") { persistFlag = true; flags.persist = discoverArgs[++i] ?? null; }
			else if (discoverArgs[i] === "--subject") flags.subject = discoverArgs[++i] ?? null;
		}
		let result;
		if (dSourceKey === "xiaohongshu") {
			if (!dTopic) {
				console.error("xiaohongshu discovery requires a search query");
				process.exit(2);
			}
			const notes = await discoverXiaohongshu(dTopic, 5, process.env.AGENT_REACH_BIN);
			result = {
				sourceKey: "xiaohongshu",
				topic: dTopic,
				provider: "agent-reach/xiaohongshu",
				verification: "unverified",
				query: dTopic,
				subject: parseSubject(flags.subject),
				candidates: notes.map((note) => ({
					title: note.title,
					url: note.url,
					indexedPublishedAt: note.indexedPublishedAt,
					author: note.author,
				})),
			};
		} else {
			const discovered = await discoverSource(dSourceKey, dTopic, process.env.AGENT_REACH_BIN);
			result = {
				...discovered,
				subject: parseSubject(flags.subject) ?? SOURCE_DEFINITIONS[dSourceKey]?.subject ?? null,
			};
		}
		if (persistFlag) {
			if (!flags.persist) {
				console.error("--persist requires an operator identifier (lead ownerId)");
				process.exit(2);
			}
			if (!process.env.DATABASE_URL) {
				console.error("DATABASE_URL required to persist discovery leads");
				process.exit(2);
			}
			const { PostgresStorage } = await import("../packages/storage/dist/index.js");
			const storage = PostgresStorage.connect(process.env.DATABASE_URL);
			await storage.initialize();
			const service = new DiscoveryLeadService(storage);
			const persisted = await service.persist(flags.persist, {
				sourceKey: result.sourceKey,
				topic: result.topic,
				provider: result.provider,
				query: result.query,
				subject: result.subject,
				candidates: result.candidates.map((candidate) => ({
					title: candidate.title,
					url: candidate.url,
					indexedPublishedAt: candidate.indexedPublishedAt,
					...(candidate.author ? { author: candidate.author } : {}),
				})),
			}, new Date().toISOString());
			await new Promise((resolve) => process.stdout.write(
				`${JSON.stringify({ discovered: result.candidates.length, ...persisted }, null, 2)}\n`,
				resolve,
			));
			await storage.close();
			process.exit();
		}
		await new Promise((resolve) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, resolve));
	} catch (error) {
		await new Promise((resolve) => process.stderr.write(`${error.message}\n`, resolve));
		process.exitCode = 1;
	}
	process.exit();
}

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
			"usage: sources.mjs <status|list|sync|purge|prune|resume|discover> [source] [operator|topic]\n" +
			"  discover <source> <topic> [--persist <operator>] [--subject brand:名称|competitor:名称]\n" +
			"  discover xiaohongshu <查询词> [--persist <operator>] [--subject brand:名称]",
		);
		process.exit(2);
	}
} finally {
	await storage.close();
}
