// 企业名称 → 官网新闻列表页自动发现。
// 用 agent-reach（Exa 搜索）找候选官网，再在候选站内定位新闻列表页；
// 找不到就如实报错，不猜测、不编造地址。发现结果只用于登记，不自动采正文。
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { normalizeItemUrl } from "@adpluse/core";
import type { SourceFetcher } from "@adpluse/core";
import { UserSiteFetcher } from "./source-fetch.js";
const HttpSourceFetcher = UserSiteFetcher;

const LIMIT = 8;

/**
 * 用 agent-reach web read（jina 可渲染 JS 页面）读列表页，从返回文本里抽站内链接+标题。
 * 用于静态抓不到的 JS 渲染列表；限流时如实上报等待秒数。
 */
export class AgentReachLimitError extends Error {
	constructor(public readonly retryAfterSeconds: number | null) {
		super(retryAfterSeconds ? `agent-reach rate limited; retry after ${retryAfterSeconds}s` : "agent-reach rate limited");
}
}

export async function readViaAgentReach(
	url: string,
	executable: string | undefined,
): Promise<string> {
	if (!executable || !isAbsolute(executable))
		throw new Error("set AGENT_REACH_BIN to the absolute path of the pinned Agent-Reach executable");
	const profile = await mkdtemp(resolve(tmpdir(), "adpulse-read-"));
	try {
		const { stdout } = await runReach(executable, ["web", "read", url, "--timeout", "25"]);
		const parsedResult: unknown = JSON.parse(stdout);
		const payload = isRecord(parsedResult) ? parsedResult : null;
		const errorPayload = payload && isRecord(payload.error) ? payload.error : null;
		const code = errorPayload && typeof errorPayload.code === "string" ? errorPayload.code : "";
		if (!payload || payload.ok !== true) {
			if (code === "RATE_LIMITED") {
				const hint = errorPayload && typeof errorPayload.hint === "string" ? errorPayload.hint : "";
				const wait = /wait (\d+) seconds/iu.exec(hint)?.[1];
				throw new AgentReachLimitError(wait ? Number(wait) : null);
			}
			throw new Error(`agent-reach read failed (${code || "UPSTREAM_FAILED"})`);
		}
		const text = typeof payload.text === "string"
			? payload.text
			: isRecord(payload.data) && typeof payload.data.text === "string"
				? payload.data.text
				: "";
		if (!text) throw new Error("agent-reach read returned no text");
		return text;
	} finally {
		await rm(profile, { recursive: true, force: true });
	}
}

/** 从 jina 返回的 markdown 里抽 `[标题](链接)`；只保留能归一化的站内链接。 */
export function parseMarkdownLinks(
	markdown: string,
	base: string,
	allowedHost: string,
): Array<{ itemKey: string; title: string; itemUrl: string }> {
	const results = new Map<string, { itemKey: string; title: string; itemUrl: string }>();
	for (const match of markdown.matchAll(/\[([^\]\n]{6,200})\]\((https?:\/\/[^\s)]+)\)/gu)) {
		const title = match[1]?.replace(/\s+/gu, " ").trim() ?? "";
		const raw = match[2] ?? "";
		if (title.length < 6 || title.length > 200) continue;
		const target = normalizeItemUrl(raw, base, [allowedHost]);
		if (!target || target === base) continue;
		if (!results.has(target)) results.set(target, { itemKey: target, title, itemUrl: target });
		if (results.size >= 20) break;
	}
	return [...results.values()];
}

/** 组合好的渲染读取兑底：给 UserSourceService.refresh 用。 */
export function agentReachReadFallback(executable: string | undefined) {
	return async (url: string) => {
		const text = await readViaAgentReach(url, executable);
		return parseMarkdownLinks(text, url, new URL(url).host);
	};
}
/** 媒体聚合/门户/百科等不可能是企业官网，直接排除。 */
const NON_OFFICIAL_HOSTS =
	/baidu\.com|zhihu\.com|qq\.com|163\.com|126\.net|sohu\.com|sina\.com|douyin\.com|toutiao\.com|xinhuanet\.com|people\.com\.cn|wikipedia\.org|gov\.cn|tianyancha\.com|qcc\.com|maigoo\.com|csdn\.net|jianshu\.com|juejin\.cn|cnblogs\.com|36kr\.com|netease\.com|ifeng\.com|thepaper\.cn|cntv\.cn|chinanews\.com|ce\.cn|cctv\.com|baike\./i;
const NEWS_TOKEN = /news|xinwen|xwzx|xwtt|新闻|动态|资讯|信息|media|press/i;

export interface CompanySite {
	host: string;
	listUrl: string;
	/** 搜索命中的原始 URL（已脱敏用途说明，仅日志用）。 */
	via: string;
}

type RunReach = (executable: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;

const runReach: RunReach = (executable, args) =>
	new Promise((done, reject) => {
		execFile(executable, args, { timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
			const exitCode = error?.code ?? 0;
			if (typeof exitCode === "number" && !error?.signal) done({ stdout, exitCode });
			else reject(new Error(error?.killed ? "discovery timeout" : "discovery process failed"));
		});
	});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 在官网站内找新闻列表页：锚文本/href 含新闻词即用；找不到就用命中的原始页面。 */
export async function resolveNewsListPage(
	candidate: { host: string; listUrl: string },
	fetcher: SourceFetcher,
): Promise<string> {
	if (NEWS_TOKEN.test(new URL(candidate.listUrl).pathname)) return candidate.listUrl;
	try {
		const page = await fetcher.fetchText(candidate.listUrl, { maxBytes: 512 * 1024, timeoutMs: 15_000 });
		if (page.status < 400) {
			const anchor = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/giu;
			let match: RegExpExecArray | null;
			while ((match = anchor.exec(page.body))) {
				const href = match[2] ?? match[3] ?? match[4] ?? "";
				const text = (match[5] ?? "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
				const target = normalizeItemUrl(href, candidate.listUrl, [candidate.host]);
				if (!target) continue;
				const path = new URL(target).pathname;
				if (NEWS_TOKEN.test(path) || NEWS_TOKEN.test(text))
					return target;
			}
		}
	} catch {
		// 站内探测失败不阻塞登记：退回搜索命中的原始页面。
	}
	return candidate.listUrl;
}

/**
 * Exa 限流或失败时的兑底：Bing 的 RSS 输出（format=rss）。
 * 结构稳定无广告；查询按变体轮询直到拿到结果。
 */
export async function searchBing(brand: string, fetcherFor?: (hosts: string[]) => SourceFetcher): Promise<Array<{ title: string; url: string }>> {
	const fetcher = fetcherFor?.(["www.bing.com", "cn.bing.com"]) ?? new HttpSourceFetcher(["www.bing.com", "cn.bing.com"]);
	// Bing 对中文公司名分词不稳定：官网后缀会带偏，拆词/去尾/纯品牌各有命中，全部合并。
	const spaced = brand.length >= 4 ? `${brand.slice(0, -2)} ${brand.slice(-2)}` : null;
	const shortName = brand.replace(/(?:葡萄酒|控股|股份|有限公司|集团|科技|公司)$/u, "").trim();
	const queries = [
		`${brand} 官网`,
		`${brand}集团 官网`,
		brand,
		...(spaced ? [spaced, `${spaced} 集团`] : []),
		...(shortName && shortName !== brand ? [`${shortName} 官网`, shortName] : []),
	];
	const merged = new Map<string, { title: string; url: string }>();
	for (const query of queries) {
		try {
			const page = await fetcher.fetchText(
				`https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setlang=zh-cn`,
				{ maxBytes: 256 * 1024, timeoutMs: 15_000 },
			);
			if (page.status >= 400) continue;
			for (const entry of [...page.body.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, LIMIT)) {
				const body = entry[1] ?? "";
				const url = (/<link>([\s\S]*?)<\/link>/.exec(body)?.[1] ?? "").replace(/&amp;/gu, "&").trim();
				if (!url.startsWith("http") || merged.has(url)) continue;
				const title = (/<title>([\s\S]*?)<\/title>/.exec(body)?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/gu, "").replace(/&amp;/gu, "&").trim();
				merged.set(url, { title, url });
			}
		} catch {
			// 下一个查询变体。
		}
	}
	return [...merged.values()];
	return [];
}

/**
 * 企业名称 → {host, listUrl}。优先 agent-reach（Exa）；限流/失败时兑底 Bing 结果页。
 * 结果未经核验，登记后由用户在来源列表里确认采集结果是否正确。
 */
export async function discoverCompanySite(
	name: string,
	executable: string | undefined,
	options: { runReach?: RunReach; fetcher?: SourceFetcher; bingFetcherFor?: (hosts: string[]) => SourceFetcher } = {},
): Promise<CompanySite> {
	const brand = name.replace(/\s+/gu, " ").trim();
	if (!brand) throw new Error("company name required");
	// 比对时忽略空格：用户可能输入“某 企业”，页面写的是“某企业”。
	const brandCompact = brand.replace(/\s+/gu, "");
	let searchItems: unknown;
	if (executable && isAbsolute(executable)) {
		const run = options.runReach ?? runReach;
		const profile = await mkdtemp(resolve(tmpdir(), "adpulse-site-"));
		try {
			const { stdout, exitCode } = await run(executable, [
				"web", "search", `${brand} 官网`, "--backend", "exa", "--limit", String(LIMIT), "--timeout", "12",
			]);
			let result: unknown;
			try {
				result = JSON.parse(stdout);
			} catch {
				throw new Error("site discovery returned invalid JSON");
			}
			if (!isRecord(result) || result.schema_version !== 1)
				throw new Error("site discovery returned an unsupported response");
			if (result.ok !== true || exitCode !== 0)
				throw new Error(`site discovery failed (${isRecord(result.error) ? String(result.error.code) : "UPSTREAM_FAILED"})`);
			if (result.channel !== "web" || result.action !== "search")
				throw new Error("site discovery returned an unsupported response");
			searchItems = result.items;
		} catch (error) {
			// 限流/上游失败时退回 Bing 结果页，仍以公开搜索页为限。
			try {
				searchItems = await searchBing(brand, options.bingFetcherFor);
			} catch {
				throw error;
			}
		} finally {
			await rm(profile, { recursive: true, force: true });
		}
	} else {
		searchItems = await searchBing(brand, options.bingFetcherFor);
	}
	// 挑出候选后逐个验证首页；所有通过者再按域名质量择优（短域名 > 品牌镜像子域）。
	// 网络抖动会让个别候选假失败：整段验证重试一轮，仍无通过才报错。
	const ranked = rankCompanyCandidates(searchItems, brand);
	if (ranked.length === 0) throw new Error("site discovery found no usable official site");
	let lastError: Error | null = null;
	const passing: Array<{ candidate: { host: string; listUrl: string; via: string }; shape: number }> = [];
	for (const round of [0, 1]) {
	if (round === 1 && passing.length > 0) break;
	for (const candidate of ranked.slice(0, 5)) {
		if (passing.some((p) => p.candidate.host === candidate.host)) continue;
		const fetcher = options.fetcher ?? new UserSiteFetcher([candidate.host]);
		try {
			// 验证页跟随候选协议（老站可能只有 http）；网络抖动重试一次。
			const origin = new URL(candidate.listUrl).origin;
			let home;
			try {
				home = await fetcher.fetchText(`${origin}/`, { maxBytes: 512 * 1024, timeoutMs: 20_000 });
			} catch {
				home = await fetcher.fetchText(`${origin}/`, { maxBytes: 512 * 1024, timeoutMs: 20_000 });
			}
			const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/iu.exec(home.body)?.[1]?.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ") ?? "";
			const head = home.body.replace(/<[^>]+>/gu, "").replace(/\s+/gu, "").slice(0, 2000);
			const titleCompact = title.replace(/\s+/gu, "");
			const brandPrefix = brandCompact.replace(/(?:集团|股份|控股|有限公司|公司)$/u, "") || brandCompact;
			const shape = /^(?:www\.)?[^.]+\.(?:com|cn|com\.cn|net|org)$/iu.test(candidate.host) ? 1 : 0;
			const strict = titleCompact.includes(brandCompact) || head.includes(brandCompact);
			// 短域名 + 品牌前缀也算官网：真站标题常写简称（如「浪潮」而非「浪潮集团」）。
			const relaxed = shape === 1 && (titleCompact.includes(brandPrefix) || head.includes(brandPrefix));
			if (home.status < 400 && (strict || relaxed)) {
				passing.push({ candidate, shape });
				continue;
			}
			if ([401, 403, 418, 429, 503].includes(home.status))
				lastError = new Error(`official site ${candidate.host} blocks automated access (WAF/challenge)`);
			else
				lastError = new Error(`candidate ${candidate.host} homepage does not mention the company`);
		} catch (caught) {
			lastError = caught instanceof Error ? caught : new Error(String(caught));
		}
	}
	}
	if (passing.length > 0) {
		passing.sort((a, b) => b.shape - a.shape);
		const chosen = passing[0]!.candidate;
		const fetcher = options.fetcher ?? new UserSiteFetcher([chosen.host]);
		const listUrl = await resolveNewsListPage({ host: chosen.host, listUrl: chosen.listUrl }, fetcher);
		return { host: chosen.host, listUrl, via: chosen.via };
	}
	throw lastError ?? new Error("site discovery found no usable official site");
}

/** 挑站排序：同名标题优先，其次官网声明；同 host 保留新闻 URL；搜索排名靠前有微弱加分。 */
function rankCompanyCandidates(items: unknown, brand: string): Array<{ host: string; listUrl: string; via: string; score: number }> {
	const byHost = new Map<string, { host: string; listUrl: string; via: string; score: number }>();
	if (!Array.isArray(items)) return [];
	const brandName = brand.replace(/\s+/gu, "").trim();
	let position = 0;
	for (const raw of items) {
		if (!isRecord(raw) || typeof raw.url !== "string" || !URL.canParse(raw.url)) continue;
		let url: URL;
		try {
			url = new URL(raw.url);
		} catch {
			continue;
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") continue;
		if (url.username || url.password || !url.host) continue;
		// http 老站保留原协议：用户站点抓取器支持 http。
		if (NON_OFFICIAL_HOSTS.test(url.host)) continue;
		const title = typeof raw.title === "string" ? raw.title : "";
		const officialTitle = /官方网站|官网|官方门户|official site/i.test(title) ? 3 : 0;
		const aggregatorTitle = /新闻大全|相关新闻|新闻信息|资讯大全/i.test(title) ? -2 : 0;
		const newsInUrl = NEWS_TOKEN.test(`${url.pathname}${url.hostname}`) ? 1 : 0;
		const brandMatch = brandName && title.replace(/\s+/gu, "").includes(brandName) ? 5 : 0;
		// 短域名（如 inspur.com）比品牌镜像子域（inspur.ainet.cn）更可能是官网；
		// 带渠道/店铺/子品牌词的子域是镜像或专题页，常冒充主站。
		const shortHost = /^(?:www\.)?[^.]+\.(?:com|cn|com\.cn|net|org)$/iu.test(url.host);
		const mirrorish = !shortHost && /^(?:[a-z0-9-]+\.)+/iu.test(url.host) && /\b(?:\w+)\.(?:[a-z0-9-]+\.)?/iu.test(url.host);
		const hostShape = shortHost ? 3 : mirrorish ? 0 : 1;
		// 搜索排名越靠前越可能是官网：用微弱加分在平票时倾斜。
		const positionBonus = Math.max(0, 1 - position * 0.05);
		position += 1;
		const score = brandMatch + officialTitle + aggregatorTitle + newsInUrl + hostShape + positionBonus;
		const previous = byHost.get(url.host);
		if (!previous || score > previous.score) {
			byHost.set(url.host, {
				host: url.host,
				listUrl: url.toString(),
				via: title.slice(0, 80),
				score,
			});
		}
	}
	return [...byHost.values()].sort((a, b) => b.score - a.score);
}

/** 兼容旧测试：不给企业名时返回排序首位（不验主页）。 */
export function pickCompanySite(
	items: unknown,
	brand?: string,
): { host: string; listUrl: string; via: string } | null {
	return rankCompanyCandidates(items, brand?.replace(/\s+/gu, "").trim() ?? "")[0] ?? null;
}
