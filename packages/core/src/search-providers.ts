// 搜索源聚合与额度管控。
// 设计要点：
// - 每个搜索源独立记额度（按自然日），用完即停，不静默降级；
// - 调用方拿到每个源的明确状态，界面要如实告诉用户「哪个源今天没额度了、什么时候恢复」；
// - 免费源优先、付费源兜底，额度耗尽时不假装成功。
import type { Storage } from "./ports/storage.js";
import type { SearchQuota } from "./state/model.js";

export interface SearchHit {
	title: string;
	url: string;
}

export type SearchProviderStatus =
	| "ok"
	| "quota_exhausted"
	| "rate_limited"
	| "unavailable"
	| "failed"
	| "skipped";

export interface SearchProviderOutcome {
	provider: string;
	label: string;
	metered: boolean;
	status: SearchProviderStatus;
	hits: SearchHit[];
	/** 面向用户的说明：额度用完到哪天、限流等；不含密钥或内部细节。 */
	detail: string | null;
}

export interface SearchProvider {
	id: string;
	label: string;
	/** 付费/有限额度的源为 true，界面要提示剩余额度。 */
	metered: boolean;
	/** 该源每日调用上限；null 表示不计量。 */
	dailyLimit: number | null;
	search(query: string): Promise<{ status: Exclude<SearchProviderStatus, "quota_exhausted" | "skipped">; hits: SearchHit[]; detail?: string | null }>;
}

export interface SearchQuotaView {
	provider: string;
	label: string;
	metered: boolean;
	dailyLimit: number | null;
	used: number;
	remaining: number | null;
	exhausted: boolean;
	/** 北京时间自然日，quota 的计量周期。 */
	day: string;
	detail: string | null;
}

export interface AggregatedSearch {
	hits: SearchHit[];
	providers: SearchProviderOutcome[];
	/** 是否有源因额度用完被跳过。 */
	anyQuotaExhausted: boolean;
}

/** 北京时间自然日（额度按此计周期）。 */
export function quotaDay(at: Date): string {
	return new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

const quotaId = (provider: string, day: string): string => `${provider}:${day}`;

/**
 * 按优先级依次调用搜索源，命中足够结果后短路。
 * 额度耗尽的源直接跳过并记录，不发起请求、不伪造结果。
 */
export class SearchAggregator {
	constructor(
		private readonly storage: Storage,
		private readonly providers: SearchProvider[],
		private readonly options: { now?: () => Date; enoughHits?: number } = {},
	) {}

	private now(): Date {
		return this.options.now?.() ?? new Date();
	}

	/** 各源今日额度状态，供界面展示；不发起任何搜索请求。 */
	async quotas(): Promise<SearchQuotaView[]> {
		const day = quotaDay(this.now());
		return this.storage.transaction(async (tx) => {
			const views: SearchQuotaView[] = [];
			for (const provider of this.providers) {
				const record = await tx.searchQuotas.get(quotaId(provider.id, day));
				const used = record?.used ?? 0;
				const exhausted = provider.dailyLimit !== null && used >= provider.dailyLimit;
				views.push({
					provider: provider.id,
					label: provider.label,
					metered: provider.metered,
					dailyLimit: provider.dailyLimit,
					used,
					remaining: provider.dailyLimit === null ? null : Math.max(0, provider.dailyLimit - used),
					exhausted,
					day,
					detail: exhausted
						? `今日额度已用完（${used}/${provider.dailyLimit}），次日 00:00（北京时间）恢复`
						: null,
				});
			}
			return views;
		});
	}

	/** 扣一次额度；返回 false 表示今日已用完（调用方必须停）。 */
	private async consume(provider: SearchProvider): Promise<boolean> {
		if (provider.dailyLimit === null) return true;
		const day = quotaDay(this.now());
		const id = quotaId(provider.id, day);
		return this.storage.transaction(async (tx) => {
			const record = await tx.searchQuotas.get(id);
			const used = record?.used ?? 0;
			if (used >= provider.dailyLimit!) return false;
			const next: SearchQuota = {
				id,
				provider: provider.id,
				day,
				used: used + 1,
				dailyLimit: provider.dailyLimit!,
				updatedAt: this.now().toISOString(),
			};
			await tx.searchQuotas.put(next);
			return true;
		});
	}

	/** 退还一次额度：源调用失败（网络错/上游挂）时不应计费。 */
	private async refund(provider: SearchProvider): Promise<void> {
		if (provider.dailyLimit === null) return;
		const day = quotaDay(this.now());
		const id = quotaId(provider.id, day);
		await this.storage.transaction(async (tx) => {
			const record = await tx.searchQuotas.get(id);
			if (!record || record.used <= 0) return;
			await tx.searchQuotas.put({ ...record, used: record.used - 1, updatedAt: this.now().toISOString() });
		});
	}

	/**
	 * 搜索并聚合各源结果。`overrides.enoughHits` 可按次提高短路门槛：
	 * 「找官网」这类质量敏感场景免费源的结果可能是垃圾（实测 Bing 返回 8 条商城/字典站
	 * 导致付费源永远不被咨询），此时传 Infinity 让全部已配置源都参与，代价是消耗付费额度。
	 */
	async search(query: string, overrides: { enoughHits?: number } = {}): Promise<AggregatedSearch> {
		const enough = overrides.enoughHits ?? this.options.enoughHits ?? 8;
		const hits = new Map<string, SearchHit>();
		const outcomes: SearchProviderOutcome[] = [];
		for (const provider of this.providers) {
			if (hits.size >= enough) {
				outcomes.push({
					provider: provider.id,
					label: provider.label,
					metered: provider.metered,
					status: "skipped",
					hits: [],
					detail: "已有足够结果，未调用",
				});
				continue;
			}
			const allowed = await this.consume(provider);
			if (!allowed) {
				outcomes.push({
					provider: provider.id,
					label: provider.label,
					metered: provider.metered,
					status: "quota_exhausted",
					hits: [],
					detail: `今日额度已用完（${provider.dailyLimit} 次/日），次日 00:00（北京时间）恢复`,
				});
				continue;
			}
			try {
				const result = await provider.search(query);
				// 上游失败/不可用/限流时未提供价值，退额度；只有真正返回结果才算一次消耗。
				if (result.status === "failed" || result.status === "unavailable" || result.status === "rate_limited")
					await this.refund(provider);
				const fresh = result.hits.filter((hit) => !hits.has(hit.url));
				for (const hit of fresh) hits.set(hit.url, hit);
				outcomes.push({
					provider: provider.id,
					label: provider.label,
					metered: provider.metered,
					status: result.status,
					hits: fresh,
					detail: result.detail ?? null,
				});
			} catch (error) {
				// 调用失败不应当计费：付费源白扣额度会让用户真的白花钱。
				await this.refund(provider);
				outcomes.push({
					provider: provider.id,
					label: provider.label,
					metered: provider.metered,
					status: "failed",
					hits: [],
					detail: error instanceof Error ? error.message.slice(0, 200) : "搜索失败",
				});
			}
		}
		return {
			hits: [...hits.values()],
			providers: outcomes,
			anyQuotaExhausted: outcomes.some((outcome) => outcome.status === "quota_exhausted"),
		};
	}
}
