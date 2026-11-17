// 自动来源线索（#39 方案 A）：
// 采集到的公开列表条目只作为「待确认线索」出现在本人控制台，不自动建事件、不自动推送。
// 关联依据是 allowlist 里声明的「站点 → 主体」映射，不是标题或域名推断。
import { SOURCE_DEFINITIONS, SOURCE_KEYS } from "./sources.js";
import type { Storage, Transaction } from "./ports/storage.js";

export interface SourceLead {
	sourceKey: string;
	sourceLabel: string;
	/** 声明式主体：来源站点归属的关注对象，不含标题推断。 */
	subject: { kind: "brand" | "competitor"; name: string };
	itemId: string;
	title: string;
	url: string;
	publishedAt: string | null;
	firstSeenAt: string;
	lastSeenAt: string;
	/** 本人已录入同 URL 的事件时给出；不表示已采纳或已核验。 */
	convertedEventId?: string;
}

export interface SourceLeadSource {
	key: string;
	label: string;
	subject: { kind: "brand" | "competitor"; name: string };
	enabled: boolean;
}

export interface SourceLeadQuery {
	sourceKey?: string;
	limit?: number;
}

export class SourceLeadError extends Error {
	constructor(readonly reason: "invalid_query", message: string) {
		super(message);
		this.name = "SourceLeadError";
	}
}

/** 与采集侧 `normalizeItemUrl` 取向一致：https、无 query/hash、去尾斜杠。 */
function urlKey(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	url.protocol = "https:";
	url.search = "";
	url.hash = "";
	if (url.pathname.length > 1 && url.pathname.endsWith("/"))
		url.pathname = url.pathname.slice(0, -1);
	return url.toString();
}

export class SourceLeadService {
	constructor(private readonly storage: Storage) {}

	private async sourcesIn(tx: Transaction, ownerId: string): Promise<SourceLeadSource[]> {
		const settings = await tx.subscriptionSettings.get(ownerId);
		const enabled = new Set(settings?.sourceFeeds ?? []);
		return SOURCE_KEYS.map((key) => ({
			key,
			label: SOURCE_DEFINITIONS[key]!.label,
			subject: SOURCE_DEFINITIONS[key]!.subject,
			enabled: enabled.has(key),
		}));
	}

	/** 只返回本人已开启来源的线索；未开启即空，不做跨用户共享或猜测。 */
	async list(
		ownerId: string,
		query: SourceLeadQuery = {},
	): Promise<{ leads: SourceLead[]; sources: SourceLeadSource[] }> {
		const limit = query.limit ?? 20;
		if (!Number.isInteger(limit) || limit < 1 || limit > 50)
			throw new SourceLeadError("invalid_query", "limit must be between 1 and 50");
		return this.storage.transaction(async (tx) => {
			const sources = await this.sourcesIn(tx, ownerId);
			const enabled = new Set(sources.filter((source) => source.enabled).map((source) => source.key));
			if (query.sourceKey !== undefined && !enabled.has(query.sourceKey))
				throw new SourceLeadError("invalid_query", "source feed not enabled");
			if (enabled.size === 0) return { leads: [], sources };

			// 本人已录入同 URL 的事件：用于提示「已录入」，不据此判定采纳或核实。
			const converted = new Map<string, string>();
			for (const version of await tx.marketEventVersions.all()) {
				if (version.ownerId !== ownerId) continue;
				if (await isCurrentVersionIn(tx, ownerId, version.eventId, version.version)) {
					for (const source of version.input.sources) {
						const key = source.url ? urlKey(source.url) : null;
						if (key && !converted.has(key)) converted.set(key, version.eventId);
					}
				}
			}

			const wanted = query.sourceKey ? new Set([query.sourceKey]) : enabled;
			const leads = (await tx.sourceItems.all())
				.filter((item) => item.status === "active" && wanted.has(item.sourceKey))
				.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
				.slice(0, limit)
				.map((item): SourceLead => {
					const definition = SOURCE_DEFINITIONS[item.sourceKey];
					const eventId = converted.get(urlKey(item.itemUrl) ?? "");
					return {
						sourceKey: item.sourceKey,
						sourceLabel: definition?.label ?? item.sourceKey,
						subject: definition?.subject ?? { kind: "brand", name: item.sourceKey },
						itemId: item.id,
						title: item.title,
						url: item.itemUrl,
						publishedAt: item.publishedAt,
						firstSeenAt: item.firstSeenAt,
						lastSeenAt: item.lastSeenAt,
						...(eventId ? { convertedEventId: eventId } : {}),
					};
				});
			return { leads, sources };
		});
	}
}

/** 只把事件当前版本算作「已录入」，历史修订里的旧链接不冒充当前事实。 */
async function isCurrentVersionIn(
	tx: Transaction,
	ownerId: string,
	eventId: string,
	version: number,
): Promise<boolean> {
	const head = await tx.marketEvents.get(eventId);
	return Boolean(head && head.ownerId === ownerId && head.currentVersion === version);
}
