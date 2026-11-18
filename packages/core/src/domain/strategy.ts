export interface Strategy {
	objective: string;
	audience: string[];
	channels: Record<
		string,
		{ budget?: number; bidCpc?: number; enabled?: boolean }
	>;
	sellingPoints: string[];
	/**
	 * 站内基线：打算表达的内容方向。不代表已发布、已投放或已获得曝光。
	 * 可选是为了让旧的任务/会话快照原样可读，无需迁移。
	 */
	contentDirections?: string[];
	/**
	 * 站内基线：考虑或正在接触的合作对象名单。不代表已联系、已合作或已付款。
	 * 仅记录名称，不建模合作阶段与效果指标。
	 */
	partners?: string[];
}
/** Ratios, not percentages: 0.2 means 20%. */
export interface Limits {
	maxBudgetChangeRatio: number;
	maxBidChangeRatio: number;
}
export interface Signal {
	id: string;
	title: string;
	summary: string;
	evidence: Array<{ label: string; value: string; sourceUrl?: string }>;
}
/**
 * 变更词表：渠道数值/开关是增量变更，其余是列表增删。
 * 内容方向与合作对象只是站内基线记录，不代表已发布、已联系或已投放；
 * 不支持的 kind 一律拒绝，不做静默降级。
 */
export type StrategyChange =
	| { kind: "budget"; channelId: string; from: number; to: number }
	| { kind: "bidCpc"; channelId: string; from: number; to: number }
	| { kind: "enabled"; channelId: string; from: boolean; to: boolean }
	| { kind: "audience"; op: "add" | "remove"; item: string }
	| { kind: "sellingPoint"; op: "add" | "remove"; item: string }
	| { kind: "contentDirection"; op: "add" | "remove"; item: string }
	| { kind: "partner"; op: "add" | "remove"; item: string };

/**
 * 只有预算与出价算「花钱」。未确认货币口径的任务不得被提议这类变更，
 * 但人群/卖点/内容方向/合作对象/开关不受限；分类集中在这里，避免各处用 kind 猜。
 */
export function isMonetaryChange(change: StrategyChange): boolean {
	return change.kind === "budget" || change.kind === "bidCpc";
}

/** 单个候选的变更条数上限：列表操作同样计入，避免一次提交塞满整份方案。 */
export const MAX_STRATEGY_CHANGES = 6;
/** 与任务草案的 1–8 项保持一致。 */
export const MAX_STRATEGY_LIST_ITEMS = 8;
export const MAX_STRATEGY_LIST_ITEM_LENGTH = 80;

/** 列表字段与变更 kind 的对应关系集中在这里，避免调用方各自猜字段名。 */
type ListChange = Extract<StrategyChange, { op: "add" | "remove" }>;
function listField(strategy: Strategy, kind: ListChange["kind"]): string[] {
	switch (kind) {
		case "audience":
			return strategy.audience;
		case "sellingPoint":
			return strategy.sellingPoints;
		case "contentDirection":
			return (strategy.contentDirections ??= []);
		case "partner":
			return (strategy.partners ??= []);
	}
}

export function validateStrategy(strategy: Strategy, limits: Limits): void {
	if (
		!strategy ||
		typeof strategy.objective !== "string" ||
		!Array.isArray(strategy.audience) ||
		!strategy.audience.every((x) => typeof x === "string") ||
		!Array.isArray(strategy.sellingPoints) ||
		!strategy.sellingPoints.every((x) => typeof x === "string") ||
		!strategy.channels ||
		typeof strategy.channels !== "object" ||
		Array.isArray(strategy.channels)
	) {
		throw new Error("invalid strategy");
	}
	for (const key of ["contentDirections", "partners"] as const) {
		const value = strategy[key];
		if (
			value !== undefined &&
			(!Array.isArray(value) || !value.every((x) => typeof x === "string"))
		)
			throw new Error("invalid strategy");
	}
	for (const channel of Object.values(strategy.channels)) {
		if (!channel || typeof channel !== "object")
			throw new Error("invalid strategy channel");
		for (const key of ["budget", "bidCpc"] as const) {
			const value = channel[key];
			if (value !== undefined && (!Number.isFinite(value) || value < 0))
				throw new Error("invalid strategy amount");
		}
		if (channel.enabled !== undefined && typeof channel.enabled !== "boolean")
			throw new Error("invalid enabled flag");
	}
	for (const value of [
		limits?.maxBudgetChangeRatio,
		limits?.maxBidChangeRatio,
	]) {
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			value < 0 ||
			value > 1
		)
			throw new Error("invalid limits");
	}
}

/** Only changes stored with the displayed proposal can be applied. Never execute ad APIs. */
export function applyChanges(
	strategy: Strategy,
	changes: StrategyChange[],
	limits: Limits,
): Strategy {
	validateStrategy(strategy, limits);
	if (!Array.isArray(changes)) throw new Error("invalid strategy changes");
	if (changes.length > MAX_STRATEGY_CHANGES)
		throw new Error("too many strategy changes");
	const next = structuredClone(strategy);
	const changedFields = new Set<string>();
	for (const change of changes) {
		if (!change || typeof change !== "object")
			throw new Error("invalid strategy change");
		switch (change.kind) {
			case "audience":
			case "sellingPoint":
			case "contentDirection":
			case "partner":
				applyListChange(next, change, changedFields);
				break;
			case "budget":
			case "bidCpc":
			case "enabled":
				applyChannelChange(next, change, limits, changedFields);
				break;
			default:
				throw new Error("invalid strategy change");
		}
	}
	return next;
}

function applyChannelChange(
	strategy: Strategy,
	change: Extract<
		StrategyChange,
		{ kind: "budget" | "bidCpc" | "enabled" }
	>,
	limits: Limits,
	changedFields: Set<string>,
): void {
	if (typeof change.channelId !== "string")
		throw new Error("invalid strategy change");
	const field = JSON.stringify([change.channelId, change.kind]);
	if (changedFields.has(field)) throw new Error("duplicate strategy change");
	changedFields.add(field);
	if (
		!Object.hasOwn(strategy.channels, change.channelId) ||
		["__proto__", "prototype", "constructor"].includes(change.channelId)
	)
		throw new Error("unknown channel");
	const channel = strategy.channels[change.channelId];
	if (!channel) throw new Error("unknown channel");
	if (change.kind === "enabled") {
		if (channel.enabled !== change.from)
			throw new Error("stale strategy change");
		if (typeof change.from !== "boolean" || typeof change.to !== "boolean")
			throw new Error("invalid enabled change");
		channel.enabled = change.to;
		return;
	}
	if (channel[change.kind] !== change.from)
		throw new Error("stale strategy change");
	const ratio =
		change.kind === "budget"
			? limits.maxBudgetChangeRatio
			: limits.maxBidChangeRatio;
	if (
		typeof change.from !== "number" ||
		!Number.isFinite(change.from) ||
		typeof change.to !== "number" ||
		!Number.isFinite(change.to) ||
		change.to < 0 ||
		Math.abs(change.to - change.from) > Math.abs(change.from) * ratio + 1e-9
	) {
		throw new Error("strategy change exceeds limits");
	}
	channel[change.kind] = change.to;
}

function applyListChange(
	strategy: Strategy,
	change: ListChange,
	changedFields: Set<string>,
): void {
	if (change.op !== "add" && change.op !== "remove")
		throw new Error("invalid strategy change");
	if (typeof change.item !== "string")
		throw new Error("invalid strategy change");
	// 不接受前后空白或控制字符：存储值与展示值保持一致，避免同一项因写法不同重复出现。
	if (
		!change.item ||
		change.item !== change.item.trim() ||
		change.item.length > MAX_STRATEGY_LIST_ITEM_LENGTH ||
		/[\u0000-\u001f]/.test(change.item)
	)
		throw new Error("invalid strategy change");
	const key = JSON.stringify([change.kind, change.item]);
	if (changedFields.has(key)) throw new Error("duplicate strategy change");
	changedFields.add(key);
	const list = listField(strategy, change.kind);
	const present = list.includes(change.item);
	if (change.op === "add") {
		if (present) throw new Error("stale strategy change");
		if (list.length >= MAX_STRATEGY_LIST_ITEMS)
			throw new Error("strategy list is full");
		list.push(change.item);
		return;
	}
	if (!present) throw new Error("stale strategy change");
	list.splice(list.indexOf(change.item), 1);
}
