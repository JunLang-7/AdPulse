// 验收脚本共用的 HTTP 与错误归因工具。

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 发请求并按 JSON 解析响应体。解析失败时保留前 120 字符原文，避免整段写进记录。
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ timeoutMs?: number }} [options]
 */
export async function callJson(url, init = {}, options = {}) {
	const response = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = { raw: text.slice(0, 120) };
	}
	return { response, body };
}

export function httpStatus(error) {
	return error instanceof Error ? error.status : undefined;
}

/** 把网络/解析错误压成一行稳定标识，供记录与判读使用。 */
export function errorReason(error) {
	return (
		error?.cause?.code ??
		error?.cause?.errors?.[0]?.code ??
		error?.cause?.message ??
		error?.name ??
		"unknown"
	)
		.toString()
		.slice(0, 80);
}
