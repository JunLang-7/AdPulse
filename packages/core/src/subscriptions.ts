// 个人关注、订阅与推送偏好（#36）：只保存配置，不做筛选、调度与发送。
// 三维简单筛选：关注对象（本人任务 / 本人录入的品牌·竞品）× 类别 × 关联范围。
// 版本语义：每人一个单调计数，开关与关注列表的所有写入共用，便于 #37 判断「哪批待发已过期」。

import crypto from "node:crypto";
import type { Storage, Transaction } from "./ports/storage.js";
import type {
	SubscriptionCategory,
	SubscriptionScope,
	SubscriptionSettings,
	SubscriptionTarget,
	SubscriptionTargetKind,
} from "./state/model.js";

/** 首期默认值：北京时间日汇总 09:30，免打扰 22:00–08:00。时区固定，不做跨时区。 */
export const DEFAULT_SCHEDULE: SubscriptionSettings["schedule"] = {
	timezone: "Asia/Shanghai",
	digestAt: "09:30",
	quietStart: "22:00",
	quietEnd: "08:00",
};

const CATEGORIES: readonly SubscriptionCategory[] = [
	"effect",
	"event",
	"evidence",
];
const SCOPES: readonly SubscriptionScope[] = ["task_only", "include_general"];
const KINDS: readonly SubscriptionTargetKind[] = ["task", "brand", "competitor"];
const KIND_LABELS: Record<SubscriptionTargetKind, string> = {
	task: "任务",
	brand: "品牌",
	competitor: "竞品",
};

export class SubscriptionError extends Error {
	constructor(
		readonly reason:
			| "subscription_conflict"
			| "invalid_schedule"
			| "invalid_target"
			| "target_not_found"
			| "duplicate_target",
		message: string,
	) {
		super(message);
		this.name = "SubscriptionError";
	}
}

/** 对外视图：不含内部 id 之外的敏感信息，也不假装可投递。 */
export interface SubscriptionView {
	settings: {
		version: number;
		proactiveEnabled: boolean;
		decisionCards: NonNullable<SubscriptionSettings["decisionCards"]>;
		schedule: SubscriptionSettings["schedule"];
		enabledAt?: string;
		disabledAt?: string;
		/** 从未保存过配置时缺省：不伪造一个更新时间。 */
		updatedAt?: string;
	};
	targets: Array<{
		id: string;
		kind: SubscriptionTargetKind;
		kindLabel: string;
		refId: string;
		label: string;
		sourceUrl?: string;
		categories: SubscriptionCategory[];
		scope: SubscriptionScope;
		status: SubscriptionTarget["status"];
		updatedAt: string;
	}>;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutes = (value: string): number => {
	const match = TIME.exec(value);
	if (!match) throw new SubscriptionError("invalid_schedule", "invalid time");
	return Number(match[1]) * 60 + Number(match[2]);
};

/** 免打扰区间可以跨零点；返回 digestAt 是否落在其中。 */
function inQuietHours(
	at: string,
	start: string,
	end: string,
): boolean {
	const point = minutes(at);
	const from = minutes(start);
	const to = minutes(end);
	return from <= to
		? point >= from && point < to
		: point >= from || point < to;
}

function validateSchedule(
	schedule: SubscriptionSettings["schedule"],
): SubscriptionSettings["schedule"] {
	if (!schedule || typeof schedule !== "object")
		throw new SubscriptionError("invalid_schedule", "schedule is required");
	// 首期只支持北京时间：其他时区不做换算，直接拒绝——静默改写会改变时间语义。
	if (schedule.timezone !== "Asia/Shanghai")
		throw new SubscriptionError(
			"invalid_schedule",
			"timezone must be Asia/Shanghai",
		);
	const { digestAt, quietStart, quietEnd } = schedule;
	for (const value of [digestAt, quietStart, quietEnd])
		if (typeof value !== "string" || !TIME.test(value))
			throw new SubscriptionError("invalid_schedule", "time must be HH:mm");
	if (quietStart === quietEnd)
		throw new SubscriptionError(
			"invalid_schedule",
			"quiet hours must have a length",
		);
	// 汇总落在免打扰里等于永远不发；直接拒绝，避免存下必然失效的配置。
	if (inQuietHours(digestAt, quietStart, quietEnd))
		throw new SubscriptionError(
			"invalid_schedule",
			"digest time falls in quiet hours",
		);
	return { timezone: "Asia/Shanghai", digestAt, quietStart, quietEnd };
}

function validateCategories(value: unknown): SubscriptionCategory[] {
	if (!Array.isArray(value) || value.length === 0)
		throw new SubscriptionError("invalid_target", "categories required");
	const result: SubscriptionCategory[] = [];
	for (const item of value) {
		if (!CATEGORIES.includes(item as SubscriptionCategory))
			throw new SubscriptionError("invalid_target", "unknown category");
		if (!result.includes(item as SubscriptionCategory))
			result.push(item as SubscriptionCategory);
	}
	return result;
}

function validateScope(value: unknown): SubscriptionScope {
	if (!SCOPES.includes(value as SubscriptionScope))
		throw new SubscriptionError("invalid_target", "unknown scope");
	return value as SubscriptionScope;
}

const normalizeName = (value: string): string =>
	value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

const validName = (value: unknown): value is string =>
	typeof value === "string" &&
	value.trim().length > 0 &&
	value.trim().length <= 40 &&
	!/[\u0000-\u001f]/.test(value);

const validUrl = (value: unknown): value is string => {
	if (typeof value !== "string" || value.length > 512) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
};

export class SubscriptionService {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async view(userId: string): Promise<SubscriptionView> {
		return this.storage.transaction(async (tx) => {
			const settings = await tx.subscriptionSettings.get(userId);
			const targets = (await tx.subscriptionTargets.all())
				.filter((item) => item.userId === userId)
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
			return this.project(settings, targets);
		});
	}

	/** 开关与时段。启用前必须由调用方确认过订阅范围（界面责任），这里只落状态。 */
	async updateSettings(
		userId: string,
		input: {
			expectedVersion: number;
			proactiveEnabled?: boolean;
			decisionCardsEnabled?: boolean;
			schedule?: SubscriptionSettings["schedule"];
		},
	): Promise<SubscriptionView> {
		return this.storage.transaction(async (tx) => {
			const current = await this.requireVersion(
				tx,
				userId,
				input.expectedVersion,
			);
			const at = this.now();
			const schedule =
				input.schedule === undefined
					? (current?.schedule ?? DEFAULT_SCHEDULE)
					: validateSchedule(input.schedule);
			const proactiveEnabled =
				input.proactiveEnabled === undefined
					? (current?.proactiveEnabled ?? false)
					: input.proactiveEnabled;
			if (typeof proactiveEnabled !== "boolean")
				throw new SubscriptionError(
					"invalid_target",
					"proactiveEnabled must be boolean",
				);
			if (
				input.decisionCardsEnabled !== undefined &&
				typeof input.decisionCardsEnabled !== "boolean"
			)
				throw new SubscriptionError(
					"invalid_target",
					"decisionCardsEnabled must be boolean",
				);
			const decisionCards = {
				...current?.decisionCards,
				enabled: current?.decisionCards?.enabled ?? false,
			};
			if (input.decisionCardsEnabled !== undefined) {
				if (input.decisionCardsEnabled && !decisionCards.enabled) {
					decisionCards.enabledAt = at;
					decisionCards.confirmedVersion = (current?.version ?? 0) + 1;
				}
				if (!input.decisionCardsEnabled && decisionCards.enabled)
					decisionCards.disabledAt = at;
				decisionCards.enabled = input.decisionCardsEnabled;
			}
			const next: SubscriptionSettings = {
				id: userId,
				userId,
				version: (current?.version ?? 0) + 1,
				proactiveEnabled,
				decisionCards,
				schedule,
				updatedAt: at,
				...(current?.enabledAt ? { enabledAt: current.enabledAt } : {}),
				...(current?.disabledAt ? { disabledAt: current.disabledAt } : {}),
			};
			if (proactiveEnabled && !current?.proactiveEnabled) next.enabledAt = at;
			if (!proactiveEnabled && current?.proactiveEnabled)
				next.disabledAt = at;
			await tx.subscriptionSettings.put(next);
			return this.project(
				next,
				(await tx.subscriptionTargets.all()).filter(
					(item) => item.userId === userId,
				),
			);
		});
	}

	async addTarget(
		userId: string,
		input: {
			expectedVersion: number;
			kind: SubscriptionTargetKind;
			refId?: string;
			label?: string;
			sourceUrl?: string;
			categories: unknown;
			scope: unknown;
		},
	): Promise<SubscriptionView> {
		if (!KINDS.includes(input.kind))
			throw new SubscriptionError("invalid_target", "unknown kind");
		const categories = validateCategories(input.categories);
		const scope = validateScope(input.scope);
		return this.storage.transaction(async (tx) => {
			const current = await this.requireVersion(
				tx,
				userId,
				input.expectedVersion,
			);
			const at = this.now();
			const resolved = await this.resolveTarget(tx, userId, input);
			const existing = (await tx.subscriptionTargets.all()).find(
				(item) =>
					item.userId === userId &&
					item.kind === resolved.kind &&
					item.refId === resolved.refId,
			);
			if (existing)
				throw new SubscriptionError(
					"duplicate_target",
					"target already exists",
				);
			const target: SubscriptionTarget = {
				id: crypto.randomUUID(),
				userId,
				kind: resolved.kind,
				refId: resolved.refId,
				label: resolved.label,
				...(resolved.sourceUrl ? { sourceUrl: resolved.sourceUrl } : {}),
				categories,
				scope,
				status: "active",
				createdAt: at,
				updatedAt: at,
			};
			await tx.subscriptionTargets.put(target);
			const next = await this.bump(tx, current, userId, at);
			return this.project(next, await this.targetsOf(tx, userId));
		});
	}

	/** 退订 = 置 muted（保留可恢复）；恢复 = 置回 active。 */
	async updateTarget(
		userId: string,
		targetId: string,
		input: {
			expectedVersion: number;
			categories?: unknown;
			scope?: unknown;
			status?: unknown;
		},
	): Promise<SubscriptionView> {
		return this.storage.transaction(async (tx) => {
			const current = await this.requireVersion(
				tx,
				userId,
				input.expectedVersion,
			);
			const target = await tx.subscriptionTargets.get(targetId);
			// 他人对象一律按不存在处理，不泄露存在性。
			if (!target || target.userId !== userId)
				throw new SubscriptionError("target_not_found", "target not found");
			const at = this.now();
			const next: SubscriptionTarget = {
				...target,
				categories:
					input.categories === undefined
						? target.categories
						: validateCategories(input.categories),
				scope:
					input.scope === undefined
						? target.scope
						: validateScope(input.scope),
				status:
					input.status === undefined
						? target.status
						: input.status === "active" || input.status === "muted"
							? input.status
							: (() => {
									throw new SubscriptionError(
										"invalid_target",
										"status must be active or muted",
									);
								})(),
				updatedAt: at,
			};
			await tx.subscriptionTargets.put(next);
			const settings = await this.bump(tx, current, userId, at);
			return this.project(settings, await this.targetsOf(tx, userId));
		});
	}

	private async targetsOf(
		tx: Transaction,
		userId: string,
	): Promise<SubscriptionTarget[]> {
		return (await tx.subscriptionTargets.all())
			.filter((item) => item.userId === userId)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	/** 读取当前版本并按 expectedVersion 做乐观并发；无记录时版本视为 0。 */
	private async requireVersion(
		tx: Transaction,
		userId: string,
		expectedVersion: unknown,
	): Promise<SubscriptionSettings | null> {
		if (
			typeof expectedVersion !== "number" ||
			!Number.isInteger(expectedVersion) ||
			expectedVersion < 0
		)
			throw new SubscriptionError(
				"subscription_conflict",
				"expectedVersion required",
			);
		const current = await tx.subscriptionSettings.get(userId);
		if ((current?.version ?? 0) !== expectedVersion)
			throw new SubscriptionError(
				"subscription_conflict",
				"configuration changed elsewhere",
			);
		return current;
	}

	/** 关注列表的改动同样推进同一个版本计数。 */
	private async bump(
		tx: Transaction,
		current: SubscriptionSettings | null,
		userId: string,
		at: string,
	): Promise<SubscriptionSettings> {
		const next: SubscriptionSettings = current
			? { ...current, version: current.version + 1, updatedAt: at }
			: {
					id: userId,
					userId,
					version: 1,
					proactiveEnabled: false,
					schedule: DEFAULT_SCHEDULE,
					updatedAt: at,
				};
		await tx.subscriptionSettings.put(next);
		return next;
	}

	private async resolveTarget(
		tx: Transaction,
		userId: string,
		input: {
			kind: SubscriptionTargetKind;
			refId?: string;
			label?: string;
			sourceUrl?: string;
		},
	): Promise<{
		kind: SubscriptionTargetKind;
		refId: string;
		label: string;
		sourceUrl?: string;
	}> {
		if (input.kind === "task") {
			if (typeof input.refId !== "string" || !input.refId)
				throw new SubscriptionError("invalid_target", "task id required");
			const task = await tx.tasks.get(input.refId);
			// 他人任务按不存在处理：不确认「这个 id 存在但不是你的」。
			if (!task || task.ownerId !== userId)
				throw new SubscriptionError("target_not_found", "task not found");
			const versions = (await tx.taskVersions.all()).filter(
				(item) => item.taskId === task.id,
			);
			const current = versions.find(
				(item) => item.version === task.currentVersion,
			);
			return {
				kind: "task",
				refId: task.id,
				label: current?.product ?? "任务",
			};
		}
		// 品牌/竞品首期是本人录入的名称，没有跨租户实体；#38 出现实体后再关联。
		if (!validName(input.label))
			throw new SubscriptionError("invalid_target", "name required");
		const label = input.label.trim();
		if (input.sourceUrl !== undefined && !validUrl(input.sourceUrl))
			throw new SubscriptionError("invalid_target", "invalid source url");
		return {
			kind: input.kind,
			refId: normalizeName(label),
			label,
			...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
		};
	}

	private project(
		settings: SubscriptionSettings | null,
		targets: SubscriptionTarget[],
	): SubscriptionView {
		const sorted = [...targets].sort((left, right) =>
			left.createdAt.localeCompare(right.createdAt),
		);
		return {
			settings: {
				version: settings?.version ?? 0,
				proactiveEnabled: settings?.proactiveEnabled ?? false,
				decisionCards: settings?.decisionCards ?? { enabled: false },
				schedule: settings?.schedule ?? DEFAULT_SCHEDULE,
				...(settings?.enabledAt ? { enabledAt: settings.enabledAt } : {}),
				...(settings?.disabledAt ? { disabledAt: settings.disabledAt } : {}),
				...(settings?.updatedAt ? { updatedAt: settings.updatedAt } : {}),
			},
			targets: sorted.map((item) => ({
				id: item.id,
				kind: item.kind,
				kindLabel: KIND_LABELS[item.kind],
				refId: item.refId,
				label: item.label,
				...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
				categories: item.categories,
				scope: item.scope,
				status: item.status,
				updatedAt: item.updatedAt,
			})),
		};
	}
}
