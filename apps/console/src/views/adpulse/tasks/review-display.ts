import type { components } from "../../../adpulse-client";
import { formatBeijingPeriod, formatBeijingTime } from "./task-form";
import { placementLabels } from "./placement-display";

type EvidenceVersion = components["schemas"]["EvidenceVersion"];
type EvidenceCurrency = components["schemas"]["EvidenceCurrency"];
type RatioValue = components["schemas"]["RatioValue"];
type ReasonCode = components["schemas"]["ComparisonReason"]["code"];

export const reviewReasonLabels: Record<ReasonCode, string> = {
	NO_BASELINE: "还没有选对照报表",
	TASK_MISMATCH: "两份报表属于不同的推广任务",
	ACCOUNT_MISMATCH: "两份报表来自不同的投放账号",
	SOURCE_MISSING: "有一份报表缺少来源信息",
	SCOPE_MISMATCH: "两份报表覆盖的推广范围不同",
	PLACEMENT_TYPE_MISMATCH: "两份报表来自不同投放方式，效果口径不同，不能直接比较",
	RULE_PLACEMENT_MISMATCH: "任务设置的衡量口径与报表口径不一致",
	METRICS_CONTRACT_MISMATCH: "两份报表的指标统计方式不同",
	CURRENCY_MISMATCH: "两份报表使用的币种或金额单位不同",
	ATTRIBUTION_MISMATCH: "两份报表认定哪些咨询来自广告的方式不同",
	TIME_ZONE_MISMATCH: "两份报表使用的统计时区不同",
	PERIOD_INVALID: "报表的统计时间有误",
	PERIOD_OVERLAP: "两份报表的统计时间有重叠",
	PERIOD_NOT_ADJACENT: "两份报表的统计时间没有接在一起",
	DURATION_MISMATCH: "两份报表覆盖的天数不同",
	PERIOD_INCOMPLETE: "报表还缺少部分时段的数据",
	CALLBACK_PENDING: "平台的咨询数据还在更新",
	CALLBACK_UNKNOWN: "暂时无法确认平台的咨询数据是否已更新完",
	VALUE_MISSING: "报表缺少花费或咨询数据",
	VALUE_NULL: "报表的花费或咨询一栏留空",
	VALUE_INVALID: "报表里的花费或咨询数有误",
	RULE_METRIC_MISSING: "任务还没有设置要检查的成本指标",
	RULE_METRIC_UNSUPPORTED: "当前投放方式不支持这个成本指标，请检查口径设置",
	RULE_THRESHOLD_MISSING: "还没有设置成本提醒线",
	RULE_CURRENCY_MISSING: "成本提醒还没有设置币种",
	RULE_UNIT_MISSING: "成本提醒还没有设置金额单位",
	RULE_WINDOW_MISSING: "成本提醒还没有设置统计天数",
	RULE_MINIMUMS_MISSING: "还没有设置触发提醒所需的最低花费或咨询数",
	RULE_CURRENCY_MISMATCH: "报表与成本提醒使用的币种不同",
	RULE_UNIT_MISMATCH: "报表与成本提醒使用的金额单位不同",
	WINDOW_MISMATCH: "报表天数与成本提醒设置的天数不同",
	SAMPLE_BELOW_MINIMUM: "花费或咨询数还没有达到检查条件",
	ZERO_DENOMINATOR: "咨询次数为零，暂时算不出每次成本",
};

export function formatReviewCount(value: number | null | undefined, unit = "次"): string {
	if (value === undefined) return "未提供";
	if (value === null) return "报表留空";
	return `${value.toLocaleString("zh-CN")} ${unit}`;
}

export function formatReviewAmount(
	minor: number | null | undefined,
	currency: EvidenceCurrency,
	perConsultation = false,
): string {
	if (minor == null) return formatReviewCount(minor);
	const value = minor / currency.minorUnitsPerMajor;
	const unit = currency.code === "CNY" ? "元" : currency.code;
	const digits = Math.max(2, String(currency.minorUnitsPerMajor - 1).length);
	const smallestDisplayed = 10 ** -digits;
	const amount = value > 0 && value < smallestDisplayed
		? `小于 ${smallestDisplayed.toLocaleString("zh-CN", { maximumFractionDigits: digits })}`
		: value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
	return `${amount} ${unit}${perConsultation ? "/次" : ""}`;
}

export function formatReviewCost(value: RatioValue, currency: EvidenceCurrency): string {
	return formatReviewAmount(value.numeratorMinor / value.denominatorConsultations, currency, true);
}

export function reportChoiceLabel(item: EvidenceVersion): string {
	const spec = placementLabels(item.placementType);
	return [
		formatBeijingPeriod(item.period),
		formatReviewAmount(item.values[spec.spendKey], item.currency),
		formatReviewCount(item.values[spec.countKey]),
		`录入于 ${formatBeijingTime(item.createdAt)}`,
	].join(" · ");
}
