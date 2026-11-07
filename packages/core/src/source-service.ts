import * as crypto from "node:crypto";
import type { Storage, Transaction } from "./ports/storage.js";
import type { SourceItem, SourceRun, SourceSnapshot } from "./state/model.js";
import {
	SOURCE_DEFINITIONS,
	contentHash,
	isWithinItemBounds,
	normalizeItemUrl,
	parseListPage,
	type FetchOutcome,
	type RobotsState,
	type SourceDefinition,
} from "./sources.js";

export interface FetchedResource {
	status: number;
	bytes: number;
	body: string;
}

export type SourceFetchFailure = "blocked" | "too_large" | "redirect" | "network";

/** Transport failures only; HTTP status codes are returned, not thrown. */
export class SourceFetchError extends Error {
	constructor(
		readonly kind: SourceFetchFailure,
		message: string,
	) {
		super(message);
	}
}

export interface SourceFetcher {
	fetchText(
		url: string,
		limits: { maxBytes: number; timeoutMs: number },
	): Promise<FetchedResource>;
}

export class SourceDisabledError extends Error {
	constructor() {
		super("source collection is disabled (Gate 0 not signed off)");
	}
}

export class UnknownSourceError extends Error {
	constructor(key: string) {
		super(`unknown source ${key}`);
	}
}

export const FETCH_LIMITS = { maxBytes: 1_048_576, timeoutMs: 20_000 };
const MAX_CRAWL_DELAY_MS = 20_000;

export interface SourceSyncResult {
	runId: string;
	acquired: boolean;
	outcome: FetchOutcome | "skipped";
	created: number;
	updated: number;
	skippedPurged: number;
	reason: string | null;
}

/** Calendar day in Asia/Shanghai, used for quota accounting. */
export function shanghaiDay(iso: string): string {
	const parsed = Date.parse(iso);
	if (Number.isNaN(parsed)) return "";
	return new Date(parsed + 8 * 3_600_000).toISOString().slice(0, 10);
}

interface RobotsRules {
	disallow: string[];
	allow: string[];
	crawlDelayMs: number | null;
}

/** Minimal RFC 9309 subset: groups declared for `User-agent: *`. */
export function parseRobots(text: string): RobotsRules {
	const rules: RobotsRules = { disallow: [], allow: [], crawlDelayMs: null };
	let inStar = false;
	let dedicated = false;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.split("#")[0]?.trim() ?? "";
		if (!line) continue;
		const index = line.indexOf(":");
		if (index < 0) continue;
		const field = line.slice(0, index).trim().toLowerCase();
		const value = line.slice(index + 1).trim();
		if (field === "user-agent") {
			inStar = value === "*";
			dedicated = !inStar;
			continue;
		}
		if (dedicated || !inStar) continue;
		if (field === "disallow" && value) rules.disallow.push(value);
		if (field === "allow" && value) rules.allow.push(value);
		if (field === "crawl-delay") {
			const seconds = Number(value);
			if (Number.isFinite(seconds) && seconds >= 0)
				rules.crawlDelayMs = Math.min(seconds * 1000, MAX_CRAWL_DELAY_MS);
		}
	}
	return rules;
}

/** Longest match wins; `Allow` wins ties, per RFC 9309. */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
	let best = -1;
	let allowed = true;
	for (const pattern of rules.disallow) {
		if (!path.startsWith(pattern)) continue;
		if (pattern.length > best) {
			best = pattern.length;
			allowed = false;
		}
	}
	for (const pattern of rules.allow) {
		if (!path.startsWith(pattern)) continue;
		if (pattern.length >= best) {
			best = pattern.length;
			allowed = true;
		}
	}
	return allowed;
}

function robotsUrlFor(source: SourceDefinition): string {
	const url = new URL(source.listUrl);
	url.pathname = "/robots.txt";
	url.search = "";
	url.hash = "";
	return url.toString();
}

export class SourceService {
	constructor(
		private storage: Storage,
		private fetcher: SourceFetcher,
		private options: { enabled: boolean },
	) {}

	/**
	 * One polling attempt. Network I/O happens outside any transaction, and a
	 * failed run never mutates existing items.
	 */
	async sync(sourceKey: string, now: string): Promise<SourceSyncResult> {
		if (!this.options.enabled) throw new SourceDisabledError();
		const source = SOURCE_DEFINITIONS[sourceKey];
		if (!source) throw new UnknownSourceError(sourceKey);
		const lock = await this.storage.runExclusive(`source:${sourceKey}`, () =>
			this.attempt(source, now),
		);
		if (!lock.acquired || !lock.value)
			return {
				runId: "",
				acquired: false,
				outcome: "skipped",
				created: 0,
				updated: 0,
				skippedPurged: 0,
				reason: "another worker holds the source lock",
			};
		return lock.value;
	}

	private async attempt(
		source: SourceDefinition,
		now: string,
	): Promise<SourceSyncResult> {
		const runId = crypto.randomUUID();
		const base = {
			startedAt: now,
			finishedAt: now,
			httpStatus: null as number | null,
			bytes: 0,
			itemCount: 0,
			snapshotComplete: false,
			errorReason: null as string | null,
		};

		const record = async (
			partial: Omit<SourceRun, "id" | "sourceKey" | "configVersion">,
			counts: { created?: number; updated?: number; skippedPurged?: number } = {},
		): Promise<SourceSyncResult> => {
			const run: SourceRun = {
				id: runId,
				sourceKey: source.key,
				configVersion: source.configVersion,
				...partial,
			};
			await this.storage.transaction((tx) => tx.sourceRuns.put(run));
			return {
				runId,
				acquired: true,
				outcome: run.outcome,
				created: counts.created ?? 0,
				updated: counts.updated ?? 0,
				skippedPurged: counts.skippedPurged ?? 0,
				reason: run.errorReason,
			};
		};

		const state = await this.storage.transaction(async (tx) => {
			const today = shanghaiDay(now);
			const runs = (await tx.sourceRuns.all())
				.filter((run) => run.sourceKey === source.key)
				.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
			const runsToday = runs.filter(
				(run) => shanghaiDay(run.startedAt) === today,
			).length;
			const cachedRobots =
				runs.find(
					(run) =>
						shanghaiDay(run.startedAt) === today &&
						(run.robotsState === "allow" || run.robotsState === "absent"),
				)?.robotsState ?? null;
			const items = (await tx.sourceItems.all()).filter(
				(item) => item.sourceKey === source.key,
			);
			return { runsToday, cachedRobots, items };
		});

		if (state.runsToday >= source.dailyRequestLimit)
			return record({
				...base,
				robotsState: "allow",
				outcome: "blocked",
				errorReason: "daily request quota exhausted",
			});

		let robotsState: RobotsState = state.cachedRobots ?? "absent";
		if (!state.cachedRobots) {
			try {
				const robots = await this.fetcher.fetchText(
					robotsUrlFor(source),
					FETCH_LIMITS,
				);
				if (robots.status >= 500) robotsState = "blocked";
				else if (robots.status >= 400) robotsState = "absent";
				else {
					const rules = parseRobots(robots.body);
					const path = new URL(source.listUrl).pathname;
					robotsState = robotsAllows(rules, path) ? "allow" : "disallow";
				}
			} catch {
				robotsState = "blocked";
			}
		}
		if (robotsState === "blocked")
			return record({
				...base,
				robotsState,
				outcome: "stopped",
				errorReason: "robots.txt unreachable or failing; conservative stop",
			});
		if (robotsState === "disallow")
			return record({
				...base,
				robotsState,
				outcome: "stopped",
				errorReason: "robots.txt disallows the list page",
			});

		let page: FetchedResource;
		try {
			page = await this.fetcher.fetchText(source.listUrl, FETCH_LIMITS);
		} catch (error) {
			const kind = error instanceof SourceFetchError ? error.kind : "network";
			return record({
				...base,
				robotsState,
				outcome: kind === "blocked" ? "stopped" : "http_error",
				errorReason: `${kind}: ${
					error instanceof Error ? error.message : "fetch failed"
				}`,
			});
		}

		if (page.status === 403 || page.status === 429)
			return record({
				...base,
				robotsState,
				httpStatus: page.status,
				bytes: page.bytes,
				outcome: "stopped",
				errorReason: `HTTP ${page.status}; manual review required`,
			});
		if (page.status < 200 || page.status >= 400)
			return record({
				...base,
				robotsState,
				httpStatus: page.status,
				bytes: page.bytes,
				outcome: "http_error",
				errorReason: `HTTP ${page.status}`,
			});

		const parsed = parseListPage(source, page.body, now);
		if (!isWithinItemBounds(source, parsed.length))
			return record({
				...base,
				robotsState,
				httpStatus: page.status,
				bytes: page.bytes,
				itemCount: parsed.length,
				outcome: "parse_failed",
				errorReason: `item count ${parsed.length} outside ${source.minItems}-${source.maxItems}`,
			});

		const existing = new Map(state.items.map((item) => [item.itemKey, item]));
		let created = 0;
		let updated = 0;
		let skippedPurged = 0;

		await this.storage.transaction(async (tx) => {
			await tx.sourceRuns.put({
				id: runId,
				sourceKey: source.key,
				configVersion: source.configVersion,
				...base,
				robotsState,
				httpStatus: page.status,
				bytes: page.bytes,
				itemCount: parsed.length,
				outcome: "ok",
				snapshotComplete: true,
			});
			for (const item of parsed) {
				await tx.sourceSnapshots.put({
					id: `${runId}:${item.itemKey}`,
					runId,
					sourceKey: source.key,
					itemKey: item.itemKey,
					contentHash: contentHash(item),
					createdAt: now,
				});
				const previous = existing.get(item.itemKey);
				// A purged identity is never re-ingested, even if the site re-lists it.
				if (previous?.status === "purged") {
					skippedPurged += 1;
					continue;
				}
				const next: SourceItem = previous
					? {
							...previous,
							title: item.title,
							itemUrl: item.itemUrl,
							publishedAt: item.publishedAt,
							lastSeenAt: now,
							titleUpdatedAt:
								previous.title === item.title ? previous.titleUpdatedAt : now,
						}
					: {
							id: `${source.key}:${item.itemKey}`,
							sourceKey: source.key,
							itemKey: item.itemKey,
							title: item.title,
							itemUrl: item.itemUrl,
							publishedAt: item.publishedAt,
							firstSeenAt: now,
							lastSeenAt: now,
							titleUpdatedAt: null,
							contentScope: "title_link_only",
							status: "active",
						};
				if (previous) updated += 1;
				else created += 1;
				await tx.sourceItems.put(next);
			}
		});

		return {
			runId,
			acquired: true,
			outcome: "ok",
			created,
			updated,
			skippedPurged,
			reason: null,
		};
	}

	/** Removes content for one source and keeps the identity so it cannot return. */
	async purge(sourceKey: string, now: string): Promise<number> {
		const source = SOURCE_DEFINITIONS[sourceKey];
		if (!source) throw new UnknownSourceError(sourceKey);
		return this.storage.transaction(async (tx) => {
			let purged = 0;
			for (const item of await tx.sourceItems.all()) {
				if (item.sourceKey !== sourceKey || item.status === "purged") continue;
				await tx.sourceItems.put({
					...item,
					title: "",
					publishedAt: null,
					titleUpdatedAt: null,
					lastSeenAt: now,
					status: "purged",
				});
				purged += 1;
			}
			for (const snapshot of await tx.sourceSnapshots.all()) {
				if (snapshot.sourceKey !== sourceKey) continue;
				await tx.sourceSnapshots.put({ ...snapshot, contentHash: "" });
			}
			return purged;
		});
	}

	async listItems(sourceKey: string): Promise<SourceItem[]> {
		return this.storage.transaction(async (tx) =>
			(await tx.sourceItems.all()).filter(
				(item) => item.sourceKey === sourceKey,
			),
		);
	}

	/** Purged rows never surface, even if a later run still lists them. */
	static visible(items: SourceItem[]): SourceItem[] {
		return items
			.filter((item) => item.status === "active")
			.sort((left, right) =>
				(right.publishedAt ?? right.firstSeenAt).localeCompare(
					left.publishedAt ?? left.firstSeenAt,
				),
			);
	}
}

export function assertAllowedItemUrl(
	source: SourceDefinition,
	url: string,
): string | null {
	return normalizeItemUrl(url, source.listUrl, source.allowedHosts);
}

export type { Transaction };
