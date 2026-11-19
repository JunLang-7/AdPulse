// 具体搜索源实现：Bing RSS（免费）、agent-reach/Exa（免费但限流）、
// Serper 与 Brave（付费 API，按环境变量密钥启用）。
// 所有源都只返回「标题 + URL」，不把正文当结果搬运。
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
						`https://www.bing.com/search?q=${encodeURIComponent(variant)}&format=rss&setlang=zh-cn`,
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
	const providers: SearchProvider[] = [
		bingProvider({ dailyLimit: limits.bing ?? 200 }),
		agentReachProvider(env.AGENT_REACH_BIN, { dailyLimit: limits.exa ?? 50 }),
	];
	const serper = serperProvider(env.SERPER_API_KEY, { dailyLimit: limits.serper ?? 100 });
	if (serper) providers.push(serper);
	const brave = braveProvider(env.BRAVE_API_KEY, { dailyLimit: limits.brave ?? 100 });
	if (brave) providers.push(brave);
	// 付费源已配置时，让付费源以更高优先级兜底：插到免费源之后（保持顺序即可）。
	return providers;
}
