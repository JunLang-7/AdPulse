// 定时发现（#222）：每天 08:00（北京时间）对每个已登记企业官网跑一轮「站内索引」
// 搜索，新结果写入未核验线索并自动排初判 job——信号初判随定时采集持续运行，
// 不再依赖手动 discover。默认关闭（DISCOVERY_SCHEDULE_ENABLED=1 才启用）。
//
// 设计要点：
// - 搜索走共享聚合器：额度按日计入 searchQuotas、用完即停、失败退额；
// - 查询词带 site: 不保证聚合器只返回同域结果，入库前按登记 host 过滤，
//   站外链接不冒充该官网的线索；
// - 拿锁后重读站点状态与水位线再决定是否搜索：多实例同槽位只跑一次；
// - 写线索与排初判 job 的同一事务里确认站点仍属于本人、仍 active、host 未变，
//   搜索期间被删除或换站的站点不再产生新线索；
// - 重复 URL 由 DiscoveryLeadService.persist 的既有去重挡掉，不产生重复线索；
// - 不自动接受线索、不自动建事件、不推送未确认结论；
// - 水位线每轮必推进（含空轮/失败轮）：一天只试一次，避免逐 tick 重试烧额度，
//   与采集循环「失败也推进 lastRefreshAt、下个槽位再试」的语义一致；
// - 逐站隔离：单站任何一步（含水位线写入）失败只记录不上抛，不影响其他站点与后续 tick。
import {
	DiscoveryLeadService,
	isSlotPending,
	latestDueSlot,
	userSourceKey,
	type Storage,
	type UserSource,
} from "@adpluse/core";

const TICK_MS = 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
		if (signal.aborted) finish();
	});
}

/** 站外链接不算登记官网的线索：按登记 host 精确匹配，解析失败的 URL 一律丢弃。 */
function sameHost(raw: string, host: string): boolean {
	try {
		return new URL(raw).host === host;
	} catch {
		return false;
	}
}

export interface DiscoveryRunnerOptions {
	/** 未启用时循环立即返回：不发起任何搜索、不写任何线索。 */
	enabled?: boolean;
	tickMs?: number;
	now?: () => string;
	/** 搜索出口；生产用共享聚合器，测试注入假实现。启用时必须提供。 */
	search?: (query: string) => Promise<Array<{ title: string; url: string }>>;
	/** 单站失败时的记录出口（含水位线写入失败）；不提供则静默，逐站隔离不受影响。 */
	onRoundError?: (sourceId: string, error: unknown) => void;
}

export interface DiscoveryRoundOutcome {
	sourceId: string;
	/** ok=有新线索；empty=无新结果（含站外过滤/额度用尽）；failed=本轮抛错。 */
	status: "ok" | "empty" | "failed";
	discovered: number;
	created: number;
	skipped: number;
	reason?: string;
}

/**
 * 对单个站点跑一轮站内索引发现。
 * 搜索在事务外完成；入库复用 DiscoveryLeadService.persist（含去重与初判 job 排队），
 * 并在写入事务内确认站点未被删除/换站（guard 抛错即整体回滚）；
 * 无论成败都在 finally 里推进水位线。
 */
export async function runDiscoveryRound(
	storage: Storage,
	source: Pick<UserSource, "id" | "ownerId" | "subject"> & { host: string },
	search: NonNullable<DiscoveryRunnerOptions["search"]>,
	now: string,
): Promise<DiscoveryRoundOutcome> {
	const query = `site:${source.host} ${source.subject.name} 新闻`;
	let discovered = 0;
	let created = 0;
	let skipped = 0;
	let failure: string | undefined;
	try {
		const hits = await search(query);
		const candidates = hits
			.filter((hit) => sameHost(hit.url, source.host))
			.filter(
				(hit): hit is { title: string; url: string } =>
					typeof hit.title === "string" && hit.title.trim().length > 0 &&
					typeof hit.url === "string" && hit.url.length > 0,
			)
			.map((hit) => ({ title: hit.title, url: hit.url, indexedPublishedAt: null }));
		discovered = candidates.length;
		const leads = new DiscoveryLeadService(storage);
		const persisted = await leads.persist(
			source.ownerId,
			{
				sourceKey: userSourceKey(source.id),
				topic: "新闻",
				provider: "scheduled/site-index",
				query,
				subject: source.subject,
				candidates,
			},
			now,
			// 写入前确认站点仍是「拿锁时看到的那个站点」：搜索期间被删除、
			// 停用或换站，本轮线索不入库（P2 review）。
			async (tx) => {
				const current = await tx.userSources.get(source.id);
				if (
					!current ||
					current.ownerId !== source.ownerId ||
					current.status !== "active" ||
					current.host !== source.host
				)
					throw new Error("source removed or changed during discovery");
			},
		);
		created = persisted.created;
		skipped = persisted.skipped;
	} catch (error) {
		failure = error instanceof Error ? error.message : "站内索引发现失败";
	} finally {
		// 空轮/失败轮同样推进水位线：一轮只跑一次，额度不因重试被烧光。
		// 站点已被删除时 get 返回 null，自然不写；写入失败由循环逐站兜底。
		await storage.transaction(async (tx) => {
			const current = await tx.userSources.get(source.id);
			if (current) await tx.userSources.put({ ...current, lastDiscoveryRunAt: now });
		});
	}
	return {
		sourceId: source.id,
		status: failure ? "failed" : created > 0 ? "ok" : "empty",
		discovered,
		created,
		skipped,
		...(failure ? { reason: failure } : {}),
	};
}

/**
 * 单站点的一步：在独占锁内**重读**站点状态与水位线再决定是否搜索。
 * 拿锁前的快照可能已被另一实例推进（同槽位双实例只跑一次），也可能站点已删除/停用。
 * 返回 null 表示锁内复检后无需行动。
 */
export async function runDiscoveryStep(
	storage: Storage,
	sourceId: string,
	slot: string,
	search: NonNullable<DiscoveryRunnerOptions["search"]>,
	now: string,
): Promise<DiscoveryRoundOutcome | null> {
	const result = await storage.runExclusive(`discovery:${sourceId}`, async () => {
		const current = await storage.transaction(async (tx) => {
			const source = await tx.userSources.get(sourceId);
			if (!source || source.status !== "active" || !source.host) return null;
			return isSlotPending(source.lastDiscoveryRunAt ?? null, slot) ? source : null;
		});
		if (!current || !current.host) return null;
		// host 在本闭包内已判非空：显式窄化后传给 round。
		return runDiscoveryRound(storage, { ...current, host: current.host }, search, now);
	});
	// 未拿到锁：另一持有者正在处理该站点，本步让位即可。
	return result.acquired ? result.value : null;
}

/**
 * 常驻循环：每天 08:00（北京时间）槽位对每个 active 且已知 host 的本人站点跑一轮。
 * 重启只补当前槽位、不回放历史（latestDueSlot 既有语义）；逐站失败互不影响。
 */
export async function runDiscoveryLeads(
	storage: Storage,
	signal: AbortSignal,
	options: DiscoveryRunnerOptions = {},
): Promise<void> {
	if (options.enabled !== true) return;
	if (!options.search) throw new Error("scheduled discovery requires a search outlet");
	const now = options.now ?? (() => new Date().toISOString());
	const tickMs = options.tickMs ?? TICK_MS;
	const search = options.search;
	while (!signal.aborted) {
		const stamp = now();
		// 每日 08:00（北京时间）槽位；早于今日 08:00 时落到昨日槽位（补跑一次）。
		const slot = latestDueSlot(stamp, [8]);
		const sources = await storage.transaction((tx) => tx.userSources.all());
		for (const source of sources) {
			// 预过滤只为省一次锁：真正的判定在锁内重读后完成。
			if (source.status !== "active" || !source.host) continue;
			try {
				await runDiscoveryStep(storage, source.id, slot, search, stamp);
			} catch (error) {
				// 逐站隔离：单站任何一步（含水位线写入）失败只记录不上抛，
				// 不终止循环，其他站点与后续 tick 照常执行。
				options.onRoundError?.(source.id, error);
			}
		}
		await sleep(tickMs, signal);
	}
}
