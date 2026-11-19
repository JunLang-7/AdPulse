// 企业名称 → 官网新闻列表页自动发现。
// 用 agent-reach（Exa 搜索）找候选官网，再在候选站内定位新闻列表页；
// 找不到就如实报错，不猜测、不编造地址。发现结果只用于登记，不自动采正文。
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isSimplifiedChineseTitle, normalizeItemUrl, parseJsonListPayload, parseUserListPage } from "@adpluse/core";
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
	/baidu\.com|zhihu\.com|qq\.com|163\.com|126\.net|sohu\.com|sina\.com|douyin\.com|toutiao\.com|xinhuanet\.com|people\.com\.cn|wikipedia\.org|gov\.cn|tianyancha\.com|qcc\.com|qichacha\.com|aiqicha\.com|maigoo\.com|csdn\.net|jianshu\.com|juejin\.cn|cnblogs\.com|36kr\.com|netease\.com|ifeng\.com|thepaper\.cn|cntv\.cn|chinanews\.com|ce\.cn|cctv\.com|baike\.|bilibili\.com|kuwo\.cn|kugou\.com|migu\.cn|eastmoney\.com|xueqiu\.com|9fzt\.com|jd\.com|tmall\.com|taobao\.com|1688\.com|weibo\.com|douban\.com|zhuanlan\.|58\.com|zhaopin\.com|51job\.com|liepin\.com|zhipin\.com|huangye88\.com|s114\.cn|hc360\.com|made-in-china\.com|globalsources\.com|ebdoor\.com|china\.cn|99114\.com|3158\.cn|jmw\.com|chachaba\.com|dianping\.com|meituan\.com|ctrip\.com|qunar\.com|autohome\.com|yiche\.com|dongchedi\.com|pconline\.com\.cn|zol\.com\.cn|ithome\.com|so\.com|sogou\.com|yandex\./i;
/**
 * 标题侧的非官网信号：经销商/加盟/招标/价格页常带品牌名，但并不是企业官网。
 * 命中只降权，不直接删：一个站可能既发官网新闻又发招商，完全剔除会误伤。
 */
const NON_OFFICIAL_TITLE = /经销商|代理商|加盟|招商|批发|供应|求购|招标|投标|中标|招聘|求职|价格表|报价|旗舰店|专营店|专卖店|官网大全|网址大全|导航|下载站|破解|小说|贴吧|论坛|股票|行情|股价|讨论区/i;
/**
 * 中文品牌后面允许直接跟的「公司/行业后缀」。
 * 「美的」这类二字品牌光靠包含关系会命中「海尔曼」这种更长词，
 * 只有前后不在词中、或后面跟这些后缀时才算提到该品牌。
 */
const BRAND_CONTINUATIONS =
	/^(?:集团|股份|有限|公司|官网|官方|首页|门户|网站|控股|实业|科技|电器|电气|电机|电子|智能|暖通|空调|冰箱|洗衣机|厨卫|厨电|家居|生活|置业|地产|物业|物流|金融|银行|证券|保险|医疗|医药|食品|乳业|酒业|饮料|汽车|新能源|半导体|微电子|软件|网络|数据|云|物联|通信|光电|照明|建材|化工|钢铁|有色|矿业|重工|装备|机械|工程|建设|环保|能源|电力|航空|船舶|航天|纺织|服装|农业|牧业|旅游|文化|传媒|教育|健康|美妆|日化|纸业|包装|啤酒|茶业|药业|生物|新材|机床|塑机|模具|轴承|泵业|阀门|电缆|变压器|锅炉|压力|仪器|仪表|光学|激光|机器人|自动化|轮胎|玻璃|水泥|陶瓷|涂料|地板|家具|家电|厨柜|照明|电池|光伏|风电|核电|水务|燃气|煤炭|港口|航运|铁路|轨道|民航|机场|高速|隧道|桥梁|市政|园林|装修|装饰|设计院|研究院|研究所|工业|园区|工贸|商贸|贸易|国际|全球|中国|控股集团|电气集团|实业集团|智家|智造|智联|技术|数字|信息|发展|管理|服务|商业|超市|百货|商场|酒店|文旅|演艺|院线|出版|动力|重工|装备|机床|电机|车辆|商用车|乘用车|客车|工程机械|机械|设备|系统|集成|解决方案|官方商城)/u;
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;

/**
 * 标题是否可以作为「这家企业的官网」的证据。
 *
 * 两步：先排除经销商/招聘/价格/导航类标题（它们常带品牌名），
 * 再要求标题里真的以品牌边界形式出现。
 */
export function isOfficialCandidateTitle(title: string, brand: string): boolean {
	if (!title) return false;
	if (NON_OFFICIAL_TITLE.test(title)) return false;
	return mentionsBrand(title, brand);
}

/**
 * 判断一段文字是否“真的提到这个企业”。
 *
 * 纯 includes 匹配在中文短品牌上假阳性很高（如「海尔曼」「美的好家」），
 * 这里要求命中位置的前后不在词中，或后面跟着明确的公司/行业后缀。
 * 拉丁品牌按词边界判断，避免 midea 命中 mideas。
 */
export function mentionsBrand(text: string, brand: string): boolean {
	const needle = brand.replace(/\s+/gu, "").trim();
	if (!needle) return false;
	const cjkBrand = [...needle].some((char) => CJK.test(char));
	if (!cjkBrand) {
		// 拉丁品牌：在原文本上按词边界匹配（不能先删空格，否则 Midea Group 会粘成一词）。
		const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "iu").test(text);
	}
	const haystack = text.replace(/\s+/gu, "");
	let from = 0;
	for (;;) {
		const index = haystack.indexOf(needle, from);
		if (index < 0) return false;
		const before = index > 0 ? haystack[index - 1] ?? "" : "";
		const afterIndex = index + needle.length;
		const after = haystack.slice(afterIndex, afterIndex + 4);
		const startsCleanly = !before || !CJK.test(before);
		// 后面跟「集团/电器/工业」这类公司或行业后缀，就算句中提到也算真品牌；
		// 否则要求后面不是汉字（避免「美的很安静」这类形容词用法）。
		if (BRAND_CONTINUATIONS.test(after) || (startsCleanly && !CJK.test(after[0] ?? ""))) return true;
		from = index + 1;
	}
}
const NEWS_TOKEN = /news|xinwen|xwzx|xwtt|新闻|动态|资讯|信息|media|press/i;
/** 列表页解析最多试几个候选：每次最多 4 个请求，避免“发现+探测”把单次登记放大成几十个请求。 */
const MAX_LIST_PAGE_ATTEMPTS = 3;
/** 首页验证最多试几个候选：搜索前几名常是音乐/股票/百科，真正的官网可能在第 6–8 位。 */
const MAX_VERIFY_CANDIDATES = 8;
/** 备选站点最多返回几个：主站采不到时按顺序换站重试。 */
const MAX_SITES = 3;

/**
 * 搜索源频率保护：Bing/Exa 在连续请求下会降级（返回无关结果或限流）。
 * 同一进程内相邻搜索至少隔 3 秒；同一企业名的结果缓存 6 小时，避免重复消耗配额。
 */
const MIN_SEARCH_INTERVAL_MS = 3_000;
const SEARCH_CACHE_TTL_MS = 6 * 3_600_000;
let lastSearchAt = 0;
const searchCache = new Map<string, { at: number; items: Array<{ title: string; url: string }> }>();

async function throttleSearch(): Promise<void> {
	const wait = lastSearchAt + MIN_SEARCH_INTERVAL_MS - Date.now();
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	lastSearchAt = Date.now();
}

/** 测试用：清空节流与缓存状态。 */
export function resetDiscoveryThrottle(): void {
	lastSearchAt = 0;
	searchCache.clear();
}

export interface CompanySite {
	host: string;
	listUrl: string;
	/** 搜索命中的原始 URL（已脱敏用途说明，仅日志用）。 */
	via: string;
}

/** 搜索源额度全部用完：调用方应提示用户次日恢复或手动补填。 */
export class SearchQuotaExhaustedError extends Error {
	constructor(
		public readonly providers: Array<{ provider: string; label: string; detail: string | null }>,
	) {
		super("search quota exhausted");
	}
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

/** 数据接口不是列表页：路径以数据文件后缀结尾，或用查询声明 JSON/XML 输出。 */
const DATA_LIKE_PATH = /\.(?:json|xml|rss|atom|txt|csv)$/iu;
const DATA_LIKE_QUERY = /(?:^|&)(?:format|type|output)=(?:json|xml|rss|atom)(?:&|$)/iu;

/** 候选 URL 本身是数据接口（不是可采集的 HTML 列表页）。 */
export function isDataLikePageUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return DATA_LIKE_PATH.test(url.pathname) || DATA_LIKE_QUERY.test(url.search.slice(1));
	} catch {
		return false;
	}
}

/** 抓取器不返回 content-type，只能按结构嗅探：数据接口不会是 HTML 页面。 */
export function looksLikeHtmlPage(body: string): boolean {
	const trimmed = body.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
	return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<a\b/iu.test(body);
}

interface FetchedPage {
	status: number;
	body: string;
}

async function fetchQuietly(fetcher: SourceFetcher, url: string): Promise<FetchedPage | null> {
	try {
		return await fetcher.fetchText(url, { maxBytes: 512 * 1024, timeoutMs: 15_000 });
	} catch {
		return null;
	}
}

/** 在页面里找第一个指向站内新闻页的锚文本。 */
function firstNewsAnchor(html: string, base: string, host: string): string | null {
	const anchor = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/giu;
	let match: RegExpExecArray | null;
	while ((match = anchor.exec(html))) {
		const href = match[2] ?? match[3] ?? match[4] ?? "";
		const text = (match[5] ?? "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
		const target = normalizeItemUrl(href, base, [host]);
		if (!target || isDataLikePageUrl(target)) continue;
		if (NEWS_TOKEN.test(new URL(target).pathname) || NEWS_TOKEN.test(text)) return target;
	}
	return null;
}

/**
 * 在官网站内找新闻列表页：锚文本/href 含新闻词即用；找不到就用命中的原始页面。
 * 只接受验证过的 HTML 页面：数据接口（.json/.xml/.rss 等）或非 HTML 响应返回 null，
 * 由调用方换下一个候选，避免把 newsroom.json 这类接口地址存成列表页。
 */
export async function resolveNewsListPage(
	candidate: { host: string; listUrl: string },
	fetcher: SourceFetcher,
): Promise<string | null> {
	const resolved = await resolveNewsListPageDetailed(candidate, fetcher);
	return resolved?.listUrl ?? null;
}

/** 与 resolveNewsListPage 相同，但把页面正文带回来，供“能不能解析出条目”的排序使用。 */
export async function resolveNewsListPageDetailed(
	candidate: { host: string; listUrl: string },
	fetcher: SourceFetcher,
): Promise<{ listUrl: string; body: string } | null> {
	const { host, listUrl } = candidate;
	if (!isDataLikePageUrl(listUrl)) {
		const page = await fetchQuietly(fetcher, listUrl);
		if (page && page.status < 400 && looksLikeHtmlPage(page.body)) {
			if (NEWS_TOKEN.test(new URL(listUrl).pathname)) return { listUrl, body: page.body };
			const entry = firstNewsAnchor(page.body, listUrl, host);
			if (entry) {
				const entryPage = await fetchQuietly(fetcher, entry);
				if (entryPage && entryPage.status < 400 && looksLikeHtmlPage(entryPage.body))
					return { listUrl: entry, body: entryPage.body };
			}
			return { listUrl, body: page.body };
		}
	}
	// 候选是数据接口或非 HTML：改在站点首页找一个验证过的新闻入口；找不到就如实返回 null。
	const origin = new URL(listUrl).origin;
	const homeUrl = `${origin}/`;
	if (homeUrl !== listUrl) {
		const home = await fetchQuietly(fetcher, homeUrl);
		if (home && home.status < 400 && looksLikeHtmlPage(home.body)) {
			const entry = firstNewsAnchor(home.body, homeUrl, host);
			if (entry) {
				const entryPage = await fetchQuietly(fetcher, entry);
				if (entryPage && entryPage.status < 400 && looksLikeHtmlPage(entryPage.body))
					return { listUrl: entry, body: entryPage.body };
			}
		}
	}
	return null;
}

/**
 * Exa 限流或失败时的兑底：Bing 的 RSS 输出（format=rss）。
 * 结构稳定无广告；查询按变体轮询直到拿到结果。
 */
export async function searchBing(brand: string, fetcherFor?: (hosts: string[]) => SourceFetcher): Promise<Array<{ title: string; url: string }>> {
	const cacheKey = `bing:${brand}`;
	const cached = searchCache.get(cacheKey);
	if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return cached.items;
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
		// 连续请求会触发降级：変体之间也拉开间隔。
		await throttleSearch();
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
	const items = [...merged.values()];
	// 只缓存非空结果：搜索源回归空集时应当下次重试，而不是记住“没有”。
	if (items.length > 0) searchCache.set(cacheKey, { at: Date.now(), items });
	return items;
}

/**
 * 企业名称 → 最多 MAX_SITES 个已验证的 {host, listUrl}（按分数与域名质量排序）。
 * 只要一个站点时用 discoverCompanySite；主站采集不到内容时按这份列表换站重试。
 */
export async function discoverCompanySites(
	name: string,
	executable: string | undefined,
	options: {
		runReach?: RunReach;
		fetcher?: SourceFetcher;
		bingFetcherFor?: (hosts: string[]) => SourceFetcher;
		/** 多源聚合（带额度管控）；传入后不再走单源路径。 */
		aggregator?: {
			search(brand: string, overrides?: { enoughHits?: number }): Promise<{
				hits: Array<{ title: string; url: string }>;
				providers: Array<{ provider: string; label: string; status: string; detail: string | null }>;
			}>;
		};
	} = {},
): Promise<CompanySite[]> {
	const brand = name.replace(/\s+/gu, " ").trim();
	if (!brand) throw new Error("company name required");
	const brandCompact = brand.replace(/\s+/gu, "");
	let searchItems: unknown;
	// 聚合搜索：给了 aggregator 就走多源（带额度管控），否则走旧的单源兼容路径。
	if (options.aggregator) {
		const aggregated = await options.aggregator.search(brand);
		if (aggregated.hits.length === 0) {
			const exhausted = aggregated.providers.filter((p) => p.status === "quota_exhausted");
			if (exhausted.length > 0)
				throw new SearchQuotaExhaustedError(
					exhausted.map((p) => ({ provider: p.provider, label: p.label, detail: p.detail })),
				);
			const details = aggregated.providers.filter((p) => p.detail).map((p) => `${p.label}：${p.detail}`);
			throw new Error(details.length > 0 ? `search found nothing (${details.join("；")})` : "search found nothing");
		}
		searchItems = aggregated.hits;
	} else if (executable && isAbsolute(executable)) {
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
	// 挑出候选后逐个验证首页；所有通过者再解析列表页，并按「能否解析出条目」排序。
	// 网络抖动会让个别候选假失败：整段验证重试一轮，仍无通过才报错。
	let lastError: Error | null = null;
	const rejectedHosts: string[] = [];
	/** 验证阶段顺带解析过的列表页：resolve 循环直接复用，不重复请求。 */
	const preResolved = new Map<string, { listUrl: string; body: string }>();
	const resolveCandidates = async (
		items: unknown,
		skipHosts: Set<string>,
	): Promise<Array<CompanySite & { shape: number; itemCount: number; simplifiedCount: number }>> => {
		const ranked = rankCompanyCandidates(items, brand).filter((candidate) => !skipHosts.has(candidate.host));
		if (ranked.length === 0) return [];
		const passing: Array<{ candidate: { host: string; listUrl: string; via: string }; shape: number }> = [];
		for (const round of [0, 1]) {
			if (round === 1 && passing.length > 0) break;
			for (const candidate of ranked.slice(0, MAX_VERIFY_CANDIDATES)) {
				if (passing.some((p) => p.candidate.host === candidate.host)) continue;
				const fetcher = options.fetcher ?? new UserSiteFetcher([candidate.host]);
				try {
					// 验证页跟随候选协议（老站可能只有 http）；网络抖动重试一次。
					// 首页可能整个连不上（实测 www.midea.com.cn/ socket hang up），
					// 抓不到不算判死：下面还有「列表页判归属」这条兜底。
					const origin = new URL(candidate.listUrl).origin;
					let home: { status: number; body: string } | null = null;
					try {
						home = await fetcher.fetchText(`${origin}/`, { maxBytes: 512 * 1024, timeoutMs: 20_000 });
					} catch {
						home = await fetcher.fetchText(`${origin}/`, { maxBytes: 512 * 1024, timeoutMs: 20_000 }).catch(() => null);
					}
					const brandPrefix = brandCompact.replace(/(?:集团|股份|控股|有限公司|公司)$/u, "") || brandCompact;
					const shape = /^(?:www\.)?[^.]+\.(?:com|cn|com\.cn|net|org)$/iu.test(candidate.host) ? 1 : 0;
					if (home && home.status < 400) {
						const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/iu.exec(home.body)?.[1]?.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ") ?? "";
						const head = home.body.replace(/<[^>]+>/gu, "").replace(/\s+/gu, "").slice(0, 2000);
						// 官网标题词：只有这类标题才允许用正文里的品牌提及作补充证据。
						const officialTitle = /官网|官方网站|官方门户|首页|关于我们|公司简介|官网首页/i.test(title);
						// 标题必须自己带品牌（且不是经销商/招聘/价格页），
						// 或标题是官网类词且正文提到品牌——两条都把干扰标题排在前一步。
						const titleOk = isOfficialCandidateTitle(title, brandCompact) || isOfficialCandidateTitle(title, brandPrefix);
						const bodyMentions = mentionsBrand(head, brandCompact) || mentionsBrand(head, brandPrefix);
						const strict = titleOk || (bodyMentions && officialTitle && !NON_OFFICIAL_TITLE.test(title));
						// 「短域名 + 品牌前缀」只在标题里认，且标题要像官网。
						const relaxed = shape === 1 && officialTitle && !NON_OFFICIAL_TITLE.test(title) && mentionsBrand(title, brandPrefix);
						if (strict || relaxed) {
							passing.push({ candidate, shape });
							continue;
						}
					}
					// 首页抓不到、是英文/跳转页（实测 midea.com.cn → /en）、或没写品牌名时，
					// 用「能解析出的列表页地址 + 条目标题」作为归属判据。
					try {
						const resolved = await resolveNewsListPageDetailed(candidate, fetcher);
						if (resolved) {
							const titles = [
								...parseUserListPage(resolved.body, resolved.listUrl, candidate.host),
								...parseJsonListPayload(resolved.body, resolved.listUrl, candidate.host),
							]
								.map((item) => item.title)
								.join("");
							// 只看列表页地址与条目标题，不看整页正文：
							// 正文里提到品牌是资讯门户/经销商页的典型特征，不能当作官网归属证据。
							const evidence = `${resolved.listUrl}${titles}`;
							if (mentionsBrand(evidence, brandCompact) || mentionsBrand(evidence, brandPrefix)) {
								preResolved.set(candidate.host, resolved);
								passing.push({ candidate, shape });
								continue;
							}
						}
					} catch {
						// 目标页抓不到就按原结论处理。
					}
					if (home && [401, 403, 418, 429, 503].includes(home.status))
						lastError = new Error(`official site ${candidate.host} blocks automated access (WAF/challenge)`);
					else
						lastError = new Error(`candidate ${candidate.host} homepage does not mention the company`);
				} catch (caught) {
					lastError = caught instanceof Error ? caught : new Error(String(caught));
				}
			}
		}
		passing.sort((a, b) => b.shape - a.shape);
		const sites: Array<CompanySite & { shape: number; itemCount: number; simplifiedCount: number }> = [];
		// 首选候选的列表页可能是数据接口或非 HTML：按分数顺序试下一个。
		// 每次尝试最多再发 4 个请求，所以只试前几个候选，避免单次登记放大成几十个请求。
		for (const { candidate, shape } of passing.slice(0, MAX_LIST_PAGE_ATTEMPTS)) {
			const fetcher = options.fetcher ?? new UserSiteFetcher([candidate.host]);
			const resolved =
				preResolved.get(candidate.host) ??
				(await resolveNewsListPageDetailed({ host: candidate.host, listUrl: candidate.listUrl }, fetcher));
			if (!resolved) {
				rejectedHosts.push(candidate.host);
				continue;
			}
			// 同一个品牌常有多个站（集团站/商城站/品牌站）：列表页真能解析出条目的优先；
			// 试点面向简中用户，条目以简体中文为主体的站点优先（实测美的台湾站/海尔全球站会先被搜到）。
			const htmlItems = parseUserListPage(resolved.body, resolved.listUrl, candidate.host);
			const items = htmlItems.length > 0
				? htmlItems
				: parseJsonListPayload(resolved.body, resolved.listUrl, candidate.host);
			const itemCount = items.length;
			const simplifiedCount = items.filter((item) => isSimplifiedChineseTitle(item.title)).length;
			sites.push({ host: candidate.host, listUrl: resolved.listUrl, via: candidate.via, shape, itemCount, simplifiedCount });
		}
		return sites;
	};

	// 「<企业> 官网」常被商城/集团站占满：一遍都解析不出条目时，再用「<企业> 新闻中心」补一轮，
	// 实测这一句能把 midea.com.cn、haier.com 这类真正有新闻列表的站带出来。
	const extraSearch = async (): Promise<unknown> => {
		// 只在注入聚合器时补搜：单源兼容路径（agent-reach / Bing）不做第二次请求，
		// 避免测试与离线场景意外访问网络，也避免额度不可控。
		if (!options.aggregator) return [];
		// 关键：按次解除「凑够 8 条就短路」。免费源（实测 Bing）会返回 8 条商城/字典站，
		// 不解除短路的话付费源（Google）永远不会被咨询——这正是换站拿不到正确官网的原因。
		const aggregated = await options.aggregator
			.search(`${brand} 新闻中心`, { enoughHits: Number.POSITIVE_INFINITY })
			.catch(() => null);
		return aggregated?.hits ?? [];
	};

	let sites = await resolveCandidates(searchItems, new Set());
	// 「<企业> 官网」常被商城/招聘/登录子域占满：第一遍没有能解析出条目的站点时，
	// 升级一轮「<企业> 新闻中心」搜索并咨询全部源（含付费源）。第一遍找到可用站点就不升级，
	// 正常企业（免费源就能找到官网）不消耗付费额度。
	if (sites.length === 0 || sites.every((site) => site.itemCount === 0)) {
		const extra = await extraSearch();
		if (Array.isArray(extra) && extra.length > 0)
			sites = [...sites, ...(await resolveCandidates(extra, new Set(sites.map((site) => site.host))))];
	}
	if (sites.length > 0) {
		sites.sort(
			(a, b) =>
				(b.itemCount > 0 ? 1 : 0) - (a.itemCount > 0 ? 1 : 0) ||
				(b.simplifiedCount > 0 ? 1 : 0) - (a.simplifiedCount > 0 ? 1 : 0) ||
				b.simplifiedCount - a.simplifiedCount ||
				b.itemCount - a.itemCount ||
				b.shape - a.shape,
		);
		return sites.slice(0, MAX_SITES).map(({ host, listUrl, via }) => ({ host, listUrl, via }));
	}
	if (rejectedHosts.length > 0)
		throw new Error(
			`no usable HTML news list page on ${rejectedHosts.join(", ")} (candidate page was a data endpoint or not HTML)`,
		);
	throw lastError ?? new Error("site discovery found no usable official site");
}

/**
 * 企业名称 → 单个 {host, listUrl}。优先 agent-reach（Exa）；限流/失败时兑底 Bing 结果页。
 * 结果未经核验，登记后由用户在来源列表里确认采集结果是否正确。
 */
export async function discoverCompanySite(
	name: string,
	executable: string | undefined,
	options: Parameters<typeof discoverCompanySites>[2] = {},
): Promise<CompanySite> {
	const [first] = await discoverCompanySites(name, executable, options);
	if (!first) throw new Error("site discovery found no usable official site");
	return first;
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
		// 字典/组词站的标题常含品牌名（「美的拼音_美组词_怎么读」），不重罚会压过真官网。
		const dictionaryTitle = /拼音|组词|词典|读音|什么意思|怎么读|翻译|解释/i.test(title) ? -6 : 0;
		const newsInUrl = NEWS_TOKEN.test(`${url.pathname}${url.hostname}`) ? 1 : 0;
		// 用边界匹配：二字品牌（美的/海尔）光靠 includes 会命中「海尔曼」这类无关词。
		const brandMatch = brandName && mentionsBrand(title, brandName) ? 5 : 0;
		const dealerPenalty = NON_OFFICIAL_TITLE.test(title) ? -5 : 0;
		// 短域名（如 inspur.com）比品牌镜像子域（inspur.ainet.cn）更可能是官网；
		// 带渠道/店铺/子品牌词的子域是镜像或专题页，常冒充主站。
		const shortHost = /^(?:www\.)?[^.]+\.(?:com|cn|com\.cn|net|org)$/iu.test(url.host);
		const mirrorish = !shortHost && /^(?:[a-z0-9-]+\.)+/iu.test(url.host) && /\b(?:\w+)\.(?:[a-z0-9-]+\.)?/iu.test(url.host);
		const hostShape = shortHost ? 3 : mirrorish ? 0 : 1;
		// 搜索排名越靠前越可能是官网：用微弱加分在平票时倾斜。
		const positionBonus = Math.max(0, 1 - position * 0.05);
		position += 1;
		const score = brandMatch + officialTitle + aggregatorTitle + dictionaryTitle + newsInUrl + hostShape + positionBonus + dealerPenalty;
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
