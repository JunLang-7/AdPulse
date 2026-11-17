import { createHash } from "node:crypto";
import { canSendProactiveIn } from "./notifications.js";
import { digestInstant, itemId, localDate, NotificationQueue } from "./notifications-queue.js";
import { NotificationRecordError } from "./notifications-records.js";
import { normalizeName } from "./subscriptions.js";
import { taskActiveIn } from "./lifecycle.js";
import type { MarketEventVersion } from "./market-events.js";
import type { Storage, Transaction } from "./ports/storage.js";
import type {
	InvestigationAlert,
	NotificationBatch,
	NotificationItem,
	NotificationSelection,
	SubscriptionTarget,
} from "./state/model.js";

/** 第一阶段仅接受服务端已经证明的本人任务关联，绝不匹配展示文字或域名。 */
export function matchEffectTargets(
	targets: SubscriptionTarget[], ownerId: string, taskId: string,
): SubscriptionTarget[] {
	return targets.filter((target) => target.userId === ownerId && target.kind === "task"
		&& target.refId === taskId && target.status === "active" && target.categories.includes("effect"));
}

/**
 * 事件类别的关注项分解：只有事件明确标注的主体或任务关联才算关联依据。
 * 对象一般事件只发给 include_general；task_only 只接收显式关联任务的事件。
 * 名称、标题、摘要或域名不作为关联依据。
 */
export function matchEventTargets(
	targets: SubscriptionTarget[], ownerId: string, version: MarketEventVersion,
): { matched: SubscriptionTarget[]; associated: SubscriptionTarget[]; scopeExcluded: boolean } {
	const owned = targets.filter((target) => target.userId === ownerId);
	const subjectKey = normalizeName(version.input.subject.name);
	const taskIds = new Set(version.input.taskRefs.map((ref) => ref.taskId));
	const objects = owned.filter((target) => (target.kind === "brand" || target.kind === "competitor")
		&& target.refId === subjectKey);
	const tasks = owned.filter((target) => target.kind === "task" && taskIds.has(target.refId));
	const associated = [...objects, ...tasks];
	const matched = associated.filter((target) => target.status === "active"
		&& target.categories.includes("event")
		&& (target.kind === "task" || target.scope === "include_general"));
	// 关联存在但被范围设置挡住：能给出比「无关注项」更准确的原因。
	const scopeExcluded = matched.length === 0 && associated.some((target) => target.status === "active"
		&& target.categories.includes("event") && target.kind !== "task" && target.scope === "task_only");
	return { matched, associated, scopeExcluded };
}

/** 与 `domain/infoCard.ts` 的卡片校验一致：超限会让整批汇总发送失败。 */
const RELEVANCE_LIMIT = 120;

const cleanText = (value: string, max: number): string =>
	value.replace(/[\u0000-\u001f]/g, " ").slice(0, max);

/** 按总长度预算裁剪名称：只按单个字段截断仍可能拼接超限。 */
function fitRelevance(assemble: (names: string[]) => string, names: string[]): string {
	const budget = names.map((name) => name.length);
	let text = assemble(names.map((name, index) => name.slice(0, budget[index])));
	while (text.length > RELEVANCE_LIMIT) {
		const widest = budget.reduce(
			(best, size, index) => (size > budget[best]! ? index : best),
			0,
		);
		if (budget[widest]! === 0) break;
		budget[widest] = budget[widest]! - 1;
		text = assemble(names.map((name, index) => name.slice(0, budget[index])));
	}
	return text.length > RELEVANCE_LIMIT ? text.slice(0, RELEVANCE_LIMIT) : text;
}

type SelectionDeliveryResult = Pick<NotificationBatch, "status" | "statusReason" | "scheduledAt" | "sentAt">;
export type SelectionRecord = Omit<NotificationSelection, "ownerId"> & { deliveryResult?: SelectionDeliveryResult };
export interface SelectionPage { records: SelectionRecord[]; nextBefore: string | null }
export interface SelectionQuery {
	limit?: number;
	before?: string;
	taskId?: string;
	dateFrom?: string;
	dateTo?: string;
	outcome?: string;
}

const cursor = (record: NotificationSelection): string => `${record.evaluatedAt}~${record.id}`;
const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value)
	&& Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
	&& new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const validCursor = (value: string): boolean => {
	const timestamp = value.split("~")[0]!;
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z~[a-f0-9]{64}$/.test(value)
		&& Number.isFinite(Date.parse(timestamp)) && new Date(timestamp).toISOString() === timestamp;
};
const outcomes = ["queued", "not_queued", "duplicate", "cancelled"];

export class NotificationSelectionService {
	private readonly queue: NotificationQueue;
	constructor(private readonly storage: Storage, private readonly now = () => new Date().toISOString()) {
		this.queue = new NotificationQueue(storage, () => new Date(this.now()));
	}

	/** 只在领域评估事务中调用；不扫描旧告警，不执行网络 I/O。 */
	async selectIn(tx: Transaction, alert: InvestigationAlert, isNewEvidence: boolean): Promise<void> {
		const task = await tx.tasks.get(alert.taskId);
		const result = await tx.comparisonResults.get(alert.current.comparisonResultId);
		if (!task || task.ownerId !== alert.ownerId || !result || result.ownerId !== alert.ownerId) return;
		const evidence = await tx.evidenceVersions.get(`${result.current.evidenceId}:${result.current.version}`);
		if (!evidence || evidence.ownerId !== alert.ownerId || evidence.taskId !== task.id) return;
		const id = createHash("sha256").update(JSON.stringify([alert.ownerId, result.id])).digest("hex");
		if (await tx.notificationSelections.get(id)) return; // 重试不改写历史判断。
		const settings = await tx.subscriptionSettings.get(alert.ownerId);
		const targets = (await tx.subscriptionTargets.all()).filter((target) => target.userId === alert.ownerId);
		const matched = matchEffectTargets(targets, alert.ownerId, alert.taskId);
		const associated = targets.filter((target) => target.kind === "task" && target.refId === alert.taskId);
		let reason: NotificationSelection["reason"] = "matched";
		if (!isNewEvidence) reason = alert.notificationRevision ? "duplicate" : "historical_input";
		else if (alert.status !== "open") reason = "alert_inactive";
		else if (!settings?.proactiveEnabled) reason = "push_disabled";
		else if (!settings.enabledAt || result.createdAt <= settings.enabledAt) reason = "before_enabled";
		else if (associated.length === 0) reason = "no_target";
		else if (!associated.some((target) => target.status === "active")) reason = "target_muted";
		else if (matched.length === 0) reason = "category_excluded";
		else if (!(await canSendProactiveIn(tx, alert.ownerId))) reason = "not_authorized";

		const record: NotificationSelection = {
			id, ownerId: alert.ownerId, input: "effect", alertId: alert.id, taskId: alert.taskId,
			comparisonResultId: result.id, evidenceRef: { evidenceId: result.current.evidenceId, version: result.current.version },
			revision: alert.notificationRevision ?? 1, settingsVersion: settings?.version ?? 0,
			matchedTargetIds: matched.map((target) => target.id).sort(),
			outcome: reason === "duplicate" ? "duplicate" : "not_queued", reason, evaluatedAt: this.now(),
		};
		if (reason === "matched" && settings) {
			const current = alert.current;
			const ref = record.evidenceRef!;
			const product = (await tx.taskVersions.get(`${task.id}:${task.currentVersion}`))?.product ?? "本人任务";
			const scheduled = digestInstant(localDate(new Date(result.createdAt)));
			// 发送时刻之后才产生的新输入进下一次日报；服务恢复处理旧输入仍可当日补发。
			const notBefore = result.createdAt > scheduled ? new Date(Date.parse(scheduled) + 86_400_000) : undefined;
			// 短摘要只描述已有判定，不把缺基线描述成跨期上涨，不携带账户标识或原文。
			const queued = await this.queue.queueIn(tx, alert.ownerId, {
				logicalKey: `effect:${alert.id}`, kind: "effect_alert", taskId: task.id,
				effectRef: { alertId: alert.id, evidenceId: ref.evidenceId, evidenceVersion: ref.version, taskVersion: current.evidence.taskVersion },
				title: `${product.replace(/[\u0000-\u001f]/g, " ").slice(0, 50)}：当期咨询成本越线`,
				summary: `${record.revision > 1 ? "新增或修订证据后重新评估。" : ""}当期单次咨询成本超过已确认警戒线。${current.canComparePeriods ? "历史期间可比较，比较不代表因果关系。" : "缺少可比历史依据，不作跨期上涨结论。"}请查看任务证据；本信息不执行广告操作。`,
				relevance: `与你关注的任务「${product.replace(/[\u0000-\u001f]/g, " ").slice(0, 40)}」的效果排查订阅相关。`,
				sources: [{ label: `效果导入证据 ${ref.evidenceId} v${ref.version}`, publishedAt: null, observedAt: evidence.createdAt }],
				revision: record.revision,
			}, { settingsVersion: settings.version, enabled: true, ...(notBefore ? { notBefore } : {}) });
			record.outcome = queued.outcome;
			record.reason = queued.outcome === "queued" ? "matched" : queued.outcome === "duplicate" ? "duplicate" : "previously_cancelled";
			if (queued.item) record.itemId = queued.item.id;
		}
		await tx.notificationSelections.put(record);
	}

	/**
	 * #38 事件输入的筛选：只在事件写入事务中调用。
	 * 准入 = 引用齐备的候选（evidence_ready）+ 非模拟 + 至少一条来源链接 + 显式主体/任务关联；
	 * 不做标题/摘要/域名的相似匹配，也不拿 insufficient 候选冒充可推送信息。
	 */
	async selectEventIn(tx: Transaction, version: MarketEventVersion): Promise<void> {
		const ownerId = version.ownerId;
		const head = await tx.marketEvents.get(version.eventId);
		if (!head || head.ownerId !== ownerId || head.currentVersion !== version.version) return;
		const id = createHash("sha256").update(JSON.stringify([ownerId, version.eventId, version.evidenceRevision])).digest("hex");
		const previous = await tx.notificationSelections.get(id);
		if (previous) {
			// 同一证据版本不重算、不改写历史判断；但普通修订（改标题/任务关联）仍要刷新尚未发送的条目，
			// 否则发送前复检会因版本不一致取消它，而不会再有替代条目。
			await this.refreshPendingEventIn(tx, version, previous);
			return;
		}
		const settings = await tx.subscriptionSettings.get(ownerId);
		const { matched, associated, scopeExcluded } = matchEventTargets(
			await tx.subscriptionTargets.all(), ownerId, version);
		const taskIds = [...new Set(version.input.taskRefs.map((ref) => ref.taskId))].sort();
		let reason: NotificationSelection["reason"] = "matched";
		// 「引用齐备」本身要求至少一条带 URL 的官方原文，因此准入与来源链接一起校验。
		if (version.input.provenance.simulated) reason = "simulated_input";
		else if (version.candidate.status !== "evidence_ready" || !version.input.sources.some((source) => source.url))
			reason = "insufficient_evidence";
		else if (associated.length === 0) reason = "no_association";
		else if (!settings?.proactiveEnabled) reason = "push_disabled";
		else if (!settings.enabledAt || version.createdAt <= settings.enabledAt) reason = "before_enabled";
		else if (!associated.some((target) => target.status === "active")) reason = "target_muted";
		else if (scopeExcluded) reason = "scope_excluded";
		else if (matched.length === 0) reason = "category_excluded";
		else if (!(await canSendProactiveIn(tx, ownerId))) reason = "not_authorized";

		const ref = { eventId: version.eventId, version: version.version, evidenceRevision: version.evidenceRevision };
		const record: NotificationSelection = {
			id, ownerId, input: "event",
			...(taskIds.length === 1 ? { taskId: taskIds[0]! } : {}),
			marketEventRef: ref,
			revision: version.evidenceRevision, settingsVersion: settings?.version ?? 0,
			matchedTargetIds: matched.map((target) => target.id).sort(),
			outcome: "not_queued", reason, evaluatedAt: this.now(),
		};
		if (reason === "matched" && settings) {
			const content = await this.eventItemIn(tx, version, {
				subject: matched.some((target) => target.kind !== "task"),
				taskIds: matched.filter((target) => target.kind === "task").map((target) => target.refId),
			});
			const scheduled = digestInstant(localDate(new Date(version.createdAt)));
			// 发送时刻之后才产生的新输入进下一次日报；服务恢复处理旧输入仍可当日补发。
			const notBefore = version.createdAt > scheduled ? new Date(Date.parse(scheduled) + 86_400_000) : undefined;
			const queued = await this.queue.queueIn(tx, ownerId, {
				logicalKey: `event:${version.eventId}`, kind: "market_event",
				marketEventRef: ref,
				revision: record.revision,
				...content,
			}, { settingsVersion: settings.version, enabled: true, ...(notBefore ? { notBefore } : {}) });
			record.outcome = queued.outcome;
			record.reason = queued.outcome === "queued" ? "matched" : queued.outcome === "duplicate" ? "duplicate" : "previously_cancelled";
			if (queued.item) record.itemId = queued.item.id;
		}
		await tx.notificationSelections.put(record);
	}

	/**
	 * 事件卡片内容：标题、摘要、为什么相关与来源引用。
	 * 事件时间/适用条件未知时保持未知；正文与原文引用不复制进卡片。
	 */
	private async eventItemIn(
		tx: Transaction,
		version: MarketEventVersion,
		matched: { subject: boolean; taskIds: string[] },
	): Promise<{ title: string; summary: string; relevance: string; sources: NotificationItem["sources"]; taskId?: string }> {
		const input = version.input;
		const typeLabel = input.type === "announcement" ? "公告" : input.type === "campaign" ? "活动" : "产品发布";
		const subjectLabel = input.subject.kind === "brand" ? "品牌" : "竞品";
		const products = (await Promise.all([...new Set(matched.taskIds)].map(async (taskId) => {
			const task = await tx.tasks.get(taskId);
			if (!task || task.ownerId !== version.ownerId) return null;
			return (await tx.taskVersions.get(`${task.id}:${task.currentVersion}`))?.product ?? null;
		}))).filter((product): product is string => Boolean(product));
		// 命中原因逐项列出实际命中的关注项，不把未订阅的对象写进理由。
		const relevance = fitRelevance(
			(names) => [
				matched.subject && names[0] ? `该事件明确标注的主体是你关注的${subjectLabel}「${names[0]}」` : null,
				names[1] ? `并显式关联你的任务「${names[1]}」` : null,
				"名称、标题、摘要与域名不单独构成关联依据。",
			].filter(Boolean).join("；"),
			[
				matched.subject ? cleanText(input.subject.name, 40) : "",
				cleanText(products.join("、"), 40),
			],
		);
		const timeLine = input.eventTime ? `事件时间 ${cleanText(input.eventTime, 60)}` : "事件时间未知（未补造）";
		const conditionLine = input.conditions ? "适用条件见事件详情。" : "适用条件未提供。";
		const taskIds = [...new Set(input.taskRefs.map((ref) => ref.taskId))].sort();
		return {
			title: cleanText(input.title, 50),
			summary: `${typeLabel}：${cleanText(input.subject.name, 40)}。${timeLine}。${conditionLine}以上仅为你录入的明确事件与原文引用，未经独立来源核验；本信息不执行广告操作。`,
			relevance,
			sources: input.sources.slice(0, 5).map((source, index) => ({
				label: `${cleanText(source.publisher, 40) || `来源 ${index + 1}`}（${source.scope === "title_only" ? "仅标题" : source.scope === "link_only" ? "仅链接" : source.scope === "search_snippet" ? "搜索摘要" : source.scope === "excerpt" ? "节选" : "全文"}）`,
				...(source.url ? { url: source.url } : {}),
				publishedAt: source.publishedAt,
				observedAt: source.acquiredAt,
			})),
			...(taskIds.length === 1 ? { taskId: taskIds[0]! } : {}),
		};
	}

	/** 同一证据版本的普通修订：只刷新尚未发送的条目，已发送/已取消不复活也不改写。 */
	private async refreshPendingEventIn(
		tx: Transaction,
		version: MarketEventVersion,
		record: NotificationSelection,
	): Promise<void> {
		const item = await tx.notificationItems.get(itemId(version.ownerId, `event:${version.eventId}`));
		if (!item || item.status !== "queued" || item.revision !== version.evidenceRevision) return;
		if (item.marketEventRef?.version === version.version) return;
		const targets = (await tx.subscriptionTargets.all())
			.filter((target) => record.matchedTargetIds.includes(target.id));
		const content = await this.eventItemIn(tx, version, {
			subject: targets.some((target) => target.kind !== "task"),
			taskIds: targets.filter((target) => target.kind === "task").map((target) => target.refId),
		});
		const { taskId: _previousTaskId, ...rest } = item;
		await tx.notificationItems.put({
			...rest,
			...(content.taskId ? { taskId: content.taskId } : {}),
			title: content.title,
			summary: content.summary,
			relevance: content.relevance,
			sources: content.sources,
			marketEventRef: { eventId: version.eventId, version: version.version, evidenceRevision: version.evidenceRevision },
			updatedAt: this.now(),
		});
	}

	async list(ownerId: string, query: SelectionQuery = {}): Promise<SelectionPage> {
		const limit = query.limit ?? 20;
		if (!Number.isInteger(limit) || limit < 1 || limit > 50
			|| (query.dateFrom !== undefined && !validDate(query.dateFrom))
			|| (query.dateTo !== undefined && !validDate(query.dateTo))
			|| (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo)
			|| (query.outcome !== undefined && !outcomes.includes(query.outcome))
			|| (query.taskId !== undefined && (!query.taskId || query.taskId.length > 200 || /[\u0000-\u001f]/.test(query.taskId)))
			|| (query.before !== undefined && !validCursor(query.before)))
			throw new NotificationRecordError("invalid_query", "invalid selection query");
		return this.storage.transaction(async (tx) => {
			const tasks = new Set((await tx.tasks.all()).filter((task) => task.ownerId === ownerId).map((task) => task.id));
			const alerts = new Set((await tx.investigationAlerts.all()).filter((alert) => alert.ownerId === ownerId && tasks.has(alert.taskId)).map((alert) => alert.id));
			const evidence = new Set((await tx.evidenceVersions.all()).filter((version) => version.ownerId === ownerId && tasks.has(version.taskId)).map((version) => version.id));
			// 事件引用只能指向本人事件；事件可以没有任务关联，因此不强制 taskId。
			const events = new Set((await tx.marketEvents.all()).filter((head) => head.ownerId === ownerId).map((head) => head.id));
			const records = (await tx.notificationSelections.all()).filter((record) => record.ownerId === ownerId
				&& (record.input === "event"
					? Boolean(record.marketEventRef) && events.has(record.marketEventRef!.eventId)
						&& (!record.taskId || tasks.has(record.taskId))
					: Boolean(record.taskId) && tasks.has(record.taskId!) && Boolean(record.alertId) && alerts.has(record.alertId!)
						&& Boolean(record.evidenceRef) && evidence.has(`${record.evidenceRef!.evidenceId}:${record.evidenceRef!.version}`))
				&& (!query.taskId || record.taskId === query.taskId)
				&& (!query.outcome || record.outcome === query.outcome)
				&& (!query.dateFrom || localDate(new Date(record.evaluatedAt)) >= query.dateFrom)
				&& (!query.dateTo || localDate(new Date(record.evaluatedAt)) <= query.dateTo)
				&& (!query.before || cursor(record) < query.before))
				.sort((a, b) => cursor(b).localeCompare(cursor(a)));
			const page = records.slice(0, limit);
			// 早于第二阶段写入的历史记录没有 input 字段，按效果告警返回，保持契约必填。
			const visible = await Promise.all(page.map(async ({ ownerId: _owner, ...record }): Promise<SelectionRecord> => {
				const deliveryResult = await selectionDeliveryIn(tx, ownerId, record);
				return { ...record, input: record.input ?? "effect", ...(deliveryResult ? { deliveryResult } : {}) };
			}));
			return { records: visible,
				nextBefore: records.length > limit && page.length ? cursor(page[page.length - 1]!) : null };
		});
	}
}

/** 待发条目会被后续修订复用，旧记录只能与同一修订的条目关联。 */
async function selectionDeliveryIn(tx: Transaction, ownerId: string, record: SelectionRecord): Promise<SelectionDeliveryResult | undefined> {
	if (record.outcome !== "queued" || !record.itemId) return;
	const item = await tx.notificationItems.get(record.itemId);
	if (!item || item.ownerId !== ownerId || item.revision !== record.revision) return;
	const batch = await tx.notificationBatches.get(item.batchId);
	if (!batch || batch.ownerId !== ownerId) return;
	if (batch.status === "sent" && item.status === "queued") return;
	if (item.status === "sent" && batch.status !== "sent") return;
	// 同批次有其他内容发送成功时，取消的条目仍显示自己的状态。
	const status = batch.status === "sent" || batch.status === "queued" ? item.status : batch.status;
	return {
		status,
		scheduledAt: batch.scheduledAt,
		...(status === batch.status && batch.statusReason ? { statusReason: batch.statusReason } : {}),
		...(status === "sent" && batch.sentAt ? { sentAt: batch.sentAt } : {}),
	};
}

/** 在发送前重检生产引用；不把已处理/删除/修订的旧信息重新包装。 */
export async function effectNotificationCurrentIn(
	tx: Transaction,
	item: NotificationItem,
	now: Date = new Date(),
): Promise<boolean> {
	const ref = item.effectRef;
	if (!ref) return true; // 既有受控合成队列不冒充领域来源。
	const task = item.taskId ? await tx.tasks.get(item.taskId) : null;
	// 到期即不再发送：任务到期后其提醒与证据按限访处理，不把旧信息当新内容。
	if (task && !(await taskActiveIn(tx, task, now))) return false;
	const alert = await tx.investigationAlerts.get(ref.alertId);
	const evidence = await tx.evidenceVersions.get(`${ref.evidenceId}:${ref.evidenceVersion}`);
	const head = await tx.evidenceHeads.get(ref.evidenceId);
	const sources = (await tx.evidenceSources.all()).filter((source) => source.ownerId === item.ownerId
		&& source.evidenceId === ref.evidenceId && source.evidenceVersion === ref.evidenceVersion);
	return Boolean(task && task.ownerId === item.ownerId && task.currentVersion === ref.taskVersion
		&& alert && alert.ownerId === item.ownerId && alert.taskId === task.id && alert.status === "open"
		&& alert.current.evidence.evidenceId === ref.evidenceId && alert.current.evidence.version === ref.evidenceVersion
		&& evidence && evidence.ownerId === item.ownerId && evidence.taskId === task.id
		&& head?.ownerId === item.ownerId && head.currentVersion === ref.evidenceVersion
		&& sources.length > 0 && sources.every((source) => source.source.platform === alert.current.source.platform
			&& source.source.accountRef === alert.current.source.accountRef));
}

/**
 * 事件入队的发送前复检：仍是当前证据版本、仍是引用齐备的候选。
 * 事件修订、补充证据或转为不足时取消旧待发，不把旧版本冒充最新事实。
 */
export async function marketEventNotificationCurrentIn(
	tx: Transaction, item: NotificationItem,
): Promise<boolean> {
	const ref = item.marketEventRef;
	if (!ref) return true; // 非事件条目不受此检查影响。
	const head = await tx.marketEvents.get(ref.eventId);
	const version = await tx.marketEventVersions.get(`${ref.eventId}:${ref.version}`);
	return Boolean(head && head.ownerId === item.ownerId && head.currentVersion === ref.version
		&& version && version.ownerId === item.ownerId
		&& version.evidenceRevision === ref.evidenceRevision
		&& version.candidate.status === "evidence_ready");
}

/** 发送前按条目实际输入选择领域复检，不让事件条目跳过引用检查。 */
export async function notificationInputsStillCurrentIn(
	tx: Transaction, item: NotificationItem, now: Date = new Date(),
): Promise<boolean> {
	return item.marketEventRef
		? marketEventNotificationCurrentIn(tx, item)
		: effectNotificationCurrentIn(tx, item, now);
}
