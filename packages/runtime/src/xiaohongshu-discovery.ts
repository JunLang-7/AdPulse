import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const LIMIT = 10;
const REACH_ERRORS = new Set([
	"RATE_LIMITED", "PLATFORM_BLOCKED", "NEED_LOGIN", "NEED_SETUP", "TIMEOUT",
]);

export interface XiaohongshuNoteCandidate {
	title: string;
	url: string;
	author: string | null;
	indexedPublishedAt: string | null;
}

export type RunXiaohongshu = (executable: string, args: string[]) => Promise<{
	stdout: string;
	exitCode: number;
}>;

const runXiaohongshu: RunXiaohongshu = async (executable, args) => {
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
					reject(new Error(`Agent-Reach xiaohongshu discovery failed (${reason})`));
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

/** Xiaohongshu note search results are discovery leads, separate from collected source items. */
export async function discoverXiaohongshu(
	query: string,
	limit: number,
	executable: string | undefined,
	run: RunXiaohongshu = runXiaohongshu,
): Promise<XiaohongshuNoteCandidate[]> {
	if (!executable || !isAbsolute(executable))
		throw new Error("set AGENT_REACH_BIN to the absolute path of the pinned Agent-Reach executable");
	const clamped = !Number.isFinite(limit) || limit <= 0
		? 5
		: Math.min(LIMIT, Math.max(1, Math.trunc(limit)));
	const { stdout, exitCode } = await run(executable, [
		"xiaohongshu", "search", query, "--limit", String(clamped),
	]);
	let result: unknown;
	try {
		result = JSON.parse(stdout);
	} catch {
		throw new Error("Agent-Reach xiaohongshu discovery returned an unsupported response");
	}
	if (!isRecord(result) || result.schema_version !== 1 ||
		result.channel !== "xiaohongshu" || result.action !== "search")
		throw new Error("Agent-Reach xiaohongshu discovery returned an unsupported response");
	if (result.ok === false) {
		const code = isRecord(result.error) ? result.error.code : undefined;
		const reason = typeof code === "string" && REACH_ERRORS.has(code) ? code : "UPSTREAM_FAILED";
		throw new Error(`Agent-Reach xiaohongshu discovery failed (${reason})`);
	}
	if (exitCode !== 0 || result.ok !== true || !Array.isArray(result.items))
		throw new Error("Agent-Reach xiaohongshu discovery returned an unsupported response");

	const candidates = new Map<string, XiaohongshuNoteCandidate>();
	for (const item of result.items.slice(0, clamped)) {
		if (!isRecord(item) || typeof item.title !== "string" ||
			typeof item.url !== "string") continue;
		const title = item.title.trim();
		if (!title || title.length > 200 || /[\u0000-\u001f\u007f]/u.test(title)) continue;
		let target: URL;
		try {
			target = new URL(item.url);
		} catch {
			continue;
		}
		if (target.protocol !== "https:" || target.username || target.password ||
			!(target.hostname.endsWith("xiaohongshu.com") || target.hostname.endsWith("xhslink.com")))
			continue;
		if (candidates.has(item.url)) continue;
		const author = typeof item.author === "string" && item.author !== "" ? item.author : null;
		candidates.set(item.url, {
			title,
			url: item.url,
			author,
			indexedPublishedAt: indexDate(item.published_at),
		});
	}
	return [...candidates.values()];
}
