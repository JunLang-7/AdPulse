// 用户自加站点的兜底采集：同域 JSON 列表 → sitemap → 搜索。
// 只取「标题 + 链接」，不读正文；每级都有请求上限，找不到就返回空，由调用方如实失败。
import { MAX_ITEMS, articleScore, isListableItem, isListableTitle, looksNewsy } from "./item-quality.js";
import type { SourceFetcher } from "./source-service.js";
import { normalizeItemUrl } from "./sources.js";

export interface FallbackItem {
	itemKey: string;
	title: string;
	itemUrl: string;
	/** 列表页/索引自带的时间（只接受真实日期），没有就交给 extractDate 从 URL/标题取。 */
	publishedAt?: string | null;
}

const JSON_TITLE_KEYS = ["title", "name", "headline"] as const;
const JSON_URL_KEYS = ["path", "url", "link", "href"] as const;
const JSON_DATE_KEYS = ["published", "publishedAt", "published_at", "date", "lastmod", "time"] as const;
const JSON_CONTAINER_KEYS = ["data", "list", "items", "results", "news", "articles", "records", "rows"] as const;
const MAX_JSON_SCAN = 200;
const MAX_SITEMAP_TITLE_FETCHES = 6;
const FETCH_LIMITS = { maxBytes: 512 * 1024, timeoutMs: 15_000 };

const DAY = /(\d{4})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})/u;

function isoDate(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const match = DAY.exec(value);
	if (!match) return null;
	const iso = `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
	return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

/**
 * 同域 JSON 列表（实测：海信 newsroom.json 是 {columns, data:[{path,title,published,…}]}）。
 * 只按白名单字段取值：容器数组 → title/name/headline + path/url/link/href；不猜结构。
 */
export function parseJsonListPayload(body: string, baseUrl: string, host: string): FallbackItem[] {
	const trimmed = body.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [];
	let payload: unknown;
	try {
		payload = JSON.parse(trimmed);
	} catch {
		return [];
	}
	const arrays: unknown[][] = [];
	const visit = (value: unknown, depth: number): void => {
		if (depth > 3 || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			if (value.length > 0) arrays.push(value);
			return;
		}
		const record = value as Record<string, unknown>;
		for (const key of JSON_CONTAINER_KEYS) if (key in record) visit(record[key], depth + 1);
	};
	visit(payload, 0);
	if (Array.isArray(payload)) arrays.push(payload);

	for (const array of arrays) {
		const items: FallbackItem[] = [];
		const seen = new Set<string>();
		for (const raw of array.slice(0, MAX_JSON_SCAN)) {
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
			const record = raw as Record<string, unknown>;
			const title = firstString(record, JSON_TITLE_KEYS);
			const rawUrl = firstString(record, JSON_URL_KEYS);
			if (!title || !rawUrl) continue;
			const itemUrl = normalizeItemUrl(rawUrl, baseUrl, [host]);
			if (!itemUrl || seen.has(itemUrl)) continue;
			if (!isListableTitle(title)) continue;
			seen.add(itemUrl);
			items.push({ itemKey: itemUrl, title, itemUrl, publishedAt: isoDate(firstString(record, JSON_DATE_KEYS)) });
			if (items.length >= MAX_ITEMS) break;
		}
		if (items.length > 0) return items;
	}
	return [];
}

/** 从 robots.txt 的 `Sitemap:` 指令里取站点地图地址（同域）。 */
export function sitemapUrlsFromRobots(robots: string, origin: string): string[] {
	const found: string[] = [];
	for (const line of robots.split(/\r?\n/u)) {
		const match = /^\s*sitemap\s*:\s*(\S+)\s*$/iu.exec(line);
		if (!match?.[1]) continue;
		try {
			const url = new URL(match[1]);
			if (`${url.protocol}//${url.host}` === origin) found.push(url.toString());
		} catch {
			// 非法地址直接跳过
		}
	}
	return found;
}

export interface SitemapEntry {
	url: string;
	lastmod: string | null;
	title: string | null;
}

/**
 * 解析 sitemap / sitemapindex。只保留同域、且有文章信号的 URL（无标题时也只能靠地址判断）。
 * `news:title` 一类标题字段存在时直接采用，避免再抓文章页。
 */
export function parseSitemapXml(
	xml: string,
	baseUrl: string,
	host: string,
): { sitemaps: string[]; entries: SitemapEntry[] } {
	const sitemaps: string[] = [];
	const rawEntries: Array<{ url: string; lastmod: string | null; title: string | null }> = [];
	for (const block of xml.match(/<(?:url|sitemap)\b[\s\S]*?<\/(?:url|sitemap)>/giu) ?? []) {
		const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/iu.exec(block)?.[1];
		if (!loc) continue;
		const target = normalizeItemUrl(loc, baseUrl, [host]);
		if (!target) continue;
		const lastmod = isoDate(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/iu.exec(block)?.[1] ?? null);
		const titleTag = /<news:title>\s*([^<]{1,300})\s*<\/news:title>/iu.exec(block)?.[1] ?? null;
		if (/<\/sitemap>/iu.test(block) && /<sitemapindex/iu.test(xml)) {
			sitemaps.push(target);
			continue;
		}
		rawEntries.push({ url: target, lastmod, title: titleTag });
	}
	const entries = rawEntries
		.filter((entry) => articleScore(entry.url, entry.title ?? "") >= 2 && looksNewsy(entry.url, entry.title ?? ""))
		.sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? "") || articleScore(b.url, "") - articleScore(a.url, ""))
		.slice(0, MAX_ITEMS);
	return { sitemaps, entries };
}

function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;/giu, " ")
		.replace(/&amp;/giu, "&")
		.replace(/&quot;/giu, "\"")
		.replace(/&#39;|&apos;/giu, "'")
		.replace(/&lt;/giu, "<")
		.replace(/&gt;/giu, ">")
		.replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** 文章页 <title>：标题缺失时用来补齐（每篇 1 个请求，有上限）。 */
function pageTitle(body: string): string | null {
	const raw = /<title[^>]*>([\s\S]{1,300}?)<\/title>/iu.exec(body)?.[1];
	if (!raw) return null;
	const title = decodeEntities(raw.replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim();
	return isListableTitle(title) ? title : null;
}

/**
 * sitemap 兜底：先按 lastmod 排序，索引自带标题就直接用；
 * 否则最多抓 6 篇文章页取 <title>，拿不到就跳过（不编造标题）。
 */
export async function collectSitemapItems(
	fetcher: SourceFetcher,
	host: string,
	entries: SitemapEntry[],
	limits: { maxTitleFetches?: number } = {},
): Promise<FallbackItem[]> {
	const maxFetches = limits.maxTitleFetches ?? MAX_SITEMAP_TITLE_FETCHES;
	const items: FallbackItem[] = [];
	let fetches = 0;
	for (const entry of entries) {
		let title = entry.title;
		if (!title && fetches < maxFetches) {
			fetches += 1;
			try {
				const page = await fetcher.fetchText(entry.url, FETCH_LIMITS);
				if (page.status < 400) title = pageTitle(page.body);
			} catch {
				title = null;
			}
		}
		if (!title || !isListableTitle(title)) continue;
		items.push({ itemKey: entry.url, title, itemUrl: entry.url, publishedAt: entry.lastmod });
		if (items.length >= MAX_ITEMS) break;
	}
	return items;
}

/** 搜索回退：标题+链接直接来自搜索结果，只保留同域命中。 */
export function searchFallbackItems(hits: Array<{ title: string; url: string }>, host: string): FallbackItem[] {
	const items: FallbackItem[] = [];
	const seen = new Set<string>();
	for (const hit of hits) {
		let url: URL;
		try {
			url = new URL(hit.url);
		} catch {
			continue;
		}
		if (url.host.toLowerCase() !== host.toLowerCase()) continue;
		const itemUrl = normalizeItemUrl(hit.url, hit.url, [host]);
		if (!itemUrl || seen.has(itemUrl)) continue;
		const title = decodeEntities(hit.title).replace(/\s+/gu, " ").trim();
		// 搜索结果里常混着首页/关于页：只收文章型地址，不然会把站点首页当线索存下来。
		if (!isListableItem(title, itemUrl)) continue;
		seen.add(itemUrl);
		items.push({ itemKey: itemUrl, title, itemUrl, publishedAt: null });
		if (items.length >= MAX_ITEMS) break;
	}
	return items;
}

const NEWSISH = /news|press|media|xinwen|资讯|新闻|动态|公告|报道/iu;
const DATA_URL = /\.(?:json|xml|rss)(?:$|[?#])/iu;

/**
 * 有些站点把新闻放在数据接口里，页面上只留一个链接（实测海信 `/cn/zh/newsroom.json`）。
 * 只认「新闻词 + 数据后缀」的锚点，避免把任意接口当地址去抓。
 */
export function findDataListAnchor(html: string, baseUrl: string, host: string): string | null {
	const anchor = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/giu;
	let match: RegExpExecArray | null;
	while ((match = anchor.exec(html))) {
		const href = match[2] ?? match[3] ?? match[4] ?? "";
		const text = (match[5] ?? "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
		if (!DATA_URL.test(href)) continue;
		if (!NEWSISH.test(href) && !NEWSISH.test(text)) continue;
		const target = normalizeItemUrl(href, baseUrl, [host]);
		if (target) return target;
	}
	return null;
}
