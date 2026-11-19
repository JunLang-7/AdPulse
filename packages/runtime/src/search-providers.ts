// 具体搜索源实现：Bing RSS（免费）、agent-reach/Exa（免费但限流）、
// 百度千帆 / 博查 / Serper / Brave（付费 API，按环境变量密钥启用）。
// 所有源都只返回「标题 + URL」，不把正文当结果搬运。
//
// 中文企业优先用国内索引：百度千帆与博查都是官方文档化 API，
// 不抓百度/搜狗/360 的搜索结果页（那属于未授权采集，且 robots/风控不允许）。
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { SearchHit, SearchProvider } from "@adpluse/core";
import { UserSiteFetcher } from "./source-fetch.js";

const LIMIT = 8;

/** Bing 结果页的 RSS 输出：结构稳定、无广告，按查询变体合并去重。 */
export function bingQueries(brand: string): string[] {
	const spaced = brand.length >= 4 ? `${brand.slice(0, -2)} ${brand.slice(-2)}` : null;
	const shortName = brand.replace(/(?:葡萄酒|控股|股份|有限公司|集团|科技|公司)$/u, "").trim();
	return [
		`${brand} 官网`,
		`${brand}官方网站`,
		`${brand}首页`,
		`${brand}集团 官网`,
		brand,
		...(spaced ? [spaced, `${spaced} 集团`] : []),
		...(shortName && shortName !== brand ? [`${shortName} 官网`, shortName] : []),
	];
}

function parseRss(body: string): SearchHit[] {
	const hits: SearchHit[] = [];
	for (const entry of [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, LIMIT)) {
		const chunk = entry[1] ?? "";
		const url = (/<link>([\s\S]*?)<\/link>/.exec(chunk)?.[1] ?? "").replace(/&amp;/gu, "&").trim();
		if (!url.startsWith("http")) continue;
		const title = (/<title>([\s\S]*?)<\/title>/.exec(chunk)?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/gu, "").replace(/&amp;/gu, "&").trim();
		hits.push({ title, url });
	}
	return hits;
}

export function bingProvider(options: { dailyLimit?: number | null } = {}): SearchProvider {
	return {
		id: "bing",
		label: "Bing 网页检索",
		metered: false,
		dailyLimit: options.dailyLimit === undefined ? 200 : options.dailyLimit,
		async search(query) {
			const fetcher = new UserSiteFetcher(["www.bing.com", "cn.bing.com"]);
			const merged = new Map<string, SearchHit>();
			let lastStatus = 0;
			for (const variant of bingQueries(query)) {
				try {
					const page = await fetcher.fetchText(
						// mkt/cc 让 Bing 按简中市场返回结果；不指定时常命中英文/港台站。
						`https://www.bing.com/search?q=${encodeURIComponent(variant)}&format=rss&setlang=zh-cn&mkt=zh-CN&cc=CN`,
						{ maxBytes: 256 * 1024, timeoutMs: 15_000 },
					);
					lastStatus = page.status;
					if (page.status === 429) return { status: "rate_limited", hits: [...merged.values()], detail: "Bing 限流，稍后重试" };
					if (page.status >= 400) continue;
					for (const hit of parseRss(page.body)) if (!merged.has(hit.url)) merged.set(hit.url, hit);
				} catch {
					// 下一变体
				}
			}
			if (merged.size === 0 && lastStatus >= 400)
				return { status: "unavailable", hits: [], detail: `Bing 返回 ${lastStatus}` };
			return { status: "ok", hits: [...merged.values()] };
		},
	};
}

/** agent-reach 的 web search（Exa 后端）：免费但会限流，额度由本系统按日计。 */
export function agentReachProvider(executable: string | undefined, options: { dailyLimit?: number | null } = {}): SearchProvider {
	return {
		id: "exa",
		label: "Exa 语义检索（agent-reach）",
		metered: false,
		dailyLimit: options.dailyLimit === undefined ? 50 : options.dailyLimit,
		async search(query) {
			if (!executable || !isAbsolute(executable))
				return { status: "unavailable", hits: [], detail: "未配置 AGENT_REACH_BIN" };
			const profile = await mkdtemp(resolve(tmpdir(), "adpulse-exa-"));
			try {
				const { stdout } = await new Promise<{ stdout: string }>((done, reject) => {
					execFile(
						executable,
						["web", "search", `${query} 官网`, "--backend", "exa", "--limit", String(LIMIT), "--timeout", "12"],
						{ timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true },
						(error, out) => (error?.signal ? reject(new Error("timeout")) : done({ stdout: out })),
					);
				});
				let parsed: unknown;
				try {
					parsed = JSON.parse(stdout);
				} catch {
					return { status: "failed", hits: [], detail: "Exa 返回内容无法解析" };
				}
				const payload = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
				const errorPayload = payload && typeof payload.error === "object" && payload.error !== null
					? (payload.error as Record<string, unknown>)
					: null;
				const code = typeof errorPayload?.code === "string" ? errorPayload.code : "";
				if (!payload || payload.ok !== true) {
					if (code === "RATE_LIMITED") {
						const hint = typeof errorPayload?.hint === "string" ? errorPayload.hint : "";
						const wait = /wait (\d+) seconds/iu.exec(hint)?.[1];
						return { status: "rate_limited", hits: [], detail: wait ? `Exa 限流，${Math.ceil(Number(wait) / 60)} 分钟后可重试` : "Exa 限流" };
					}
					return { status: "failed", hits: [], detail: code || "Exa 调用失败" };
				}
				const items = Array.isArray(payload.items) ? payload.items : [];
				const hits: SearchHit[] = [];
				for (const raw of items.slice(0, LIMIT)) {
					if (typeof raw !== "object" || raw === null) continue;
					const record = raw as Record<string, unknown>;
					if (typeof record.url !== "string" || !record.url.startsWith("http")) continue;
					hits.push({ title: typeof record.title === "string" ? record.title : "", url: record.url });
				}
				return { status: "ok", hits };
			} catch {
				return { status: "failed", hits: [], detail: "Exa 调用超时或失败" };
			} finally {
				await rm(profile, { recursive: true, force: true });
			}
		},
	};
}

/** Serper.dev（Google 结果，付费，有免费试用额度）。 */
export function serperProvider(apiKey: string | undefined, options: { dailyLimit?: number | null } = {}): SearchProvider | null {
	if (!apiKey) return null;
	return {
		id: "serper",
		label: "Serper（Google）",
		metered: true,
		dailyLimit: options.dailyLimit === undefined ? 100 : options.dailyLimit,
		async search(query) {
			try {
				const response = await fetch("https://google.serper.dev/search", {
					method: "POST",
					headers: { "X-API-KEY": apiKey, "content-type": "application/json" },
					// 查询词由调用方决定（品牌名 / 「XX 新闻中心」），原样发给 Google；
				// 实测强拼「 官网」后缀会让「品牌 官网」返回仿冒站、让新闻类查询劣化。
				body: JSON.stringify({ q: query, gl: "cn", hl: "zh-cn", num: LIMIT }),
					signal: AbortSignal.timeout(15_000),
				});
				if (response.status === 429) return { status: "rate_limited", hits: [], detail: "Serper 限流" };
				if (response.status === 401 || response.status === 403)
					return { status: "unavailable", hits: [], detail: "Serper 密钥无效或额度耗尽" };
				if (!response.ok) return { status: "failed", hits: [], detail: `Serper 返回 ${response.status}` };
				const body = (await response.json()) as { organic?: Array<{ title?: string; link?: string }> };
				const hits: SearchHit[] = [];
				for (const item of (body.organic ?? []).slice(0, LIMIT))
					if (item.link?.startsWith("http")) hits.push({ title: item.title ?? "", url: item.link });
				return { status: "ok", hits };
			} catch {
				return { status: "failed", hits: [], detail: "Serper 请求失败" };
			}
		},
	};
}

/** Brave Search API（付费，有免费额度）。 */
export function braveProvider(apiKey: string | undefined, options: { dailyLimit?: number | null } = {}): SearchProvider | null {
	if (!apiKey) return null;
	return {
		id: "brave",
		label: "Brave 搜索",
		metered: true,
		dailyLimit: options.dailyLimit === undefined ? 100 : options.dailyLimit,
		async search(query) {
			try {
				const response = await fetch(
					`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${LIMIT}&country=cn`,
					{ headers: { "X-Subscription-Token": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
				);
				if (response.status === 429) return { status: "rate_limited", hits: [], detail: "Brave 限流" };
				if (response.status === 401 || response.status === 403)
					return { status: "unavailable", hits: [], detail: "Brave 密钥无效或额度耗尽" };
				if (!response.ok) return { status: "failed", hits: [], detail: `Brave 返回 ${response.status}` };
				const body = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string }> } };
				const hits: SearchHit[] = [];
				for (const item of (body.web?.results ?? []).slice(0, LIMIT))
					if (item.url?.startsWith("http")) hits.push({ title: item.title ?? "", url: item.url });
				return { status: "ok", hits };
			} catch {
				return { status: "failed", hits: [], detail: "Brave 请求失败" };
			}
		},
	};
}

/**
 * 百度千帆 AI 搜索（官方 API，按量计费，每月免费额度）。
 * 契约：POST https://qianfan.baidubce.com/v2/ai_search/web_search
 * 请求体 messages + search_source=baidu_search_v2；响应 references[] 带 title/url。
 * 不抓 www.baidu.com/s（未授权采集）。
 */
export function baiduProvider(apiKey: string | undefined, options: { dailyLimit?: number | null } = {}): SearchProvider | null {
	if (!apiKey) return null;
	return {
		id: "baidu",
		label: "百度千帆 AI 搜索",
		metered: true,
		dailyLimit: options.dailyLimit === undefined ? 100 : options.dailyLimit,
		async search(query) {
			try {
				const response = await fetch("https://qianfan.baidubce.com/v2/ai_search/web_search", {
					method: "POST",
					headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
					body: JSON.stringify({
						messages: [{ role: "user", content: query }],
						search_source: "baidu_search_v2",
						resource_type_filter: [{ type: "web", top_k: LIMIT }],
					}),
					signal: AbortSignal.timeout(15_000),
				});
				if (response.status === 429) return { status: "rate_limited", hits: [], detail: "百度千帆限流或当日免费额度已用完" };
				if (response.status === 401 || response.status === 403)
					return { status: "unavailable", hits: [], detail: "百度千帆密钥无效" };
				if (!response.ok) return { status: "failed", hits: [], detail: `百度千帆返回 ${response.status}` };
				const body = (await response.json()) as {
					references?: Array<{ title?: string; url?: string }>;
					code?: number | string;
					message?: string;
				};
				// 鉴权/参数错误可能以 200 + code 返回。
				if (body.code !== undefined && body.code !== 0 && !Array.isArray(body.references))
					return { status: "failed", hits: [], detail: `百度千帆错误 ${String(body.code)}` };
				const hits: SearchHit[] = [];
				for (const item of (body.references ?? []).slice(0, LIMIT))
					if (item.url?.startsWith("http")) hits.push({ title: item.title ?? "", url: item.url });
				return { status: "ok", hits };
			} catch {
				return { status: "failed", hits: [], detail: "百度千帆请求失败" };
			}
		},
	};
}

/**
 * 博查 Web Search（官方 API，中文索引）。
 * 契约：POST https://api.bochaai.com/v1/web-search
 * 响应 data.webPages.value[]（部分代理直接回 webPages），字段为 name + url。
 */
export function bochaProvider(apiKey: string | undefined, options: { dailyLimit?: number | null } = {}): SearchProvider | null {
	if (!apiKey) return null;
	return {
		id: "bocha",
		label: "博查搜索",
		metered: true,
		dailyLimit: options.dailyLimit === undefined ? 100 : options.dailyLimit,
		async search(query) {
			type Page = { webPages?: { value?: Array<{ name?: string; url?: string }> } };
			try {
				const response = await fetch("https://api.bochaai.com/v1/web-search", {
					method: "POST",
					headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
					body: JSON.stringify({ query, freshness: "noLimit", summary: false, count: LIMIT }),
					signal: AbortSignal.timeout(15_000),
				});
				if (response.status === 429) return { status: "rate_limited", hits: [], detail: "博查限流或额度用完" };
				if (response.status === 401 || response.status === 403)
					return { status: "unavailable", hits: [], detail: "博查密钥无效" };
				if (!response.ok) return { status: "failed", hits: [], detail: `博查返回 ${response.status}` };
				const body = (await response.json()) as Page & { data?: Page; code?: number | string };
				// 官方信封是 { code, data: { webPages } }；代理可能直接回 webPages。
				const values = body.data?.webPages?.value ?? body.webPages?.value ?? [];
				if (values.length === 0 && body.code !== undefined && body.code !== 200 && body.code !== 0)
					return { status: "failed", hits: [], detail: `博查错误 ${String(body.code)}` };
				const hits: SearchHit[] = [];
				for (const item of values.slice(0, LIMIT))
					if (item.url?.startsWith("http")) hits.push({ title: item.name ?? "", url: item.url });
				return { status: "ok", hits };
			} catch {
				return { status: "failed", hits: [], detail: "博查请求失败" };
			}
		},
	};
}

/**
 * Exa 官方 API（不经 agent-reach CLI）。
 * 契约：POST https://api.exa.ai/search，x-api-key 头，body {query,type,numResults}；
 * 响应 results[] 带 title/url。
 */
export function exaProvider(apiKey: string | undefined, options: { dailyLimit?: number | null } = {}): SearchProvider | null {
	if (!apiKey) return null;
	return {
		id: "exa-api",
		label: "Exa 官方 API",
		metered: true,
		dailyLimit: options.dailyLimit === undefined ? 100 : options.dailyLimit,
		async search(query) {
			try {
				const response = await fetch("https://api.exa.ai/search", {
					method: "POST",
					headers: { "x-api-key": apiKey, "content-type": "application/json" },
					body: JSON.stringify({ query, type: "auto", numResults: LIMIT }),
					signal: AbortSignal.timeout(15_000),
				});
				if (response.status === 429) return { status: "rate_limited", hits: [], detail: "Exa 限流或额度用完" };
				if (response.status === 401 || response.status === 403)
					return { status: "unavailable", hits: [], detail: "Exa 密钥无效" };
				if (!response.ok) return { status: "failed", hits: [], detail: `Exa 返回 ${response.status}` };
				const body = (await response.json()) as { results?: Array<{ title?: string; url?: string }> };
				const hits: SearchHit[] = [];
				for (const item of (body.results ?? []).slice(0, LIMIT))
					if (item.url?.startsWith("http")) hits.push({ title: item.title ?? "", url: item.url });
				return { status: "ok", hits };
			} catch {
				return { status: "failed", hits: [], detail: "Exa 请求失败" };
			}
		},
	};
}

/**
 * Tavily Search API（官方，付费，有免费额度）。
 * 契约：POST https://api.tavily.com/search，Authorization: Bearer，
 * body {query,max_results,search_depth}；响应 results[] 带 title/url。
 */
export function tavilyProvider(apiKey: string | undefined, options: { dailyLimit?: number | null } = {}): SearchProvider | null {
	if (!apiKey) return null;
	return {
		id: "tavily",
		label: "Tavily 搜索",
		metered: true,
		dailyLimit: options.dailyLimit === undefined ? 100 : options.dailyLimit,
		async search(query) {
			try {
				const response = await fetch("https://api.tavily.com/search", {
					method: "POST",
					headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
					body: JSON.stringify({ query, max_results: LIMIT, search_depth: "basic", include_raw_content: false }),
					signal: AbortSignal.timeout(15_000),
				});
				if (response.status === 429) return { status: "rate_limited", hits: [], detail: "Tavily 限流或额度用完" };
				if (response.status === 401 || response.status === 403)
					return { status: "unavailable", hits: [], detail: "Tavily 密钥无效" };
				if (!response.ok) return { status: "failed", hits: [], detail: `Tavily 返回 ${response.status}` };
				const body = (await response.json()) as { results?: Array<{ title?: string; url?: string }> };
				const hits: SearchHit[] = [];
				for (const item of (body.results ?? []).slice(0, LIMIT))
					if (item.url?.startsWith("http")) hits.push({ title: item.title ?? "", url: item.url });
				return { status: "ok", hits };
			} catch {
				return { status: "failed", hits: [], detail: "Tavily 请求失败" };
			}
		},
	};
}

/** 解析 SEARCH_DAILY_LIMITS（如 "bing:200,exa:50,serper:100"）。 */
export function parseDailyLimits(value: string | undefined): Record<string, number> {
	const limits: Record<string, number> = {};
	if (!value) return limits;
	for (const part of value.split(",")) {
		const [key, raw] = part.split(":").map((item) => item.trim());
		if (!key || !raw) continue;
		const limit = Number(raw);
		if (Number.isFinite(limit) && limit >= 0) limits[key] = limit;
	}
	return limits;
}

/**
 * 按环境变量组装搜索源：免费源（Bing → Exa）在前，付费源（Serper → Brave）在后。
 * 未配置密钥的付费源不注册，界面也就不会显示不存在的能力。
 */
export function providersFromEnvironment(env: Record<string, string | undefined>): SearchProvider[] {
	const limits = parseDailyLimits(env.SEARCH_DAILY_LIMITS);
	// 国内索引排在前面：中文企业名在百度/博查里命中率明显高于英文语义检索。
	const providers: SearchProvider[] = [];
	const baidu = baiduProvider(env.BAIDU_QIANFAN_API_KEY, { dailyLimit: limits.baidu ?? 100 });
	if (baidu) providers.push(baidu);
	const bocha = bochaProvider(env.BOCHA_API_KEY, { dailyLimit: limits.bocha ?? 100 });
	if (bocha) providers.push(bocha);
	providers.push(
		bingProvider({ dailyLimit: limits.bing ?? 200 }),
		agentReachProvider(env.AGENT_REACH_BIN, { dailyLimit: limits.exa ?? 50 }),
	);
	const serper = serperProvider(env.SERPER_API_KEY, { dailyLimit: limits.serper ?? 100 });
	if (serper) providers.push(serper);
	const brave = braveProvider(env.BRAVE_API_KEY, { dailyLimit: limits.brave ?? 100 });
	if (brave) providers.push(brave);
	const exa = exaProvider(env.EXA_API_KEY, { dailyLimit: limits["exa-api"] ?? 100 });
	if (exa) providers.push(exa);
	const tavily = tavilyProvider(env.TAVILY_API_KEY, { dailyLimit: limits.tavily ?? 100 });
	if (tavily) providers.push(tavily);
	return providers;
}
