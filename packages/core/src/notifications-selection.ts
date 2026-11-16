import { createHash } from "node:crypto";
import { canSendProactiveIn } from "./notifications.js";
import { digestInstant, localDate, NotificationQueue } from "./notifications-queue.js";
import { NotificationRecordError } from "./notifications-records.js";
import type { Storage, Transaction } from "./ports/storage.js";
import type { InvestigationAlert, NotificationItem, NotificationSelection, SubscriptionTarget } from "./state/model.js";

/** 第一阶段仅接受服务端已经证明的本人任务关联，绝不匹配展示文字或域名。 */
export function matchEffectTargets(
	targets: SubscriptionTarget[], ownerId: string, taskId: string,
): SubscriptionTarget[] {
	return targets.filter((target) => target.userId === ownerId && target.kind === "task"
		&& target.refId === taskId && target.status === "active" && target.categories.includes("effect"));
}

export type SelectionRecord = Omit<NotificationSelection, "ownerId">;
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
			id, ownerId: alert.ownerId, alertId: alert.id, taskId: alert.taskId,
			comparisonResultId: result.id, evidenceRef: { evidenceId: result.current.evidenceId, version: result.current.version },
			revision: alert.notificationRevision ?? 1, settingsVersion: settings?.version ?? 0,
			matchedTargetIds: matched.map((target) => target.id).sort(),
			outcome: reason === "duplicate" ? "duplicate" : "not_queued", reason, evaluatedAt: this.now(),
		};
		if (reason === "matched" && settings) {
			const current = alert.current;
			const product = (await tx.taskVersions.get(`${task.id}:${task.currentVersion}`))?.product ?? "本人任务";
			const scheduled = digestInstant(localDate(new Date(result.createdAt)));
			// 发送时刻之后才产生的新输入进下一次日报；服务恢复处理旧输入仍可当日补发。
			const notBefore = result.createdAt > scheduled ? new Date(Date.parse(scheduled) + 86_400_000) : undefined;
			// 短摘要只描述已有判定，不把缺基线描述成跨期上涨，不携带账户标识或原文。
			const queued = await this.queue.queueIn(tx, alert.ownerId, {
				logicalKey: `effect:${alert.id}`, kind: "effect_alert", taskId: task.id,
				effectRef: { alertId: alert.id, evidenceId: record.evidenceRef.evidenceId, evidenceVersion: record.evidenceRef.version, taskVersion: current.evidence.taskVersion },
				title: `${product.replace(/[\u0000-\u001f]/g, " ").slice(0, 50)}：当期咨询成本越线`,
				summary: `${record.revision > 1 ? "新增或修订证据后重新评估。" : ""}当期单次咨询成本超过已确认警戒线。${current.canComparePeriods ? "历史期间可比较，比较不代表因果关系。" : "缺少可比历史依据，不作跨期上涨结论。"}请查看任务证据；本信息不执行广告操作。`,
				relevance: `与你关注的任务「${product.replace(/[\u0000-\u001f]/g, " ").slice(0, 40)}」的效果排查订阅相关。`,
				sources: [{ label: `效果导入证据 ${record.evidenceRef.evidenceId} v${record.evidenceRef.version}`, publishedAt: null, observedAt: evidence.createdAt }],
				revision: record.revision,
			}, { settingsVersion: settings.version, enabled: true, ...(notBefore ? { notBefore } : {}) });
			record.outcome = queued.outcome;
			record.reason = queued.outcome === "queued" ? "matched" : queued.outcome === "duplicate" ? "duplicate" : "previously_cancelled";
			if (queued.item) record.itemId = queued.item.id;
		}
		await tx.notificationSelections.put(record);
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
			const records = (await tx.notificationSelections.all()).filter((record) => record.ownerId === ownerId
				&& tasks.has(record.taskId) && alerts.has(record.alertId)
				&& evidence.has(`${record.evidenceRef.evidenceId}:${record.evidenceRef.version}`)
				&& (!query.taskId || record.taskId === query.taskId)
				&& (!query.outcome || record.outcome === query.outcome)
				&& (!query.dateFrom || localDate(new Date(record.evaluatedAt)) >= query.dateFrom)
				&& (!query.dateTo || localDate(new Date(record.evaluatedAt)) <= query.dateTo)
				&& (!query.before || cursor(record) < query.before))
				.sort((a, b) => cursor(b).localeCompare(cursor(a)));
			const page = records.slice(0, limit);
			return { records: page.map(({ ownerId: _owner, ...record }) => record),
				nextBefore: records.length > limit && page.length ? cursor(page[page.length - 1]!) : null };
		});
	}
}

/** 在发送前重检生产引用；不把已处理/删除/修订的旧信息重新包装。 */
export async function effectNotificationCurrentIn(tx: Transaction, item: NotificationItem): Promise<boolean> {
	const ref = item.effectRef;
	if (!ref) return true; // 既有受控合成队列不冒充领域来源。
	const task = item.taskId ? await tx.tasks.get(item.taskId) : null;
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
