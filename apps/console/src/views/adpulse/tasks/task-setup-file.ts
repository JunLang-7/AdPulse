// Keep in sync with the TaskDraftExtractionInput brief limit in OpenAPI.
export const TASK_SETUP_BRIEF_LIMIT = 2_500;

const fileExtensions = [".txt", ".md", ".csv"];
export const TASK_SETUP_FILE_ACCEPT = fileExtensions.join(",");

// UTF-8 encoding uses at most three bytes per UTF-16 code unit, plus a BOM.
const maxFileBytes = TASK_SETUP_BRIEF_LIMIT * 3 + 3;
const unsupportedText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const tooLong = "文件内容超过 " + TASK_SETUP_BRIEF_LIMIT + " 字。请保留和推广任务相关的部分后重新选择。";

export async function readTaskSetupFile(
	file: Pick<File, "name" | "size" | "arrayBuffer">,
): Promise<string> {
	const name = file.name.toLowerCase();
	if (!fileExtensions.some((extension) => name.endsWith(extension)))
		throw new Error("请选择 .txt、.md 或 .csv 文本文件。");
	if (file.size > maxFileBytes) throw new Error(tooLong);

	let bytes: ArrayBuffer;
	try {
		bytes = await file.arrayBuffer();
	} catch {
		throw new Error("暂时无法读取这个文件，请重新选择。");
	}
	if (bytes.byteLength > maxFileBytes) throw new Error(tooLong);

	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("无法读取文件内容，请另存为 UTF-8 文本后重试。");
	}
	if (unsupportedText.test(text) || text.trimStart().startsWith("%PDF-"))
		throw new Error("无法识别为纯文本。请选择 .txt、.md 或 .csv 文本文件。");
	if (!text.trim()) throw new Error("这个文件没有可读取的文字。");
	if (text.length > TASK_SETUP_BRIEF_LIMIT) throw new Error(tooLong);
	return text;
}
