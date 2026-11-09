import type { components } from "../../../generated/api.js";

type EvidenceImportInput = components["schemas"]["EvidenceImportInput"];
type EvidenceRecordInput = components["schemas"]["EvidenceRecordInput"];

const maxReportBytes = 256 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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
	if (!isObject(report)) throw new Error("请选择按 AdPulse 格式准备的报表。");
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
	// The API validates each record and preserves the original fields and values.
	return report as EvidenceImportInput;
}

export async function readEvidenceCorrection(file: File): Promise<EvidenceRecordInput> {
	const report = await readReportFile(file);
	if (!isObject(report.source) || !isObject(report.period))
		throw new Error("请选择一份单区间更正文件。");
	// The API validates the record and checks it matches the original evidence.
	return report as EvidenceRecordInput;
}
