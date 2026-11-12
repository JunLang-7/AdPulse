import type { Row, SheetData } from "read-excel-file/browser";
import type { components } from "../../../generated/api.js";
import { parseYuan } from "./task-form.ts";

type TaskRules = components["schemas"]["TaskRules"];
export type QuickReviewInput = { spend: string; consultations: string };

function parseConsultations(value: string, label: string): number | undefined {
	const text = value.trim();
	if (!text) return undefined;
	const count = Number(text);
	if (!/^\d+(?:\.0+)?$/.test(text) || !Number.isSafeInteger(count))
		throw new Error(`${label}请填写大于或等于 0 的整数。`);
	return count;
}

export function estimateReview(input: QuickReviewInput, rules: TaskRules) {
	const spendMinor = parseYuan(input.spend, "投放花费");
	const consultations = parseConsultations(input.consultations, "咨询次数");
	const totals = { spendMinor, consultations };
	if (spendMinor === undefined || !consultations) return totals;

	const spend = BigInt(spendMinor);
	const count = BigInt(consultations);
	const unitCostMinor = Number((spend + count / 2n) / count);
	const estimate = { ...totals, unitCostMinor };
	const limitMinor = rules.alertThresholdMinor;
	if (rules.metricKey !== "cost_per_consultation" || rules.currency !== "CNY" ||
		rules.unit !== "分" || limitMinor === undefined) return estimate;
	const belowMinimum = spendMinor < (rules.minimumSpendMinor ?? 0) ||
		consultations < (rules.minimumConsultations ?? 0);
	return {
		...estimate,
		limit: {
			minor: limitMinor,
			belowMinimum,
			exceeded: spend > BigInt(limitMinor) * count,
		},
	};
}

const spendHeaders = new Set(["花费", "投放花费", "广告花费", "消耗", "广告消耗", "消费", "spend", "cost"]);
const consultationHeaders = new Set(["咨询", "咨询次数", "咨询量", "咨询数", "consultations"]);
const currencyHeaders = new Set(["币种", "货币", "货币单位", "金额单位", "currency", "currencycode", "currencyunit"]);
const foreignCurrency = /\b(?:USD|HKD|EUR|GBP|JPY|KRW|TWD|CAD|AUD|SGD|INR)\b|美元|港[元币]|欧元|英镑|日[元圆]|円|韩[元圆]|台币|卢比|[$€£₩₹]/i;
const nonYuanUnit = /\((?:单位:)?(?:人民币)?分\)$|(?:人民币分|单位:分)$|[百千万亿]元|\b(?:FEN|CENTS?)\b/i;
const nonConsultationMetric = /线索|咨询人数|\(人\)|\bleads?\b/i;

export function cellText(cell: Row<string>[number] | undefined): string {
	return cell instanceof Date ? cell.toISOString().replace(/T00:00:00\.000Z$/, "") : String(cell ?? "").trim();
}

function columnKind(title: string): keyof QuickReviewInput | undefined {
	const name = title.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
	if (spendHeaders.has(name.replace(/\((?:人民币元|元|cny|rmb)\)$/, ""))) return "spend";
	if (consultationHeaders.has(name.replace(/\(次\)$/, ""))) return "consultations";
}

export function suggestReviewColumns(header: Row<string>): Record<keyof QuickReviewInput, string> {
	const matches: Record<keyof QuickReviewInput, string[]> = { spend: [], consultations: [] };
	header.forEach((cell, index) => {
		const kind = columnKind(cellText(cell));
		if (kind) matches[kind].push(String(index));
	});
	return {
		spend: matches.spend.length === 1 ? matches.spend[0] : "",
		consultations: matches.consultations.length === 1 ? matches.consultations[0] : "",
	};
}

export function findReviewHeader(data: SheetData<string>): number {
	const candidates = data.slice(0, 30).map((row, index) => ({
		index, kinds: new Set(row.map((cell) => columnKind(cellText(cell))).filter(Boolean)).size,
	}));
	return candidates.find(({ kinds }) => kinds === 2)?.index ??
		candidates.find(({ kinds }) => kinds === 1)?.index ??
		Math.max(0, data.findIndex((row) => row.some((cell) => cellText(cell) !== "")));
}

export function isYuanColumn(title: string): boolean {
	const normalized = title.normalize("NFKC").replace(/\s+/g, "");
	return /\((?:单位:)?(?:人民币元|元|CNY|RMB)\)$|人民币元$/i.test(normalized);
}

function hasNonYuanCurrency(header: Row<string>, row: Row<string>): boolean {
	return header.some((cell, index) => {
		const name = cellText(cell).normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, "");
		if (!currencyHeaders.has(name)) return false;
		const unit = cellText(row[index]).normalize("NFKC");
		return foreignCurrency.test(unit) || nonYuanUnit.test(unit) ||
			/^(?:人民币)?分$/.test(unit) || (/^[A-Z]{3}$/i.test(unit) && !/^(?:CNY|RMB)$/i.test(unit));
	});
}

export function reviewInputFromRow(
	row: Row<string>,
	header: Row<string>,
	columns: QuickReviewInput,
): QuickReviewInput {
	if (columns.spend && columns.spend === columns.consultations)
		throw new Error("请为花费和咨询次数选择不同的列。");
	const spendColumn = cellText(header[Number(columns.spend)]).normalize("NFKC").replace(/_/g, " ");
	if (columns.spend && (foreignCurrency.test(spendColumn) ||
		nonYuanUnit.test(spendColumn.replace(/\s*([():])\s*/g, "$1")) || hasNonYuanCurrency(header, row)))
		throw new Error("花费列的单位不是人民币元。请换一列，或换算后手动填写。");
	const consultationColumn = cellText(header[Number(columns.consultations)]).normalize("NFKC").replace(/_/g, " ");
	if (columns.consultations && nonConsultationMetric.test(consultationColumn))
		throw new Error("这一列的口径和咨询次数不同，请选择咨询次数列或暂不带入。");

	const numericText = (value: string, money = false) => {
		const text = value.normalize("NFKC");
		const trimmed = money ? text.replace(/^¥\s*/, "").replace(/\s*元$/, "") : text;
		return /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(trimmed) ? trimmed.replace(/,/g, "") : trimmed;
	};
	const spend = columns.spend ? numericText(cellText(row[Number(columns.spend)]), true) : "";
	const consultations = columns.consultations ? numericText(cellText(row[Number(columns.consultations)])) : "";
	parseYuan(spend, "这一行的花费");
	parseConsultations(consultations, "这一行的咨询次数");
	return { spend, consultations };
}
