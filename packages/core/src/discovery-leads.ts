// 主动发现线索（discovery-lead-intake）：discover 命令结果的暂存与人工核对。
// 纪律：发现结果一律 `unverified`，不直接入库、不直接推送；接受才生成 source item，
// 拒绝后同一归一化 URL 不再重复出现。审核审计记录在线索行上，可查询。
import { createHash } from "node:crypto";
import type { Storage } from "./ports/storage.js";
import type { DiscoveryLead, DiscoveryLeadStatus, SourceItem } from "./state/model.js";

export interface DiscoveryCandidateInput {
	title: string;
	url: string;
	indexedPublishedAt: string | null;
	author?: string | null;
}

export interface DiscoveryLeadInput {
	sourceKey: string;
	topic: string;
	provider: "agent-reach/exa" | "agent-reach/xiaohongshu";
	query: string;
	subject: { kind: "brand" | "competitor"; name: string } | null;
	candidates: DiscoveryCandidateInput[];
}

export interface DiscoveryLeadQuery {
	status?: DiscoveryLeadStatus;
	limit?: number;
}

export interface PersistDiscoveryResult {
	created: number;
	skipped: number;
}

export class DiscoveryLeadError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "DiscoveryLeadError";
	}
}

/** 与采集侧 `normalizeItemUrl` 取向一致：https、去 query/hash、去尾斜杠。 */
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
	url.username = "";
	url.password = "";
	if (url.pathname.length > 1 && url.pathname.endsWith("/"))
		url.pathname = url.pathname.slice(0, -1);
	return url.toString();
}

const itemKeyHash = (sourceKey: string, dedupKey: string): string =>
	createHash("sha256").update(`${sourceKey}:${dedupKey}`).digest("hex").slice(0, 16);

const clean = (value: unknown, max: number): string =>
	typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";

export class DiscoveryLeadService {
	constructor(private readonly storage: Storage) {}

	/**
	 * 暂存发现候选：URL 归一化后与本人历史线索及现有 source items 比对去重。
	 * 已存在（含拒绝过）的 URL 一律跳过，不覆盖、不复活。
	 */
	async persist(
		ownerId: string,
		input: DiscoveryLeadInput,
		now: string,
	): Promise<PersistDiscoveryResult> {
		const query = clean(input.query, 2000);
		const subject = input.subject
			? {
					kind: input.subject.kind === "competitor" ? "competitor" as const : "brand" as const,
					name: clean(input.subject.name, 200),
				}
			: null;
		if (subject && !subject.name) throw new DiscoveryLeadError(400, "subject_required", "关注对象名称不能为空");

		return this.storage.transaction(async (tx) => {
			const known = new Set(
				(await tx.discoveryLeads.listByOwner(ownerId)).map((lead) => lead.dedupKey),
			);
			const collected = new Set(
				(await tx.sourceItems.all())
					.map((item) => urlKey(item.itemUrl))
					.filter((key): key is string => key !== null),
			);
			let created = 0;
			let skipped = 0;
			for (const candidate of input.candidates) {
				const key = urlKey(candidate.url);
				if (!key || known.has(key) || collected.has(key)) {
					skipped += 1;
					continue;
				}
				const lead: DiscoveryLead = {
					id: crypto.randomUUID(),
					ownerId,
					sourceKey: input.sourceKey,
					topic: clean(input.topic, 200),
					provider: input.provider,
					query,
					subject,
					title: clean(candidate.title, 200),
					url: candidate.url,
					dedupKey: key,
					author: candidate.author ? clean(candidate.author, 200) || null : null,
					indexedPublishedAt: candidate.indexedPublishedAt,
					verification: "unverified",
					status: "pending",
					discoveredAt: now,
					reviewedAt: null,
					reviewedBy: null,
					reviewReason: null,
					convertedItemId: null,
				};
				if (!lead.title)
					throw new DiscoveryLeadError(400, "title_required", "线索标题不能为空");
				await tx.discoveryLeads.put(lead);
				known.add(key);
				created += 1;
			}
			return { created, skipped };
		});
	}

	/** 按本人范围列出线索；默认全部，可按状态过滤，按发现时间倒序。 */
	async list(ownerId: string, query: DiscoveryLeadQuery = {}): Promise<DiscoveryLead[]> {
		const limit = query.limit ?? 200;
		if (!Number.isInteger(limit) || limit < 1 || limit > 500)
			throw new DiscoveryLeadError(400, "invalid_limit", "limit must be between 1 and 500");
		return this.storage.transaction(async (tx) => {
			const leads = (await tx.discoveryLeads.listByOwner(ownerId))
				.sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt) || b.id.localeCompare(a.id));
			const filtered = query.status ? leads.filter((lead) => lead.status === query.status) : leads;
			return filtered.slice(0, limit);
		});
	}

	/**
	 * 接受：人工确认标题/日期后生成 source item（复用 #41 条目身份）。
	 * 可修正发布日期；未修正时沿用索引日期（仍标记 unverified 来源）。
	 */
	async accept(
		ownerId: string,
		leadId: string,
		review: { operator: string; correctedPublishedAt?: string | null },
		now: string,
	): Promise<DiscoveryLead> {
		return this.storage.transaction(async (tx) => {
			const lead = await this.requireReviewable(tx.discoveryLeads.get(leadId), ownerId);
			const itemId = `${lead.sourceKey}:${itemKeyHash(lead.sourceKey, lead.dedupKey)}`;
			const previous = await tx.sourceItems.get(itemId);
			if (previous?.status === "purged") {
				throw new DiscoveryLeadError(409, "purged", "该链接此前已被清理，不能重新入库");
			}
			const item: SourceItem = {
				id: itemId,
				sourceKey: lead.sourceKey,
				itemKey: lead.dedupKey,
				title: lead.title,
				itemUrl: lead.url,
				publishedAt: review.correctedPublishedAt ?? lead.indexedPublishedAt,
				firstSeenAt: previous?.firstSeenAt ?? lead.discoveredAt,
				lastSeenAt: now,
				titleUpdatedAt: null,
				contentScope: "title_link_only",
				status: "active",
			};
			await tx.sourceItems.put(item);
			const updated: DiscoveryLead = {
				...lead,
				status: "accepted",
				reviewedAt: now,
				reviewedBy: clean(review.operator, 200),
				reviewReason: null,
				convertedItemId: itemId,
			};
			await tx.discoveryLeads.put(updated);
			return updated;
		});
	}

	/** 拒绝：记录操作人与理由；同一 URL 不再重复出现（保留在 leads 表内参与去重）。 */
	async reject(
		ownerId: string,
		leadId: string,
		review: { operator: string; reason?: string },
		now: string,
	): Promise<DiscoveryLead> {
		return this.storage.transaction(async (tx) => {
			const lead = await this.requireReviewable(tx.discoveryLeads.get(leadId), ownerId);
			const updated: DiscoveryLead = {
				...lead,
				status: "rejected",
				reviewedAt: now,
				reviewedBy: clean(review.operator, 200),
				reviewReason: clean(review.reason ?? "", 1000) || null,
			};
			await tx.discoveryLeads.put(updated);
			return updated;
		});
	}

	/** 保留供查：既不接受也不拒绝，后续可再次处理。 */
	async keep(
		ownerId: string,
		leadId: string,
		review: { operator: string },
		now: string,
	): Promise<DiscoveryLead> {
		return this.storage.transaction(async (tx) => {
			const lead = await this.requireReviewable(tx.discoveryLeads.get(leadId), ownerId);
			const updated: DiscoveryLead = {
				...lead,
				status: "kept",
				reviewedAt: now,
				reviewedBy: clean(review.operator, 200),
			};
			await tx.discoveryLeads.put(updated);
			return updated;
		});
	}

	private async requireReviewable(
		lead: Promise<DiscoveryLead | null>,
		ownerId: string,
	): Promise<DiscoveryLead> {
		const found = await lead;
		if (!found || found.ownerId !== ownerId)
			throw new DiscoveryLeadError(404, "not_found", "线索不存在");
		if (found.status !== "pending" && found.status !== "kept")
			throw new DiscoveryLeadError(409, "already_reviewed", "线索已处理");
		return found;
	}
}
