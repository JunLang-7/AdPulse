import * as crypto from "node:crypto";
import type { Storage } from "./ports/storage.js";
import type {
	SourceItem,
	SourceRun,
	SourceSnapshot,
	SourceState,
} from "./state/model.js";
import {
	SOURCE_DEFINITIONS,
	contentHash,
	isWithinItemBounds,
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
/** Operators may re-run early, but not faster than this. */
export const MIN_MANUAL_INTERVAL_MS = 15 * 60 * 1000;
const SNAPSHOT_RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 24 * 3_600_000;
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

/** Retention only needs to run once a day. */
export function isPruneDue(lastPrunedAt: string | null, now: string): boolean {
	if (!lastPrunedAt) return true;
	const elapsed = Date.parse(now) - Date.parse(lastPrunedAt);
	if (!Number.isFinite(elapsed)) return true;
	return elapsed >= PRUNE_INTERVAL_MS;
}

function stopped(
	sourceKey: string,
	run: SourceRun,
	previous: SourceState | null,
): SourceState {
	return {
		id: sourceKey,
		sourceKey,
		status: "stopped",
		stoppedAt: run.finishedAt,
		stoppedReason: run.errorReason,
		resumedAt: null,
		resumedBy: null,
		lastPrunedAt: previous?.lastPrunedAt ?? null,
	};
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
	async sync(
		sourceKey: string,
		now: string,
		options: { trigger?: "schedule" | "manual" } = {},
	): Promise<SourceSyncResult> {
		if (!this.options.enabled) throw new SourceDisabledError();
		const source = SOURCE_DEFINITIONS[sourceKey];
		if (!source) throw new UnknownSourceError(sourceKey);
		const lock = await this.storage.runExclusive(`source:${sourceKey}`, () =>
			this.attempt(source, now, options.trigger ?? "schedule"),
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
		trigger: "schedule" | "manual",
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
			await this.storage.transaction(async (tx) => {
				await tx.sourceRuns.put(run);
				if (run.outcome === "stopped")
					await tx.sourceStates.put(
						stopped(source.key, run, await tx.sourceStates.get(source.key)),
					);
			});
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
			const control = await tx.sourceStates.get(source.key);
			return {
				runsToday,
				cachedRobots,
				items,
				control,
				lastStartedAt: runs[0]?.startedAt ?? null,
			};
		});

		// One robots.txt fetch per day plus list runs must stay within the limit.
		const listRunBudget = source.dailyRequestLimit - 1;
		// A stopped source never retries on its own: only resume() clears this.
		if (state.control?.status === "stopped")
			return {
				runId: "",
				acquired: true,
				outcome: "stopped",
				created: 0,
				updated: 0,
				skippedPurged: 0,
				reason: state.control.stoppedReason ?? "source stopped",
			};

		if (trigger === "manual" && state.lastStartedAt) {
			const elapsed = Date.parse(now) - Date.parse(state.lastStartedAt);
			if (Number.isFinite(elapsed) && elapsed < MIN_MANUAL_INTERVAL_MS)
				return {
					runId: "",
					acquired: true,
					outcome: "skipped",
					created: 0,
					updated: 0,
					skippedPurged: 0,
					reason: "manual trigger throttled to one run per 15 minutes",
				};
		}
		if (state.runsToday >= listRunBudget)
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
		if (page.status >= 300 && page.status < 400)
			return record({
				...base,
				robotsState,
				httpStatus: page.status,
				bytes: page.bytes,
				outcome: "http_error",
				errorReason: `unexpected redirect ${page.status}`,
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
				await tx.sourceSnapshots.delete(snapshot.id);
			}
			return purged;
		});
	}

	/** Clears a stop. Contents stay purged until a new run re-ingests them. */
	async resume(
		sourceKey: string,
		now: string,
		operator: string,
	): Promise<SourceState> {
		if (!SOURCE_DEFINITIONS[sourceKey]) throw new UnknownSourceError(sourceKey);
		return this.storage.transaction(async (tx) => {
			const previous = await tx.sourceStates.get(sourceKey);
			const next: SourceState = {
				id: sourceKey,
				sourceKey,
				status: "active",
				stoppedAt: null,
				stoppedReason: null,
				resumedAt: now,
				resumedBy: operator,
				lastPrunedAt: previous?.lastPrunedAt ?? null,
			};
			await tx.sourceStates.put(next);
			return next;
		});
	}

	/** Snapshot rows expire after the retention window. */
	async pruneSnapshots(
		sourceKey: string,
		now: string,
		retentionDays: number = SNAPSHOT_RETENTION_DAYS,
	): Promise<number> {
		const cutoff = Date.parse(now) - retentionDays * 86_400_000;
		return this.storage.transaction(async (tx) => {
			let removed = 0;
			for (const snapshot of await tx.sourceSnapshots.all()) {
				if (snapshot.sourceKey !== sourceKey) continue;
				if (Date.parse(snapshot.createdAt) >= cutoff) continue;
				await tx.sourceSnapshots.delete(snapshot.id);
				removed += 1;
			}
			return removed;
		});
	}

	/** Newest run for scheduler catch-up checks. */
	async lastRun(sourceKey: string): Promise<SourceRun | null> {
		return this.storage.transaction(async (tx) => {
			const runs = (await tx.sourceRuns.all())
				.filter((run) => run.sourceKey === sourceKey)
				.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
			return runs[0] ?? null;
		});
	}

	/**
	 * Retention runs at most once per day per source, driven by the scheduler.
	 * Uses the same 30-day window as the manual command.
	 */
	async pruneIfDue(
		sourceKey: string,
		now: string,
		retentionDays: number = SNAPSHOT_RETENTION_DAYS,
	): Promise<number> {
		if (!SOURCE_DEFINITIONS[sourceKey]) throw new UnknownSourceError(sourceKey);
		const state = await this.storage.transaction(async (tx) =>
			tx.sourceStates.get(sourceKey),
		);
		if (!isPruneDue(state?.lastPrunedAt ?? null, now)) return 0;
		const removed = await this.pruneSnapshots(sourceKey, now, retentionDays);
		await this.storage.transaction(async (tx) => {
			const current = await tx.sourceStates.get(sourceKey);
			await tx.sourceStates.put({
				id: sourceKey,
				sourceKey,
				status: current?.status ?? "active",
				stoppedAt: current?.stoppedAt ?? null,
				stoppedReason: current?.stoppedReason ?? null,
				resumedAt: current?.resumedAt ?? null,
				resumedBy: current?.resumedBy ?? null,
				lastPrunedAt: now,
			});
		});
		return removed;
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
