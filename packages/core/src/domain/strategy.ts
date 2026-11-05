export interface Strategy {
	objective: string;
	audience: string[];
	channels: Record<
		string,
		{ budget?: number; bidCpc?: number; enabled?: boolean }
	>;
	sellingPoints: string[];
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
export type StrategyChange =
	| { kind: "budget"; channelId: string; from: number; to: number }
	| { kind: "bidCpc"; channelId: string; from: number; to: number }
	| { kind: "enabled"; channelId: string; from: boolean; to: boolean };

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
	const next = structuredClone(strategy);
	const changedFields = new Set<string>();
	for (const change of changes) {
		if (
			!change ||
			!["budget", "bidCpc", "enabled"].includes(change.kind) ||
			typeof change.channelId !== "string"
		)
			throw new Error("invalid strategy change");
		const field = JSON.stringify([change.channelId, change.kind]);
		if (changedFields.has(field)) throw new Error("duplicate strategy change");
		changedFields.add(field);
		if (
			!Object.hasOwn(next.channels, change.channelId) ||
			["__proto__", "prototype", "constructor"].includes(change.channelId)
		)
			throw new Error("unknown channel");
		const channel = next.channels[change.channelId];
		if (!channel) throw new Error("unknown channel");
		if (channel[change.kind] !== change.from)
			throw new Error("stale strategy change");
		if (change.kind === "enabled") {
			if (typeof change.from !== "boolean" || typeof change.to !== "boolean")
				throw new Error("invalid enabled change");
			channel.enabled = change.to;
		} else {
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
	}
	return next;
}
