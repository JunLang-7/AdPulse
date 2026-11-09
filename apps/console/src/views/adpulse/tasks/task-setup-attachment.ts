/// <reference types="vite/client" />

import { readTaskSetupFile, TASK_SETUP_FILE_ACCEPT } from "./task-setup-file.ts";

const documentExtensions = [".pdf", ".docx", ".xlsx"];
export const TASK_SETUP_ATTACHMENT_ACCEPT = [TASK_SETUP_FILE_ACCEPT, ...documentExtensions].join(",");
export const TASK_SETUP_PREVIEW_LIMIT = 30_000;

const maxDocumentBytes = 8 * 1024 * 1024;
const maxArchiveBytes = 32 * 1024 * 1024;
const maxArchiveEntries = 1_000;
const maxPdfPages = 40;

class AttachmentError extends Error {}

async function checkOfficeArchive(bytes: ArrayBuffer, requiredEntry: string) {
	const { unzipSync } = await import("fflate");
	let expandedBytes = 0;
	let entries = 0;
	let valid = false;
	const workbook = requiredEntry === "xl/workbook.xml";
	const relationshipPath = "xl/_rels/workbook.xml.rels";
	const data = new Uint8Array(bytes);
	const parts = unzipSync(data, {
		filter(file) {
			expandedBytes += file.originalSize;
			entries++;
			if (entries > maxArchiveEntries || expandedBytes > maxArchiveBytes)
				throw new AttachmentError("文档结构过大，请另存只包含相关内容的文件后重试。");
			if (file.name === requiredEntry) valid = true;
			return workbook && file.name === relationshipPath;
		},
	});
	if (!valid) throw new AttachmentError("文件内容与扩展名不一致，请用原应用另存为后重试。");
	if (!workbook) return;
	const relationships = new TextDecoder("utf-8", { fatal: true }).decode(parts[relationshipPath]);
	if (/<!DOCTYPE\s/.test(relationships)) throw new AttachmentError("无法识别工作表列表，请另存为 .xlsx 后重试。");
	const list = new DOMParser().parseFromString(relationships, "application/xml");
	if (list.documentElement.localName !== "Relationships" || list.getElementsByTagName("parsererror").length)
		throw new AttachmentError("无法识别工作表列表，请另存为 .xlsx 后重试。");
	const targets = new Set<string>();
	for (const relation of list.getElementsByTagNameNS("*", "Relationship")) {
		if (!relation.getAttribute("Type")?.endsWith("/worksheet")) continue;
		const target = relation.getAttribute("Target");
		if (!target || relation.getAttribute("TargetMode") === "External")
			throw new AttachmentError("请将外部工作表复制到文件中后重试。");
		targets.add(target.startsWith("/") ? target.slice(1) : "xl/" + target);
	}
	const sheets = unzipSync(data, { filter: ({ name }) => targets.has(name) });
	const { checkXlsxWorksheetCoordinates } = await import("./task-setup-xlsx-guard.js");
	let cells = 0;
	for (const target of targets) {
		try {
			if (!Object.prototype.hasOwnProperty.call(sheets, target)) throw new Error("无法找到工作表，请另存为 .xlsx 后重试。");
			cells += checkXlsxWorksheetCoordinates(new TextDecoder("utf-8", { fatal: true }).decode(sheets[target]));
			if (cells > 500_000) throw new Error("表格范围过大，请另存相关工作表后重试。");
		} catch (error) {
			throw new AttachmentError(error instanceof Error ? error.message : "无法读取工作表。");
		}
	}
}

type DocumentText = { text: string; pagesWithoutText?: number };

async function readPdf(bytes: ArrayBuffer): Promise<DocumentText> {
	const [pdf, worker, { TaskPdfBinaryData }] = await Promise.all([
		import("pdfjs-dist"),
		import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
		import("./task-setup-pdf-assets.js"),
	]);
	pdf.GlobalWorkerOptions.workerSrc = worker.default;
	const loading = pdf.getDocument({
		data: new Uint8Array(bytes),
		useWorkerFetch: false,
		BinaryDataFactory: TaskPdfBinaryData,
		cMapPacked: true,
		useWasm: false,
		disableFontFace: true,
	});
	try {
		const document = await loading.promise;
		if (document.numPages > maxPdfPages)
			throw new AttachmentError("PDF 超过 40 页，请另存所需页面后重试。");
		let text = "";
		let pagesWithoutText = 0;
		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
			const page = await document.getPage(pageNumber);
			try {
				const content = await page.getTextContent();
				const pageText = content.items.map((item) => "str" in item
					? item.str + (item.hasEOL ? "\n" : "")
					: "").join("").trim();
				if (pageText) text += (text ? "\n\n" : "") + pageText;
				else pagesWithoutText++;
				if (text.length > TASK_SETUP_PREVIEW_LIMIT) break;
			} finally {
				page.cleanup();
			}
		}
		if (!text) throw new AttachmentError("PDF 里没有可复制的文字。扫描版请先做文字识别，再选择文件。");
		return { text, ...(pagesWithoutText ? { pagesWithoutText } : {}) };
	} catch (error) {
		if (error instanceof pdf.PasswordException)
			throw new AttachmentError("这是加密 PDF，请先在原应用中另存为可读取的副本。");
		throw error;
	} finally {
		await loading.destroy();
	}
}

async function readWorkbookRows<ParsedNumber = number>(
	bytes: ArrayBuffer,
	parseNumber?: (value: string) => ParsedNumber,
) {
	await checkOfficeArchive(bytes, "xl/workbook.xml");
	const { default: readWorkbook } = await import("read-excel-file/browser");
	return readWorkbook<ParsedNumber>(bytes, parseNumber ? { parseNumber } : undefined);
}

export async function readReviewWorkbook(file: File) {
	if (!file.name.toLowerCase().endsWith(".xlsx"))
		throw new AttachmentError("请选择 Excel（.xlsx）文件。");
	if (file.size > maxDocumentBytes)
		throw new AttachmentError("文件超过 8 MB，请把所需工作表另存后重试。");
	try {
		return await readWorkbookRows(await file.arrayBuffer(), (value) => value);
	} catch (error) {
		if (error instanceof AttachmentError) throw error;
		throw new AttachmentError("无法读取这份表格，请用 Excel 或 WPS 另存为 .xlsx 后重试。");
	}
}

async function readDocument(bytes: ArrayBuffer, extension: string): Promise<DocumentText> {
	if (extension === ".pdf") return readPdf(bytes);
	if (extension === ".docx") {
		await checkOfficeArchive(bytes, "word/document.xml");
		const { default: mammoth } = await import("mammoth");
		return { text: (await mammoth.extractRawText({ arrayBuffer: bytes })).value };
	}

	const sheets = await readWorkbookRows(bytes);
	let text = "";
	for (const { sheet, data } of sheets) {
		let rows = "";
		for (const row of data) {
			const cells = row.map((value) => value instanceof Date ? value.toISOString().replace(/T00:00:00\.000Z$/, "") : String(value ?? ""));
			if (cells.some((cell) => cell.trim())) rows += (rows ? "\n" : "") + cells.join("\t").trimEnd();
			if (text.length + rows.length > TASK_SETUP_PREVIEW_LIMIT) break;
		}
		if (rows) text += (text ? "\n\n" : "") + sheet + "\n" + rows;
		if (text.length > TASK_SETUP_PREVIEW_LIMIT) break;
	}
	return { text };
}

export async function readTaskSetupAttachment(file: File): Promise<DocumentText & { clipped: boolean }> {
	const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
	if (TASK_SETUP_FILE_ACCEPT.split(",").includes(extension))
		return { text: await readTaskSetupFile(file), clipped: false };
	if (!documentExtensions.includes(extension))
		throw new AttachmentError("请选择 PDF、Word（.docx）、Excel（.xlsx）、TXT、Markdown 或 CSV。");
	if (file.size > maxDocumentBytes) throw new AttachmentError("文档超过 8 MB，请另存所需部分后重试。");
	let raw: DocumentText;
	try {
		raw = await readDocument(await file.arrayBuffer(), extension);
	} catch (error) {
		if (error instanceof AttachmentError) throw error;
		throw new AttachmentError("无法读取这个文档，请确认格式正确且文件可以在原应用中打开。");
	}
	const text = raw.text.trim();
	if (!text) throw new AttachmentError("这个文档没有可读取的文字。");
	if (text.length <= TASK_SETUP_PREVIEW_LIMIT) return { ...raw, text, clipped: false };
	return { ...raw, text: text.slice(0, TASK_SETUP_PREVIEW_LIMIT).replace(/[\uD800-\uDBFF]$/, ""), clipped: true };
}
