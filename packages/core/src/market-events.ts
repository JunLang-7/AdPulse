import { createHash } from "node:crypto";
import { activeEventHeadIn, eventActiveIn, eventLifecycleIn, type EventLifecycle } from "./event-lifecycle.js";
import { NotificationSelectionService } from "./notifications-selection.js";
import type { Storage, Transaction } from "./ports/storage.js";

export interface EventSourceInput {
	url: string | null;
	publisher: string;
	content: string | null;
	scope: "link_only" | "title_only" | "search_snippet" | "excerpt" | "full_text";
	origin: "official" | "repost" | "search" | "unknown";
	publishedAt: string | null;
	acquiredAt: string;
	limitations: string;
}
export interface EventCitation { sourceIndex: number; quote: string }
export interface MarketEventInput {
	/** Same subject, type and occurrence key identify one event within one owner. */
	occurrenceKey: string;
	title: string;
	type: "announcement" | "campaign" | "product_launch";
	subject: { kind: "brand" | "competitor"; name: string };
	eventTime: string | null;
	conditions: string | null;
	sources: EventSourceInput[];
	citations: { subject: EventCitation | null; eventTime: EventCitation | null; conditions: EventCitation | null };
	/** A declared task relationship, never an inferred causal effect. */
	taskRefs: Array<{ taskId: string; taskVersion: number; reason: string }>;
	provenance: { simulated: boolean; reference: string | null; transformation: string | null };
}
export interface MarketEventHead {
	id: string;
	ownerId: string;
	logicalKey: string;
	currentVersion: number;
	createdAt: string;
}
export interface MarketEventVersion {
	id: string;
	eventId: string;
	ownerId: string;
	version: number;
	/** Editorial or relationship edits do not become new evidence. */
	evidenceRevision: number;
	input: MarketEventInput;
	method: "manual" | "source_item";
	sourceItemId: string | null;
	materials: Array<{ id: string; method: "manual" | "source_item"; sourceItemId: string | null }>;
	createdAt: string;
	changeReason: string;
	candidate: { status: "evidence_ready" | "insufficient"; reasons: string[] };
}
export interface MarketEventAlias { id: string; ownerId: string; eventId: string }
export interface MarketEventOperation {
	id: string; ownerId: string; digest: string; versionId: string; createdAt: string;
	status: "created" | "duplicate" | "revised" | "unchanged";
}
export class MarketEventError extends Error {
	constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}
const fail = (message: string): never => { throw new MarketEventError(400, message); };
const normalize = (s: string) => s.normalize("NFKC").trim().toLocaleLowerCase("en-US");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) =>
	v && typeof v === "object" && !Array.isArray(v)
		? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const text = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max;
function safeUrl(value: string): string {
	let url: URL;
	try { url = new URL(value); } catch { return fail("invalid source URL"); }
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || value.length > 2000)
		return fail("invalid source URL");
	url.hash = "";
	return url.toString();
}
function validDate(value: unknown, dateOnly = false): boolean {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value))
		return dateOnly && new Date(value).toISOString().startsWith(value);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
	const day = value.slice(0, 10);
	return new Date(day).toISOString().startsWith(day);
}
function validate(input: MarketEventInput): void {
	if (!input || !text(input.occurrenceKey, 200) || !text(input.title, 200) ||
		!["announcement", "campaign", "product_launch"].includes(input.type) ||
		!input.subject || !["brand", "competitor"].includes(input.subject.kind) || !text(input.subject.name, 200)) fail("invalid event identity");
	for (const value of [input.eventTime, input.conditions])
		if (value !== null && !text(value, 2000)) fail("invalid event fact");
	if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 10) fail("invalid sources");
	for (const source of input.sources) {
		if (!source || !text(source.publisher, 200) || !["link_only", "title_only", "search_snippet", "excerpt", "full_text"].includes(source.scope) ||
			!["official", "repost", "search", "unknown"].includes(source.origin) ||
			typeof source.limitations !== "string" || source.limitations.length > 2000 ||
			!validDate(source.acquiredAt) ||
			(source.publishedAt !== null && !validDate(source.publishedAt, true))) fail("invalid source metadata");
		if (source.url !== null) safeUrl(source.url);
		if (source.content !== null && !text(source.content, 30000)) fail("invalid source content");
		if (source.scope === "link_only" && (source.content !== null || !source.url)) fail("link-only material requires URL and no content");
		if (source.scope !== "link_only" && source.content === null) fail("content scope requires content");
		if (source.origin === "search" && !["search_snippet", "title_only", "link_only"].includes(source.scope)) fail("search results are not body text");
	}
	if (!input.citations) fail("citations required");
	for (const field of ["subject", "eventTime", "conditions"] as const) {
		const citation = input.citations[field];
		if (citation === null) continue;
		if (!citation || !Number.isSafeInteger(citation.sourceIndex) || citation.sourceIndex < 0 || !text(citation.quote, 2000)) fail("invalid citation");
		const source = input.sources[citation.sourceIndex];
		if (!source?.content?.includes(citation.quote)) fail("citation not found in material");
		if (field !== "subject" && input[field] === null) fail("citation for unknown fact");
	}
	if (!Array.isArray(input.taskRefs) || input.taskRefs.length > 20 || new Set(input.taskRefs.map(r => r.taskId)).size !== input.taskRefs.length) fail("invalid task references");
	for (const ref of input.taskRefs)
		if (!text(ref.taskId, 128) || !Number.isSafeInteger(ref.taskVersion) || ref.taskVersion < 1 || !text(ref.reason, 1000)) fail("invalid task reference");
	if (!input.provenance || typeof input.provenance.simulated !== "boolean") fail("provenance required");
	for (const value of [input.provenance.reference, input.provenance.transformation])
		if (value !== null && !text(value, 2000)) fail("invalid provenance");
	if (input.provenance.simulated && (!input.provenance.reference || !input.provenance.transformation)) fail("simulation requires source and transformation");
}
function assess(input: MarketEventInput): MarketEventVersion["candidate"] {
	const reasons: string[] = [];
	for (const field of ["subject", "eventTime", "conditions"] as const) {
		const citation = input.citations[field];
		const source = citation && input.sources[citation.sourceIndex];
		if (!source || source.origin !== "official" || !["excerpt", "full_text"].includes(source.scope) || !source.url)
			reasons.push(`${field}: 缺少官方原文引用（来源性质由录入者声明，尚未经独立核验）`);
	}
	if (input.eventTime === null) reasons.push("事件时间未知");
	if (input.conditions === null) reasons.push("适用条件未知");
	if (input.sources.every(source => source.publishedAt === null)) reasons.push("发布时间未知");
	if (input.provenance.simulated) reasons.push("合成样例，仅供测试");
	return { status: reasons.length ? "insufficient" : "evidence_ready", reasons };
}
const evidenceHash = (input: MarketEventInput) => hash({
	sources: input.sources.map(({ acquiredAt: _acquiredAt, ...source }) => source),
	subject: input.subject, type: input.type, citations: input.citations, eventTime: input.eventTime, conditions: input.conditions, provenance: input.provenance,
});

/** Private materials never leave this owner scope. No fetching or Session side effects. */
export class MarketEventService {
	private readonly selections: NotificationSelectionService;
	constructor(private storage: Storage, private now: () => string = () => new Date().toISOString()) {
		this.selections = new NotificationSelectionService(storage, now);
	}
	async list(ownerId: string): Promise<MarketEventVersion[]> {
		const now = new Date(this.now());
		return this.storage.transaction(async tx => {
			const heads = (await tx.marketEvents.all()).filter(h => h.ownerId === ownerId);
			const active = [];
			for (const head of heads) {
				// 到期即限访：到期事件不进列表，也不靠前端隐藏。
				if (await eventLifecycleIn(tx, head, now).then(lifecycle => lifecycle.expired)) continue;
				const version = await tx.marketEventVersions.get(`${head.id}:${head.currentVersion}`);
				if (version) active.push(version);
			}
			return active.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
		});
	}

	/** 到期判定查询：到期事件仍返回状态，便于解释「为什么打不开」。 */
	async lifecycle(ownerId: string, eventId: string): Promise<EventLifecycle | null> {
		const now = new Date(this.now());
		return this.storage.transaction(async tx => {
			const head = await tx.marketEvents.get(eventId);
			if (!head || head.ownerId !== ownerId) return null;
			return eventLifecycleIn(tx, head, now);
		});
	}
	async detail(ownerId: string, eventId: string): Promise<{ current: MarketEventVersion; versions: MarketEventVersion[] } | null> {
		const now = new Date(this.now());
		return this.storage.transaction(async tx => {
			// 到期事件按「不可访问」处理，与任务侧一致。
			const head = await activeEventHeadIn(tx, ownerId, eventId, now);
			if (!head) return null;
			const versions = (await tx.marketEventVersions.all()).filter(v => v.eventId === eventId && v.ownerId === ownerId).sort((a,b) => b.version - a.version);
			const current = versions[0];
			return current ? { current, versions } : null;
		});
	}
	create(ownerId: string, key: string, input: MarketEventInput) {
		return this.write(ownerId, key, input, null, null, "人工录入", null);
	}
	revise(ownerId: string, eventId: string, key: string, expectedVersion: number, input: MarketEventInput, changeReason: string) {
		if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !text(changeReason, 1000)) fail("invalid revision");
		return this.write(ownerId, key, input, eventId, expectedVersion, changeReason, null);
	}
	/** Automatic adapters must reference an existing active #41 item; caller cannot claim fetched body text. */
	async importSourceItem(ownerId: string, key: string, sourceItemId: string, subject: MarketEventInput["subject"], type: MarketEventInput["type"]) {
		return this.mutate(ownerId, async tx => {
			const source = await tx.sourceItems.get(sourceItemId);
			if (!source || source.status !== "active") throw new MarketEventError(404, "source item not found");
			const input: MarketEventInput = {
				occurrenceKey: `source:${source.sourceKey}:${hash(source.itemKey)}`, title: source.title, type, subject,
				eventTime: null, conditions: null, citations: { subject: null, eventTime: null, conditions: null }, taskRefs: [],
				provenance: { simulated: false, reference: null, transformation: null },
				sources: [{ url: source.itemUrl, publisher: source.sourceKey, content: source.title, scope: "title_only", origin: "official",
					publishedAt: source.publishedAt, acquiredAt: source.lastSeenAt, limitations: "仅取得列表标题与链接，未读取正文；未核验事件事实" }],
			};
			validate(input);
			return this.commit(tx, ownerId, key, input, null, null, "受限列表来源导入", sourceItemId);
		});
	}
	private async write(ownerId: string, key: string, input: MarketEventInput, eventId: string | null, expectedVersion: number | null, reason: string, sourceItemId: string | null) {
		validate(input);
		return this.mutate(ownerId, tx => this.commit(tx, ownerId, key, input, eventId, expectedVersion, reason, sourceItemId));
	}
	/** Reject overlapping owner writes before starting a serializable snapshot. Retry with the same key. */
	private async mutate<T>(ownerId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
		const lock = await this.storage.runExclusive(`market-events:${ownerId}`, () => this.storage.transaction(work));
		if (!lock.acquired) throw new MarketEventError(409, "event write in progress");
		return lock.value!;
	}
	private async commit(tx: Transaction, ownerId: string, key: string, input: MarketEventInput, eventId: string | null, expectedVersion: number | null, reason: string, sourceItemId: string | null) {
		if (!text(ownerId, 256) || !text(key, 256)) fail("invalid operation key");
		for (const ref of input.taskRefs) {
			const task = await tx.tasks.get(ref.taskId);
			if (!task || task.ownerId !== ownerId || !await tx.taskVersions.get(`${ref.taskId}:${ref.taskVersion}`)) throw new MarketEventError(404, "task not found");
		}
		const operationId = hash([ownerId, key]);
		const digest = hash({ input, eventId, expectedVersion, reason, sourceItemId });
		const operation = await tx.marketEventOperations.get(operationId);
		if (operation) {
			if (operation.digest !== digest) throw new MarketEventError(409, "idempotency conflict");
			const version = await tx.marketEventVersions.get(operation.versionId);
			if (!version) throw new Error("event operation result missing");
			// 幂等重放也要限访：不能因为重放就返回到期事件的业务正文。
			if (version.eventId && !await activeEventHeadIn(tx, ownerId, version.eventId, new Date(this.now())))
				throw new MarketEventError(404, "event not found");
			return { status: operation.status, version };
		}
		const logicalKey = hash([input.subject.kind, normalize(input.subject.name), input.type, normalize(input.occurrenceKey)]);
		const aliases = [hash([ownerId, "logical", logicalKey]), ...input.sources.flatMap(s => s.url ? [hash([ownerId, input.subject.kind, normalize(input.subject.name), input.type, "url", safeUrl(s.url)])] : [])];
		let head = eventId ? await tx.marketEvents.get(eventId) : null;
		if (eventId && (!head || head.ownerId !== ownerId)) throw new MarketEventError(404, "event not found");
		// 写入前用原状态判定仍可访问：否则修订会推进「最后业务更新」，等于把已到期事件复活。
		if (eventId && head && !await eventActiveIn(tx, head, new Date(this.now())))
			throw new MarketEventError(404, "event not found");
		for (const aliasId of aliases) {
			const alias = await tx.marketEventAliases.get(aliasId);
			if (!alias) continue;
			if (head && head.id !== alias.eventId) throw new MarketEventError(409, "source already belongs to another event");
			head = await tx.marketEvents.get(alias.eventId);
		}
		// 别名/逻辑键可能指向已到期事件：这里必须对最终 head 再判一次，
		// 否则换一个新幂等键提交相同链接即可把到期事件的标题与正文取回（duplicate 分支）。
		if (head && !await eventActiveIn(tx, head, new Date(this.now())))
			throw new MarketEventError(404, "event not found");
		const previous = head ? await tx.marketEventVersions.get(`${head.id}:${head.currentVersion}`) : null;
		if (eventId && head?.currentVersion !== expectedVersion) throw new MarketEventError(409, "event version conflict");
		if (previous && ((previous.input.provenance.simulated && !input.provenance.simulated) || (!eventId && previous.input.provenance.simulated !== input.provenance.simulated))) throw new MarketEventError(409, "simulation provenance cannot be changed");
		let status: MarketEventOperation["status"];
		let version: MarketEventVersion;
		if (previous && (!eventId || hash(previous.input) === hash(input))) {
			status = eventId ? "unchanged" : "duplicate";
			version = previous;
		} else {
			const id = head?.id ?? hash([ownerId, logicalKey]);
			const number = (head?.currentVersion ?? 0) + 1;
			const createdAt = this.now();
			version = { id: `${id}:${number}`, eventId: id, ownerId, version: number,
				evidenceRevision: previous ? previous.evidenceRevision + Number(evidenceHash(previous.input) !== evidenceHash(input)) : 1,
				input: structuredClone(input), method: sourceItemId ? "source_item" : "manual", sourceItemId,
				materials: input.sources.map((source,i) => {
					const priorIndex = previous?.input.sources.findIndex(prior => hash(prior) === hash(source)) ?? -1;
					const prior = previous?.materials[priorIndex];
					return prior ?? { id: `${id}:${number}:source:${i}`, method: sourceItemId ? "source_item" : "manual", sourceItemId };
				}), createdAt, changeReason: reason, candidate: assess(input) };
			await tx.marketEventVersions.put(version);
			await tx.marketEvents.put({ id, ownerId, logicalKey: head?.logicalKey ?? logicalKey, currentVersion: number, createdAt: head?.createdAt ?? createdAt });
			status = previous ? "revised" : "created";
		}
		// Duplicate requests never attach unseen material without an explicit, audited revision.
		if (status !== "duplicate")
			for (const id of new Set(aliases)) await tx.marketEventAliases.put({ id, ownerId, eventId: version.eventId });
		// #112 第二阶段：同一事务内按本人订阅筛选事件并留历史记录；只有新的证据版本会推进通知 revision。
		if (status === "created" || status === "revised") await this.selections.selectEventIn(tx, version);
		await tx.marketEventOperations.put({ id: operationId, ownerId, digest, versionId: version.id, status, createdAt: this.now() });
		return { status, version };
	}
}
