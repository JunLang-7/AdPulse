// 企业名称 → 官网新闻列表页自动发现。
// 用 agent-reach（Exa 搜索）找候选官网，再在候选站内定位新闻列表页；
// 找不到就如实报错，不猜测、不编造地址。发现结果只用于登记，不自动采正文。
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { normalizeItemUrl } from "@adpluse/core";
import type { SourceFetcher } from "@adpluse/core";
import { HttpSourceFetcher } from "./source-fetch.js";

const LIMIT = 8;
/** 媒体聚合/门户/百科等不可能是企业官网，直接排除。 */
const NON_OFFICIAL_HOSTS =
	/baidu\.com|zhihu\.com|qq\.com|163\.com|126\.net|sohu\.com|sina\.com|douyin\.com|toutiao\.com|xinhuanet\.com|people\.com\.cn|wikipedia\.org|gov\.cn|tianyancha\.com|qcc\.com|maigoo\.com|csdn\.net|jianshu\.com|juejin\.cn|cnblogs\.com|36kr\.com|netease\.com|ifeng\.com|thepaper\.cn|cntv\.cn|chinanews\.com|ce\.cn|cctv\.com/i;
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

/** 从搜索结果里挑最像“该企业官网”的站点：官网声明优先，行业媒体降权；同 host 保留新闻 URL。 */
export function pickCompanySite(
	items: unknown,
): { host: string; listUrl: string; via: string } | null {
	const byHost = new Map<string, { host: string; listUrl: string; via: string; score: number }>();
	if (!Array.isArray(items)) return null;
	for (const raw of items) {
		if (!isRecord(raw) || typeof raw.url !== "string" || !URL.canParse(raw.url)) continue;
		let url: URL;
		try {
			url = new URL(raw.url);
		} catch {
			continue;
		}
		if (url.protocol !== "https:" || url.username || url.password || !url.host) continue;
		if (NON_OFFICIAL_HOSTS.test(url.host)) continue;
		const title = typeof raw.title === "string" ? raw.title : "";
		// 官网自述是强信号；行业媒体/聚合站的“新闻大全”是弱信号且常冒充官网。
		const officialTitle = /官方网站|官网|官方门户|official site/i.test(title) ? 3 : 0;
		const aggregatorTitle = /新闻大全|相关新闻|新闻信息|资讯大全/i.test(title) ? -2 : 0;
		const newsInUrl = NEWS_TOKEN.test(`${url.pathname}${url.hostname}`) ? 1 : 0;
		const score = officialTitle + aggregatorTitle + newsInUrl;
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
	const best = [...byHost.values()].sort((a, b) => b.score - a.score)[0];
	return best ? { host: best.host, listUrl: best.listUrl, via: best.via } : null;
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
 * 企业名称 → {host, listUrl}。依赖 AGENT_REACH_BIN 指向已核对的 agent-reach 可执行文件。
 * 结果未经核验，登记后由用户在来源列表里确认采集结果是否正确。
 */
export async function discoverCompanySite(
	name: string,
	executable: string | undefined,
	options: { runReach?: RunReach; fetcher?: SourceFetcher } = {},
): Promise<CompanySite> {
	const brand = name.replace(/\s+/gu, " ").trim();
	if (!brand) throw new Error("company name required");
	if (!executable || !isAbsolute(executable))
		throw new Error("set AGENT_REACH_BIN to the absolute path of the pinned Agent-Reach executable");
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
		const pick = pickCompanySite(result.items);
		if (!pick) throw new Error("site discovery found no usable official site");
		const fetcher = options.fetcher ?? new HttpSourceFetcher([pick.host]);
		const listUrl = await resolveNewsListPage(pick, fetcher);
		return { host: pick.host, listUrl, via: pick.via };
	} finally {
		await rm(profile, { recursive: true, force: true });
	}
}
