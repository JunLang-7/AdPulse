import type { components } from "../../../generated/api.js";

type EvidenceImportInput = components["schemas"]["EvidenceImportInput"];
type EvidenceRecordInput = components["schemas"]["EvidenceRecordInput"];
export type ReportSummary = Pick<EvidenceRecordInput, "period" | "values" | "currency">;

const maxReportBytes = 256 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function isPreviewable(record: unknown): boolean {
	if (!isObject(record)) return false;
	const { period, values, currency } = record;
	const validNumber = (value: unknown) => value == null ||
		(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
	return isObject(period) && typeof period.startsAt === "string" &&
		typeof period.endsAt === "string" && Date.parse(period.startsAt) < Date.parse(period.endsAt) &&
		isObject(values) && validNumber(values.spendMinor) && validNumber(values.consultations) &&
		isObject(currency) && typeof currency.code === "string" && typeof currency.minorUnit === "string" &&
		typeof currency.minorUnitsPerMajor === "number" &&
		Number.isSafeInteger(currency.minorUnitsPerMajor) && currency.minorUnitsPerMajor > 0;
}

async function readReportFile(file: File): Promise<Record<string, unknown>> {
	if (file.size > maxReportBytes) throw new Error("请选择不超过 256 KB 的报表文件。");
	let contents: string;
	try {
		contents = await file.text();
	} catch {
		throw new Error("无法读取这个文件，请重新选择报表。");
	}
	let report: unknown;
	try {
		report = JSON.parse(contents.replace(/^\uFEFF/, ""));
	} catch {
		throw new Error("无法识别文件内容，请选择按 AdPulse 格式准备的报表。");
	}
	if (!isObject(report)) throw new Error("请选择为当前任务准备的报表文件。");
	return report;
}

export async function readEvidenceImport(
	file: File,
	taskRef: EvidenceImportInput["taskRef"],
): Promise<EvidenceImportInput> {
	const report = await readReportFile(file);
	if (
		report.schemaVersion !== 1 ||
		!Array.isArray(report.records) ||
		report.records.length < 1 ||
		report.records.length > 2 ||
		!report.records.every(isObject) ||
		!isObject(report.taskRef)
	)
		throw new Error("请选择为当前任务准备的报表文件，每个文件包含 1 或 2 个区间。");
	if (
		report.taskRef.taskId !== taskRef.taskId ||
		report.taskRef.taskVersion !== taskRef.taskVersion
	)
		throw new Error(
			`文件与当前任务或版本不匹配，请选择适用于本任务 v${taskRef.taskVersion} 的报表。`,
		);
	if (!report.records.every(isPreviewable))
		throw new Error("报表中的统计时间、花费或咨询次数无法读取，请核对原文件。");
	// The API validates each record and preserves the original fields and values.
	return report as EvidenceImportInput;
}

export async function readEvidenceCorrection(file: File): Promise<EvidenceRecordInput> {
	const report = await readReportFile(file);
	if (!isObject(report.source) || !isObject(report.period))
		throw new Error("请选择一份单区间更正文件。");
	if (!isPreviewable(report))
		throw new Error("更正文件中的统计时间、花费或咨询次数无法读取，请核对原文件。");
	// The API validates the record and checks it matches the original evidence.
	return report as EvidenceRecordInput;
}
