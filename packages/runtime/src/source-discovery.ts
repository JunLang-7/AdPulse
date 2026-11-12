import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { normalizeItemUrl, SOURCE_DEFINITIONS } from "@adpluse/core";

const TOPICS = new Map([
	["products", "新品发布 新产品上市"],
	["campaigns", "品牌活动 市场营销"],
]);
const WEICHAI_TOPICS = new Map([
	["products", "新品 发布"],
	["campaigns", "参展 展会 活动"],
]);
// The current news hub also publishes articles directly below news2, without a category.
const WEICHAI_NEWS_ARTICLE = /^\/group\/weichai\/cn\/media-hub\/news2\/\d{14,}\/index\.html$/;
const LIMIT = 5;
const REACH_ERRORS = new Set([
	"RATE_LIMITED", "PLATFORM_BLOCKED", "NEED_LOGIN", "NEED_SETUP", "TIMEOUT",
]);

type RunReach = (executable: string, args: string[]) => Promise<{
	stdout: string;
	exitCode: number;
}>;

const runReach: RunReach = async (executable, args) => {
	const profile = await mkdtemp(resolve(tmpdir(), "adpulse-reach-"));
	try {
		return await new Promise((done, reject) => {
			execFile(executable, args, {
				cwd: profile,
				env: {
					HOME: profile,
					USERPROFILE: profile,
					SystemRoot: process.env.SystemRoot,
					PYTHONNOUSERSITE: "1",
				},
				timeout: 20_000,
				maxBuffer: 256 * 1024,
				windowsHide: true,
			}, (error, stdout) => {
				const exitCode = error?.code ?? 0;
				if (typeof exitCode === "number" && !error?.signal) {
					done({ stdout, exitCode });
				} else {
					const reason = error?.killed ? "TIMEOUT" : "PROCESS_FAILED";
					reject(new Error(`Agent-Reach discovery failed (${reason})`));
				}
			});
		});
	} finally {
		await rm(profile, { recursive: true, force: true });
	}
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indexDate(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const date = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value)?.[1];
	if (!date || !Number.isFinite(Date.parse(value))) return null;
	if (new Date(date).toISOString().slice(0, 10) !== date) return null;
	return date <= new Date().toISOString().slice(0, 10) ? date : null;
}

/** Manual search results are index leads, separate from collected source items. */
export async function discoverSource(
	sourceKey: string,
	topic: string,
	executable: string | undefined,
	run: RunReach = runReach,
) {
	const source = SOURCE_DEFINITIONS[sourceKey];
	if (!source || (sourceKey !== "haier_news" && sourceKey !== "weichai_news"))
		throw new Error("discovery requires haier_news or weichai_news");
	const isWeichai = sourceKey === "weichai_news";
	const keywords = (isWeichai ? WEICHAI_TOPICS : TOPICS).get(topic);
	if (!keywords) throw new Error("discovery requires products or campaigns");
	if (!executable || !isAbsolute(executable))
		throw new Error("set AGENT_REACH_BIN to the absolute path of the pinned Agent-Reach executable");
	const site = isWeichai ? `${source.allowedHosts[0]}${new URL(".", source.listUrl).pathname}` : source.allowedHosts[0];
	const brand = isWeichai ? "潍柴" : source.label;
	const query = `site:${site} ${brand} ${keywords}`;
	const { stdout, exitCode } = await run(executable, [
		"web", "search", query, "--backend", "exa", "--limit", String(LIMIT), "--timeout", "12",
	]);
	let result: unknown;
	try {
		result = JSON.parse(stdout);
	} catch {
		throw new Error("Agent-Reach discovery returned invalid JSON");
	}
	if (!isRecord(result) || result.schema_version !== 1 ||
		result.channel !== "web" || result.action !== "search")
		throw new Error("Agent-Reach discovery returned an unsupported response");
	if (result.ok === false) {
		const code = isRecord(result.error) ? result.error.code : undefined;
		const reason = typeof code === "string" && REACH_ERRORS.has(code) ? code : "UPSTREAM_FAILED";
		throw new Error(`Agent-Reach discovery failed (${reason})`);
	}
	if (exitCode !== 0 || result.ok !== true || result.backend !== "exa" || !Array.isArray(result.items))
		throw new Error("Agent-Reach discovery returned an unsupported response");

	const candidates = new Map<string, { title: string; url: string; indexedPublishedAt: string | null }>();
	for (const item of result.items.slice(0, LIMIT)) {
		if (!isRecord(item) || typeof item.title !== "string" ||
			typeof item.url !== "string" || !URL.canParse(item.url)) continue;
		const title = item.title.trim();
		if (!title || title.length > 200 || /[\u0000-\u001f\u007f]/u.test(title)) continue;
		const target = new URL(item.url);
		const isArticle = source.pathPattern.test(target.pathname) ||
			(isWeichai && WEICHAI_NEWS_ARTICLE.test(target.pathname));
		if (target.protocol !== "https:" || target.username || target.password || target.port ||
			!isArticle) continue;
		const url = normalizeItemUrl(item.url, source.listUrl, source.allowedHosts);
		if (!url || candidates.has(url)) continue;
		candidates.set(url, { title, url, indexedPublishedAt: indexDate(item.published_at) });
	}
	return { sourceKey, topic, provider: "agent-reach/exa", verification: "unverified", candidates: [...candidates.values()] };
}
