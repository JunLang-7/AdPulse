// 用户自加企业站点（每用户任意企业）：补齐 #41 只有两家内置站点的边界。
// 与内置来源同一套纪律：只取列表页的标题与链接，robots 优先，失败不写入条目。
// 采集触发由调用方决定（添加时与手动刷新），不接入固定槽位调度。
import { createHash } from "node:crypto";
import { normalizeItemUrl } from "./sources.js";
import { parseRobots, robotsAllows, SourceFetcher } from "./source-service.js";
import type { Storage } from "./ports/storage.js";
import type { SourceItem, UserSource } from "./state/model.js";

const MAX_ITEMS = 20;
const FETCH_LIMITS = { maxBytes: 512 * 1024, timeoutMs: 15_000 };
/** 自动找列表页的常见路径兑底：每个站点最多多打 6 个请求，都在每日配额内。 */
const COMMON_NEWS_PATHS = [
	"/news", "/news/index.html", "/xwzx/index.html", "/news/list.shtml",
	"/media/index.html", "/news/gh.htm",
] as const;
const MIN_TITLE = 8;
const NAV_NOISE = /^(首页|网站首页|新闻中心|更多|详情|查看更多|更多动态|浏览更多|read more|more|next|prev)$/i;

export interface UserSourceView extends UserSource {}

export interface UserSourceRefreshResult {
	outcome: "ok" | "failed";
	created: number;
	updated: number;
	reason: string | null;
}

export interface UserSourceInput {
	label: string;
	listUrl: string;
	subject: { kind: "brand" | "competitor"; name: string };
}

export class UserSourceError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const clean = (value: unknown, max: number): string =>
	typeof value === "string"
		? value
				.replace(/[\u0000-\u001f\u{e000}-\u{f8ff}]/gu, " ")
				.trim()
				.slice(0, max)
		: "";

/** 列表 URL 必须是 https 的站点页面；返回 host 供唯一性检查。 */
function parseListUrl(raw: string): { host: string; listUrl: string } {
	let url: URL;
	try {
		url = new URL(clean(raw, 2000));
	} catch {
		throw new UserSourceError(400, "invalid_url", "列表页地址不合法");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new UserSourceError(400, "invalid_url", "必须是站点地址");
	if (!url.host || url.username || url.password)
		throw new UserSourceError(400, "invalid_url", "必须是站点地址");
	url.hash = "";
	return { host: url.host.toLowerCase(), listUrl: url.toString() };
}

/** 从首页找“新闻中心”类入口（锚文本优先），最多返回两个候选列表页。 */
export function findNewsEntry(html: string, base: string, host: string): string[] {
	const found = new Map<string, number>();
	const anchor = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]{0,150}?)<\/a>/giu;
	let match: RegExpExecArray | null;
	while ((match = anchor.exec(html))) {
		const href = match[2] ?? match[3] ?? match[4] ?? "";
		const text = (match[5] ?? "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
		if (!href || href.startsWith("#") || href.startsWith("javascript")) continue;
		const score = (/news|xinwen|xwzx|press|media/iu.test(href) ? 2 : 0) + (/新闻中心|集团新闻|公司新闻|新闻报道|新闻|动态|资讯|媒体中心/iu.test(text) ? 3 : 0);
		if (score === 0) continue;
		const target = normalizeItemUrl(href, base, [host]);
		if (!target || target === base) continue;
		found.set(target, Math.max(found.get(target) ?? 0, score));
	}
	return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([url]) => url).slice(0, 2);
}

/** 从列表页 HTML 抽取站内文章链接与标题；只挑能当新闻标题用的锚文本。 */
export function parseUserListPage(html: string, listUrl: string, host: string): Array<{ itemKey: string; title: string; itemUrl: string }> {
	const results = new Map<string, { itemKey: string; title: string; itemUrl: string }>();
	const anchor = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/giu;
	let match: RegExpExecArray | null;
	while ((match = anchor.exec(html)) && results.size < MAX_ITEMS * 3) {
		const href = match[2] ?? match[3] ?? match[4] ?? "";
		const text = clean((match[5] ?? "").replace(/<[^>]+>/gu, " "), 300).replace(/\s+/gu, " ").trim();
		if (!href || text.length < MIN_TITLE || text.length > 200 || NAV_NOISE.test(text)) continue;
		const url = normalizeItemUrl(href, listUrl, [host]);
		if (!url || url === listUrl || url.replace(/\/$/, "") === listUrl.replace(/\/$/, "")) continue;
		const itemKey = url;
		if (!results.has(itemKey)) results.set(itemKey, { itemKey, title: text, itemUrl: url });
	}
	return [...results.values()].slice(0, MAX_ITEMS);
}

/** 从 URL 或标题里抽日期；抽不到就是未知，不编造。 */
export function extractDate(...candidates: string[]): string | null {
	for (const text of candidates) {
		const match = /(20\d{2})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})/.exec(text);
		if (!match) continue;
		const y = match[1];
		const m = match[2];
		const d = match[3];
		if (!y || !m || !d) continue;
		const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
		if (Number.isFinite(Date.parse(iso))) return iso;
	}
	return null;
}

const itemKeyHash = (sourceKey: string, itemKey: string): string =>
	createHash("sha256").update(`${sourceKey}:${itemKey}`).digest("hex").slice(0, 16);

export class UserSourceService {
	constructor(private readonly storage: Storage) {}

	async list(ownerId: string): Promise<UserSource[]> {
		const sources = await this.storage.transaction((tx) => tx.userSources.listByOwner(ownerId));
		return sources.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	/** 供 read-source 等扩展点取本人已登记的站点主机。 */
	async hostsOf(ownerId: string): Promise<string[]> {
		return (await this.list(ownerId)).map((s) => s.host);
	}

	async add(ownerId: string, input: UserSourceInput, now: string): Promise<UserSource> {
		const label = clean(input.label, 200);
		if (!label) throw new UserSourceError(400, "label_required", "请填写企业名称");
		const name = clean(input.subject.name, 200);
		if (!name) throw new UserSourceError(400, "name_required", "请填写关注对象名称");
		const kind = input.subject.kind === "competitor" ? "competitor" : "brand";
		const { host, listUrl } = parseListUrl(input.listUrl);
		return this.storage.transaction(async (tx) => {
			const existing = (await tx.userSources.listByOwner(ownerId)).find((s) => s.host === host);
			if (existing) throw new UserSourceError(409, "host_exists", "这个网站已经添加过");
			const source: UserSource = {
				id: crypto.randomUUID(),
				ownerId,
				label,
				host,
				listUrl,
				subject: { kind, name },
				createdAt: now,
				lastRefreshAt: null,
				lastOutcome: null,
				lastReason: null,
				status: "active",
			};
			await tx.userSources.put(source);
			return source;
		});
	}

	async remove(ownerId: string, sourceId: string): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const source = await tx.userSources.get(sourceId);
			if (!source || source.ownerId !== ownerId)
				throw new UserSourceError(404, "not_found", "站点不存在");
			await tx.userSources.delete(sourceId);
			for (const item of await tx.sourceItems.all())
				if (item.sourceKey === userSourceKey(sourceId)) await tx.sourceItems.delete(item.id);
		});
	}

	/** 立即采集一次列表页；网络请求在事务之外，只把结果写入事务。 */
	async refresh(
		ownerId: string,
		sourceId: string,
		fetcher: SourceFetcher,
		now: string,
		options: {
			readFallback?: (url: string) => Promise<Array<{ itemKey: string; title: string; itemUrl: string }> | null | undefined>;
		} = {},
	): Promise<UserSourceRefreshResult> {
		const source = await this.storage.transaction(async (tx) => {
			const found = await tx.userSources.get(sourceId);
			if (!found || found.ownerId !== ownerId)
				throw new UserSourceError(404, "not_found", "站点不存在");
			return found;
		});
		const sourceKey = userSourceKey(sourceId);
		const failure = async (reason: string): Promise<UserSourceRefreshResult> => {
			await this.storage.transaction(async (tx) => {
				const current = await tx.userSources.get(sourceId);
				if (current)
					await tx.userSources.put({ ...current, lastRefreshAt: now, lastOutcome: "failed", lastReason: reason });
			});
			return { outcome: "failed", created: 0, updated: 0, reason };
		};

		// robots：2xx 遵从，4xx 视为无限制，5xx/不可达保守放弃。
		try {
			const robots = await fetcher.fetchText(`https://${source.host}/robots.txt`, FETCH_LIMITS);
			if (robots.status >= 500)
				return await failure("robots 检查不可达，保守跳过本次采集");
			if (robots.status < 400) {
				const path = new URL(source.listUrl).pathname;
				if (!robotsAllows(parseRobots(robots.body), path))
					return await failure("robots 不允许采集这个列表页");
			}
		} catch {
			return await failure("robots 检查失败，保守跳过本次采集");
		}

		let page;
		try {
			page = await fetcher.fetchText(source.listUrl, FETCH_LIMITS);
		} catch {
			return await failure("列表页抓取失败");
		}
		if (page.status >= 400) return await failure(`列表页返回 ${page.status}`);

		let listUrl = source.listUrl;
		let parsed = parseUserListPage(page.body, listUrl, source.host);
		// 列表页可能是 JS 渲染或选错了页面：条目过少也可疑，退回官网首页与常见新闻路径比一比，谁多用谁。
		if (parsed.length < 3) {
			const candidates = [`https://${source.host}/`, ...COMMON_NEWS_PATHS.map((path) => `https://${source.host}${path}`)]
				.filter((url) => url.replace(/\/+$/u, "") !== listUrl.replace(/\/+$/u, ""));
			for (const candidate of candidates) {
				try {
					const probe = await fetcher.fetchText(candidate, FETCH_LIMITS);
					if (probe.status >= 400) continue;
					const fromProbe = parseUserListPage(probe.body, candidate, source.host);
					if (fromProbe.length > parsed.length) {
						parsed = fromProbe;
						listUrl = candidate;
						if (parsed.length >= 3) break;
					}
					// 官网站内常有“新闻中心”入口：沿着它深入一层再试，比首页更能拿到文章列表。
					for (const entry of findNewsEntry(probe.body, candidate, source.host)) {
						if (entry === candidate) continue;
						try {
							const listPage = await fetcher.fetchText(entry, FETCH_LIMITS);
							if (listPage.status >= 400) continue;
							const fromList = parseUserListPage(listPage.body, entry, source.host);
							if (fromList.length > parsed.length) {
								parsed = fromList;
								listUrl = entry;
								if (parsed.length >= 3) break;
							}
						} catch {
							// 单个入口失败继续下一个。
						}
					}
					if (parsed.length >= 3) break;
				} catch {
					// 单个探测失败不阻塞其余候选。
				}
			}
		}
		// 静态手段全部失败：交给注入的渲染读取兑底（jina 可渲染 JS 页），仍不行才报失败。
		if (parsed.length < 3 && options.readFallback) {
			try {
				const fromRead = await options.readFallback(listUrl);
				if (fromRead && fromRead.length > parsed.length) parsed = fromRead;
			} catch {
				// 兑底失败（如限流）维持原结论，不冒充成功。
			}
		}
		if (parsed.length === 0) return await failure("列表页没有解析出条目（可能是 JS 渲染站点）");

		const result = await this.storage.transaction(async (tx) => {
			const existing = new Map(
				(await tx.sourceItems.all())
					.filter((item) => item.sourceKey === sourceKey)
					.map((item) => [item.itemKey, item]),
			);
			let created = 0;
			let updated = 0;
			for (const entry of parsed) {
				const id = `${sourceKey}:${itemKeyHash(sourceKey, entry.itemKey)}`;
				const previous = existing.get(entry.itemKey);
				if (previous?.status === "purged") continue;
				const next: SourceItem = previous
					? {
							...previous,
							title: entry.title,
							itemUrl: entry.itemUrl,
							publishedAt: extractDate(entry.itemUrl, entry.title) ?? previous.publishedAt,
							lastSeenAt: now,
							titleUpdatedAt: previous.title === entry.title ? previous.titleUpdatedAt : now,
						}
					: {
							id,
							sourceKey,
							itemKey: entry.itemKey,
							title: entry.title,
							itemUrl: entry.itemUrl,
							publishedAt: extractDate(entry.itemUrl, entry.title),
							firstSeenAt: now,
							lastSeenAt: now,
							titleUpdatedAt: null,
							contentScope: "title_link_only",
							status: "active",
						};
				await tx.sourceItems.put(next);
				if (previous) updated += 1;
				else created += 1;
			}
			const current = await tx.userSources.get(sourceId);
			if (current)
				await tx.userSources.put({
					...current,
					lastRefreshAt: now,
					lastOutcome: "ok",
					lastReason: null,
				});
			return { outcome: "ok" as const, created, updated, reason: null };
		});
		return result;
	}
}

export function userSourceKey(sourceId: string): string {
	return `user:${sourceId}`;
}
