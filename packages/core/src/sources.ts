import { createHash } from "node:crypto";

export type ContentScope = "title_link_only";
export type SourceItemStatus = "active" | "purged";
export type FetchOutcome =
	| "ok"
	| "parse_failed"
	| "http_error"
	| "blocked"
	| "stopped";
export type RobotsState = "allow" | "absent" | "disallow" | "blocked";

/** A source must be described explicitly: no crawling by domain discovery. */
export interface SourceDefinition {
	key: string;
	label: string;
	listUrl: string;
	allowedHosts: string[];
	/** Only article-like paths become items; navigation anchors are ignored. */
	pathPattern: RegExp;
	minItems: number;
	maxItems: number;
	dailyRequestLimit: number;
	configVersion: string;
}

export interface ParsedItem {
	itemKey: string;
	title: string;
	itemUrl: string;
	publishedAt: string | null;
}

/**
 * Two sites only. Expanding this list is a scope change that requires a new
 * Gate 0 sign-off; see issue #41.
 */
export const SOURCE_DEFINITIONS: Record<string, SourceDefinition> = {
	weichai_news: {
		key: "weichai_news",
		label: "潍柴新闻与事件",
		listUrl:
			"https://www.weichai.com/group/weichai/cn/media-hub/news2/index.html",
		allowedHosts: ["www.weichai.com"],
		pathPattern: /^\/group\/weichai\/cn\/media-hub\/news2\/[a-z-]+\/\d{14,}\/index\.html$/,
		minItems: 3,
		maxItems: 60,
		dailyRequestLimit: 6,
		configVersion: "2026-11-07.1",
	},
	haier_news: {
		key: "haier_news",
		label: "海尔品牌资讯",
		listUrl: "https://www.haier.com/about_haier/xinwen/",
		allowedHosts: ["www.haier.com"],
		pathPattern: /^\/about_haier\/xinwen\/\d{8}_\d+\.shtml$/,
		minItems: 3,
		maxItems: 60,
		dailyRequestLimit: 6,
		configVersion: "2026-11-07.1",
	},
};

/** Markers that must never be treated as article titles. */
const NON_TITLE_MARKERS = /内容由\s*AI\s*智能生成|AI\s*导读|人工智能生成/i;
const MAX_TITLE_LENGTH = 200;

/**
 * Canonical item identity. The whole query string is dropped: neither source
 * uses meaningful query parameters and the review asked for a stable key.
 */
export function normalizeItemUrl(
	raw: string,
	base: string,
	allowedHosts: string[],
): string | null {
	let url: URL;
	try {
		url = new URL(raw, base);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (!allowedHosts.includes(url.hostname.toLowerCase())) return null;
	url.protocol = "https:";
	url.search = "";
	url.hash = "";
	url.username = "";
	url.password = "";
	if (url.pathname.length > 1 && url.pathname.endsWith("/"))
		url.pathname = url.pathname.slice(0, -1);
	return url.toString();
}

function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;/g, "'")
		.replace(/&amp;/gi, "&");
}

function anchorText(inner: string): string {
	return decodeEntities(inner.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

/** `YYYY-MM-DD` shown by the list, anchored to Asia/Shanghai midnight. */
function parseListDate(window: string, now: string): string | null {
	const match = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(window);
	if (!match) return null;
	const [, year, month, day] = match;
	if (!year || !month || !day) return null;
	const iso = `${year}-${month}-${day}T00:00:00+08:00`;
	const parsed = Date.parse(iso);
	if (Number.isNaN(parsed)) return null;
	// A future date is a source defect, not a fact; keep it unknown.
	if (parsed > Date.parse(now)) return null;
	return new Date(parsed).toISOString();
}

const ANCHOR = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Best-effort structural parse. Anything unexpected yields fewer items, which
 * the service treats as a failed run: it never invents entries.
 */
export function parseListPage(
	source: SourceDefinition,
	html: string,
	now: string,
): ParsedItem[] {
	const items = new Map<string, ParsedItem>();
	for (const match of html.matchAll(ANCHOR)) {
		const href = match[1];
		const inner = match[2];
		if (!href || inner === undefined) continue;
		const itemUrl = normalizeItemUrl(href, source.listUrl, source.allowedHosts);
		if (!itemUrl) continue;
		const path = new URL(itemUrl).pathname;
		if (!source.pathPattern.test(path)) continue;
		const text = anchorText(inner);
		// Image-only anchors and AI-generated summaries are not titles.
		if (text.length < 4 || NON_TITLE_MARKERS.test(text)) continue;
		if (items.has(itemUrl)) continue;
		const start = match.index + match[0].length;
		const publishedAt = parseListDate(
			html.slice(start, start + 600),
			now,
		);
		items.set(itemUrl, {
			itemKey: itemUrl,
			itemUrl,
			title: text.slice(0, MAX_TITLE_LENGTH),
			publishedAt,
		});
	}
	return [...items.values()];
}

/** Snapshot identity only: titles are not persisted outside source items. */
export function contentHash(item: ParsedItem): string {
	return createHash("sha256")
		.update(`${item.title}\u0000${item.publishedAt ?? ""}`)
		.digest("hex");
}

export function isWithinItemBounds(
	source: SourceDefinition,
	count: number,
): boolean {
	return count >= source.minItems && count <= source.maxItems;
}
