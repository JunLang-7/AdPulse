/**
 * 投放方式与各自的效果口径。
 *
 * README 承诺「平台付费广告」与「达人合作与内容种草」不能强行使用同一种效果
 * 衡量方式。这里把「哪种投放方式用哪组指标」集中定义，避免各处用字段名猜口径。
 *
 * 旧数据没有 placementType，一律按 paid_ads 读取，无需迁移。
 * 指标集是探索阶段的假设，集中在此处，访谈结论出来后可调整而不散落。
 */
export const placementTypes = ["paid_ads", "influencer", "seeding"] as const;
export type PlacementType = (typeof placementTypes)[number];

/** 派生单位成本指标，同时是任务规则 metricKey 的允许值。 */
export type PlacementMetricKey = "cost_per_consultation" | "cost_per_engagement";
/** 所有可能出现的指标键，集中定义避免各处用字符串猜。 */
export type MetricKey =
	| "spendMinor"
	| "consultations"
	| "feeMinor"
	| "contentCostMinor"
	| "engagement"
	| PlacementMetricKey;

export interface MetricDefinition {
	definition: string;
	formula: string;
	sourceField: string;
}

export interface PlacementSpec {
	type: PlacementType;
	/** 展示用名称。 */
	label: string;
	/** 投入金额指标键。 */
	spendKey: MetricKey;
	/** 结果计数指标键。 */
	countKey: MetricKey;
	/** 派生单位成本指标键，同时是任务规则 metricKey 的允许值。 */
	derivedKey: PlacementMetricKey;
	labels: { spend: string; count: string; derived: string };
	/** 该口径必需的原始指标键；metricsContract 与 values 都按它校验。 */
	requiredMetricKeys: readonly [string, string];
	/** 只有付费广告有点击出价这个旋钮。 */
	supportsBidCpc: boolean;
	/** 必须随结论一起保留的归因局限，不能被换算掉。 */
	attributionNote: string;
}

const paidAds: PlacementSpec = {
	type: "paid_ads",
	label: "平台付费广告",
	spendKey: "spendMinor",
	countKey: "consultations",
	derivedKey: "cost_per_consultation",
	labels: { spend: "投放花费", count: "咨询次数", derived: "单次咨询成本" },
	requiredMetricKeys: ["spendMinor", "consultations"],
	supportsBidCpc: true,
	attributionNote:
		"咨询次数沿用导入报表的定义与归因窗口；外部讨论热度不等于咨询或成交。",
};

const influencer: PlacementSpec = {
	type: "influencer",
	label: "达人合作",
	spendKey: "feeMinor",
	countKey: "engagement",
	derivedKey: "cost_per_engagement",
	labels: { spend: "合作费用", count: "互动量", derived: "单次互动成本" },
	requiredMetricKeys: ["feeMinor", "engagement"],
	supportsBidCpc: false,
	attributionNote:
		"互动量不等于咨询或成交；曝光、互动无法归因到成交，不能换算成单次咨询成本。",
};

const seeding: PlacementSpec = {
	type: "seeding",
	label: "内容种草",
	spendKey: "contentCostMinor",
	countKey: "engagement",
	derivedKey: "cost_per_engagement",
	labels: { spend: "内容成本", count: "互动量", derived: "单次互动成本" },
	requiredMetricKeys: ["contentCostMinor", "engagement"],
	supportsBidCpc: false,
	attributionNote:
		"互动量不等于咨询或成交；曝光、互动无法归因到成交，不能换算成单次咨询成本。",
};

export const placementSpecs: Readonly<Record<PlacementType, PlacementSpec>> = {
	paid_ads: paidAds,
	influencer,
	seeding,
};

/** 缺省视为付费广告；非法值直接拒绝，不静默降级。 */
export function normalizePlacementType(value: unknown): PlacementType {
	if (value === undefined || value === null) return "paid_ads";
	if (
		typeof value === "string" &&
		(placementTypes as readonly string[]).includes(value)
	)
		return value as PlacementType;
	throw new Error("invalid placement type");
}

export function placementSpec(value: unknown): PlacementSpec {
	return placementSpecs[normalizePlacementType(value)];
}

/** 任务规则的 metricKey 必须与该任务的投放方式口径一致。 */
export function isMetricKeyForPlacement(
	metricKey: string,
	placementType: unknown,
): boolean {
	return placementSpec(placementType).derivedKey === metricKey;
}

/**
 * 证据指标键只能是本口径的两个键之一，不能把其他口径的键混进来。
 *
 * 注意：允许缺某个键或值为 null —— 证据本来就允许「值缺失 / 来源为空」，
 * 比较引擎会据此给出 VALUE_MISSING / VALUE_NULL 并等待补证。这里只禁止混算。
 */
export function validatePlacementMetricKeys(
	placementType: unknown,
	keys: readonly string[],
): MetricKey[] {
	const spec = placementSpec(placementType);
	const allowed: readonly string[] = spec.requiredMetricKeys;
	if (
		keys.length > allowed.length ||
		new Set(keys).size !== keys.length ||
		keys.some((key) => !key || !allowed.includes(key))
	)
		throw new Error("invalid placement metrics");
	return [...spec.requiredMetricKeys] as MetricKey[];
}
