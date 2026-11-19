// 用户自加企业站点（每用户任意企业）：补齐 #41 只有两家内置站点的边界。
// 与内置来源同一套纪律：只取列表页的标题与链接，robots 优先，失败不写入条目。
// 采集触发由调用方决定（添加时与手动刷新），不接入固定槽位调度。
import { createHash } from "node:crypto";
import { MAX_ITEMS, articleScore, filterListableItems, isListableItem, isListableTitle } from "./item-quality.js";
import {
	collectSitemapItems,
	findDataListAnchor,
	parseJsonListPayload,
	parseSitemapXml,
	searchFallbackItems,
	sitemapUrlsFromRobots,
} from "./user-source-fallbacks.js";
import { normalizeItemUrl } from "./sources.js";
import { parseRobots, robotsAllows, SourceFetcher } from "./source-service.js";
import type { Storage } from "./ports/storage.js";
import type { SourceItem, UserSource } from "./state/model.js";

const FETCH_LIMITS = { maxBytes: 512 * 1024, timeoutMs: 15_000 };
/**
 * 刷新冷却：一次刷新最多会发 robots + 列表页 + 探测候选 + 新闻入口 + 兜底若干请求，
 * 用户连点或脚本重复调用会对第三方站点造成持续压力。5 分钟内不重复采集同一站点。
 * 尚未实现“每日每站配额”，此处为当前边界（见开发指南「用户自加来源」）。
 */
const REFRESH_COOLDOWN_MS = 5 * 60_000;
/** 自动找列表页的常见路径兑底：单个候选页最多多打 6 个请求。 */
const COMMON_NEWS_PATHS = [
	"/news", "/news/index.html", "/xwzx/index.html", "/news/list.shtml",
	"/media/index.html", "/news/gh.htm",
] as const;
/** sitemapindex 只下钻一个子地图，避免一次刷新把整个站点的索引都拉下来。 */
const MAX_SITEMAP_CHILDREN = 1;

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

/** 从列表页 HTML 抽取站内文章链接与标题；只留像文章的条目（见 isListableItem）。 */
export function parseUserListPage(html: string, listUrl: string, host: string): Array<{ itemKey: string; title: string; itemUrl: string }> {
	const results = new Map<string, { itemKey: string; title: string; itemUrl: string; score: number }>();
	const anchor = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/giu;
	let match: RegExpExecArray | null;
	while ((match = anchor.exec(html)) && results.size < MAX_ITEMS * 3) {
		const href = match[2] ?? match[3] ?? match[4] ?? "";
		const text = clean((match[5] ?? "").replace(/<[^>]+>/gu, " "), 300).replace(/\s+/gu, " ").trim();
		if (!href) continue;
		const url = normalizeItemUrl(href, listUrl, [host]);
		if (!url || url === listUrl || url.replace(/\/$/, "") === listUrl.replace(/\/$/, "")) continue;
		if (!isListableItem(text, url)) continue;
		const score = articleScore(url, text);
		const previous = results.get(url);
		if (!previous || score > previous.score)
			results.set(url, { itemKey: url, title: text, itemUrl: url, score });
	}
	return [...results.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_ITEMS)
		.map(({ itemKey, title, itemUrl }) => ({ itemKey, title, itemUrl }));
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
		return (await this.list(ownerId))
			.map((s) => s.host)
			.filter((host): host is string => Boolean(host));
	}

	/** 取单个站点（发现任务用）；不存在返回 null。 */
	async get(sourceId: string): Promise<UserSource | null> {
		return this.storage.transaction((tx) => tx.userSources.get(sourceId));
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
				discoveryStartedAt: null,
				lastRefreshAt: null,
				lastOutcome: null,
				lastReason: null,
				status: "active",
			};
			await tx.userSources.put(source);
			return source;
		});
	}

	/**
	 * 只给企业名：先登记一个 discovering 站点并排队发现 job，立即返回。
	 * 发现与首次采集都在 worker 里做，登记请求不再被 80 秒的站点探测拖住。
	 */
	async beginDiscovery(
		ownerId: string,
		input: { label: string; subject: { kind: "brand" | "competitor"; name: string } },
		now: string,
	): Promise<UserSource> {
		const label = clean(input.label, 200);
		if (!label) throw new UserSourceError(400, "label_required", "请填写企业名称");
		const name = clean(input.subject.name, 200);
		if (!name) throw new UserSourceError(400, "name_required", "请填写关注对象名称");
		const kind = input.subject.kind === "competitor" ? "competitor" : "brand";
		const source: UserSource = {
			id: crypto.randomUUID(),
			ownerId,
			label,
			host: null,
			listUrl: null,
			subject: { kind, name },
			createdAt: now,
			discoveryStartedAt: now,
			lastRefreshAt: null,
			lastOutcome: null,
			lastReason: null,
			status: "discovering",
		};
		return this.storage.transaction(async (tx) => {
			const ownerSources = await tx.userSources.listByOwner(ownerId);
			const pending = ownerSources.find((s) => s.label === label && s.status === "discovering");
			if (pending) throw new UserSourceError(409, "discovery_pending", "这个企业正在查找官网，请稍候");
			await tx.userSources.put(source);
			// 幂等 job id：重复入队不会产生第二条发现任务。
			await tx.jobs.put({
				id: createHash("sha256").update(JSON.stringify(["discover_user_source", source.id])).digest("hex"),
				task: { kind: "discover_user_source", sourceId: source.id },
				status: "pending",
				runAt: now,
				attempts: 0,
			});
			return source;
		});
	}

	/** 发现成功：写回站点身份并把状态置为 active（host 已被本人占用时如实失败）。 */
	async finishDiscovery(
		sourceId: string,
		site: { host: string; listUrl: string },
		now: string,
	): Promise<UserSource> {
		return this.storage.transaction(async (tx) => {
			const source = await tx.userSources.get(sourceId);
			if (!source) throw new UserSourceError(404, "not_found", "站点不存在");
			if (source.status !== "discovering") return source;
			const ownerSources = await tx.userSources.listByOwner(source.ownerId);
			if (ownerSources.some((s) => s.id !== source.id && s.host === site.host))
				throw new UserSourceError(409, "host_exists", "这个网站已经添加过");
			const next: UserSource = {
				...source,
				host: site.host,
				listUrl: site.listUrl,
				status: "active",
				lastReason: null,
			};
			await tx.userSources.put(next);
			return next;
		});
	}

	/** 发现失败：留在列表里让用户看到原因，可删除后重试。 */
	async failDiscovery(sourceId: string, reason: string, now: string): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const source = await tx.userSources.get(sourceId);
			if (!source || source.status !== "discovering") return;
			await tx.userSources.put({
				...source,
				status: "failed",
				lastRefreshAt: now,
				lastOutcome: "failed",
				lastReason: reason,
			});
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
			/** 搜索回退（注入聚合器，便于测试与额度管控）；只取同域命中。 */
			searchFallback?: (query: string) => Promise<Array<{ title: string; url: string }>>;
		} = {},
	): Promise<UserSourceRefreshResult> {
		const source = await this.storage.transaction(async (tx) => {
			const found = await tx.userSources.get(sourceId);
			if (!found || found.ownerId !== ownerId)
				throw new UserSourceError(404, "not_found", "站点不存在");
			return found;
		});
		// 冷却在读取来源后立即判定：失败也计入，避免失败重试风暴。
		if (source.lastRefreshAt) {
			const elapsed = Date.parse(now) - Date.parse(source.lastRefreshAt);
			if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < REFRESH_COOLDOWN_MS)
				throw new UserSourceError(429, "refresh_too_soon", "同一站点 5 分钟内只采集一次，请稍后再试");
		}
		if (!source.host || !source.listUrl)
			throw new UserSourceError(409, "source_not_ready", "站点还在查找官网，稍后再试");
		const host = source.host;
		const listUrl = source.listUrl;
		const sourceKey = userSourceKey(sourceId);
		const failure = async (reason: string): Promise<UserSourceRefreshResult> => {
			await this.storage.transaction(async (tx) => {
				const current = await tx.userSources.get(sourceId);
				if (current)
					await tx.userSources.put({ ...current, lastRefreshAt: now, lastOutcome: "failed", lastReason: reason });
			});
			return { outcome: "failed", created: 0, updated: 0, reason };
		};

		// robots：2xx 遵从，4xx 视为无限制，5xx/不可达保守放弃。body 留作 sitemap 兜底。
		let robotsBody = "";
		try {
			const robots = await fetcher.fetchText(`https://${host}/robots.txt`, FETCH_LIMITS);
			if (robots.status >= 500)
				return await failure("robots 检查不可达，保守跳过本次采集");
			if (robots.status < 400) {
				robotsBody = robots.body;
				const path = new URL(listUrl).pathname;
				if (!robotsAllows(parseRobots(robots.body), path))
					return await failure("robots 不允许采集这个列表页");
			}
		} catch {
			return await failure("robots 检查失败，保守跳过本次采集");
		}

		let page;
		try {
			page = await fetcher.fetchText(listUrl, FETCH_LIMITS);
		} catch {
			return await failure("列表页抓取失败");
		}
		if (page.status >= 400) return await failure(`列表页返回 ${page.status}`);

		let resolvedListUrl = listUrl;
		// 兜底一级：同域 JSON 列表（实测 newsroom.json 这类数据接口）。零额外请求。
		let parsed: Array<{ itemKey: string; title: string; itemUrl: string; publishedAt?: string | null }> =
			parseUserListPage(page.body, resolvedListUrl, host);
		if (parsed.length === 0) parsed = parseJsonListPayload(page.body, resolvedListUrl, host);
		// 页面本身不是 JSON，但可能指向一个数据接口（实测海信 /cn/zh/newsroom.json）。至多 1 个请求。
		if (parsed.length === 0) {
			const dataListUrl = findDataListAnchor(page.body, resolvedListUrl, host);
			if (dataListUrl) {
				try {
					const dataPage = await fetcher.fetchText(dataListUrl, FETCH_LIMITS);
					if (dataPage.status < 400) {
						parsed = parseJsonListPayload(dataPage.body, dataListUrl, host);
						if (parsed.length > 0) resolvedListUrl = dataListUrl;
					}
				} catch {
					// 数据接口抓不到就继续后面的兜底。
				}
			}
		}
		// 列表页可能是 JS 渲染或选错了页面：条目过少也可疑，退回官网首页与常见新闻路径比一比，谁多用谁。
		if (parsed.length < 3) {
			const candidates = [`https://${host}/`, ...COMMON_NEWS_PATHS.map((path) => `https://${host}${path}`)]
				.filter((url) => url.replace(/\/+$/u, "") !== resolvedListUrl.replace(/\/+$/u, ""));
			for (const candidate of candidates) {
				try {
					const probe = await fetcher.fetchText(candidate, FETCH_LIMITS);
					if (probe.status >= 400) continue;
					const fromProbe = parseUserListPage(probe.body, candidate, host);
					if (fromProbe.length > parsed.length) {
						parsed = fromProbe;
						resolvedListUrl = candidate;
						if (parsed.length >= 3) break;
					}
					// 官网站内常有“新闻中心”入口：沿着它深入一层再试，比首页更能拿到文章列表。
					for (const entry of findNewsEntry(probe.body, candidate, host)) {
						if (entry === candidate) continue;
						try {
							const listPage = await fetcher.fetchText(entry, FETCH_LIMITS);
							if (listPage.status >= 400) continue;
							const fromList = parseUserListPage(listPage.body, entry, host);
							if (fromList.length > parsed.length) {
								parsed = fromList;
								resolvedListUrl = entry;
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
				const fromRead = await options.readFallback(resolvedListUrl);
				// 渲染读取同样要过文章规则：否则产品/导航页会被兑底重新拉回 20 条噪音。
				const filtered = fromRead ? filterListableItems(fromRead) : [];
				if (filtered.length > parsed.length) parsed = filtered;
			} catch {
				// 兑底失败（如限流）维持原结论，不冒充成功。
			}
		}
		// 兜底二级：sitemap（实测美的/九阳这类无新闻入口的站）。请求有上限。
		if (parsed.length === 0) {
			const origin = new URL(resolvedListUrl).origin;
			const candidates = [
				...sitemapUrlsFromRobots(robotsBody, origin),
				`${origin}/sitemap.xml`,
			].filter((url, index, all) => all.indexOf(url) === index).slice(0, 2);
			for (const sitemapUrl of candidates) {
				try {
					const map = await fetcher.fetchText(sitemapUrl, FETCH_LIMITS);
					if (map.status >= 400) continue;
					let { sitemaps, entries } = parseSitemapXml(map.body, sitemapUrl, host);
					for (const child of sitemaps.slice(0, MAX_SITEMAP_CHILDREN)) {
						if (entries.length > 0) break;
						try {
							const childPage = await fetcher.fetchText(child, FETCH_LIMITS);
							if (childPage.status >= 400) continue;
							({ entries } = parseSitemapXml(childPage.body, child, host));
						} catch {
							// 单个子地图失败继续。
						}
					}
					if (entries.length === 0) continue;
					// 标题缺失时按上限抓文章 <title>；拿不到就跳过，不编造标题。
					parsed = await collectSitemapItems(fetcher, host, entries);
					if (parsed.length > 0) break;
				} catch {
					// 单个站点地图失败继续。
				}
			}
		}
		// 兜底三级：站内搜索（标题+链接来自搜索结果）；每次刷新最多一次，受搜索额度约束。
		if (parsed.length === 0 && options.searchFallback) {
			try {
				const hits = await options.searchFallback(`${source.label} 新闻`);
				parsed = searchFallbackItems(hits, host);
			} catch {
				// 搜索失败或额度用尽都维持原结论，不冒充成功。
			}
		}
		if (parsed.length === 0)
			return await failure(
				"列表页、sitemap 与搜索都没有找到可用条目：该站可能需要 JS 渲染，或没有可访问的 HTML 列表页/JSON 接口；可直接填写具体的新闻列表页地址再试。",
			);

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
							publishedAt: entry.publishedAt ?? extractDate(entry.itemUrl, entry.title) ?? previous.publishedAt,
							lastSeenAt: now,
							titleUpdatedAt: previous.title === entry.title ? previous.titleUpdatedAt : now,
						}
					: {
							id,
							sourceKey,
							itemKey: entry.itemKey,
							title: entry.title,
							itemUrl: entry.itemUrl,
							publishedAt: entry.publishedAt ?? extractDate(entry.itemUrl, entry.title),
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
					// 探测后选到更好的页面时把纠正结果写回，避免每次刷新重复探测同一批候选。
					listUrl: resolvedListUrl,
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
