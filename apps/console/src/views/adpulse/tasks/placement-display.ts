/**
 * 投放方式的展示口径。
 *
 * 后端用同一套通用投影字段保存比较结果（历史契约），但不同投放方式的
 * 指标含义不同；展示层必须按口径标注，不能把所有口径都叫「投放花费 / 咨询次数」。
 * 这里只放标签与说明，不产生任何结论或换算。
 */
export type PlacementType = "paid_ads" | "influencer" | "seeding";

export interface PlacementLabels {
	type: PlacementType;
	name: string;
	spend: string;
	count: string;
	derived: string;
	spendKey: string;
	countKey: string;
	attributionNote: string;
}

const labels = {
	paid_ads: {
		name: "平台付费广告",
		spend: "投放花费",
		count: "咨询次数",
		derived: "单次咨询成本",
		spendKey: "spendMinor",
		countKey: "consultations",
		attributionNote: "咨询次数沿用导入报表的定义与归因窗口；讨论热度不等于咨询或成交。",
	},
	influencer: {
		name: "达人合作",
		spend: "合作费用",
		count: "互动量",
		derived: "单次互动成本",
		spendKey: "feeMinor",
		countKey: "engagement",
		attributionNote: "互动量不等于咨询或成交；曝光、互动无法归因到成交，不能换算成单次咨询成本。",
	},
	seeding: {
		name: "内容种草",
		spend: "内容成本",
		count: "互动量",
		derived: "单次互动成本",
		spendKey: "contentCostMinor",
		countKey: "engagement",
		attributionNote: "互动量不等于咨询或成交；曝光、互动无法归因到成交，不能换算成单次咨询成本。",
	},
} as const;

/** 旧数据没有类型，一律按付费广告展示。 */
export function normalizePlacement(value: string | undefined | null): PlacementType {
	return value === "influencer" || value === "seeding" ? value : "paid_ads";
}

export function placementLabels(
	value: string | undefined | null,
): PlacementLabels {
	const type = normalizePlacement(value);
	return { type, ...labels[type] };
}

export function derivedLabel(metricKey: string | undefined, placement: string | undefined | null): string {
	if (metricKey === "cost_per_engagement") return "单次互动成本";
	if (metricKey === "cost_per_consultation") return "单次咨询成本";
	return placementLabels(placement).derived;
}
