// 用户自加站点的定时采集：与内置来源共用 08/12/16/20 槽位。
// 每站点每次槽位最多一轮（robots + 列表页）；失败记录在来源状态上，下个槽位重试。
import { UserSourceService, isSlotPending, latestDueSlot, type SourceFetcher, type Storage } from "@adpluse/core";
import { UserSiteFetcher } from "./source-fetch.js";

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

/**
 * Polls every registered user source once per scheduled slot. Restarts catch
 * up on the current slot only; earlier missed slots are not replayed.
 */
export async function runUserSources(
	storage: Storage,
	signal: AbortSignal,
	options: {
		tickMs?: number;
		now?: () => string;
		fetcherFor?: (host: string) => SourceFetcher;
		readFallback?: ((url: string) => Promise<Array<{ itemKey: string; title: string; itemUrl: string }> | null | undefined>) | undefined;
		/** 换站回退：当前站点采不到内容时按企业名找备选站点。 */
		discoverSites?: (label: string) => Promise<Array<{ host: string; listUrl: string }>>;
	} = {},
): Promise<void> {
	const now = options.now ?? (() => new Date().toISOString());
	const tickMs = options.tickMs ?? TICK_MS;
	const service = new UserSourceService(storage);
	while (!signal.aborted) {
		const stamp = now();
		const slot = latestDueSlot(stamp);
		const sources = await storage.transaction((tx) => tx.userSources.all());
		for (const source of sources) {
			if (source.status !== "active" || !source.host || !source.listUrl) continue;
			if (!isSlotPending(source.lastRefreshAt, slot)) continue;
			try {
				const fetcher = options.fetcherFor?.(source.host) ?? new UserSiteFetcher([source.host]);
				await storage.runExclusive(`user-source:${source.id}`, () =>
					service.refresh(
						source.ownerId,
						source.id,
						fetcher,
						stamp,
						{
							...(options.readFallback ? { readFallback: options.readFallback } : {}),
							...(options.discoverSites && options.fetcherFor
								? { discoverSites: options.discoverSites, fetcherFor: options.fetcherFor }
								: {}),
						},
					),
				);
			} catch {
				// refresh 已把失败写进来源状态；这里只兜住意外异常，下个槽位自动重试。
			}
		}
		await sleep(tickMs, signal);
	}
}
