// 脱敏工具：验收产物里只允许出现脱敏后的标识与地址。
// 所有脚本（自检、场景驱动器、记录生成）必须经这一层输出，不得各自实现。

export function mask(value, head = 6, tail = 2) {
	if (!value) return "(缺失)";
	if (value.length <= head + tail) return "*".repeat(value.length);
	return `${value.slice(0, head)}***${tail > 0 ? value.slice(-tail) : ""}`;
}

/** 公网地址只保留路径与脱敏后的主机名，避免把内部域名完整写进记录。 */
export function maskUrl(value) {
	try {
		const url = new URL(value);
		const [, ...rest] = url.hostname.split(".");
		const isIp =
			/^\d+(\.\d+){3}$/.test(url.hostname) || url.hostname.includes(":");
		const host = isIp ? url.hostname : rest.length ? `***.${rest.join(".")}` : "***";
		return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${url.pathname}`;
	} catch {
		return mask(value, 12, 4);
	}
}

export function redactDatabaseUrl(value) {
	try {
		const url = new URL(value);
		const database = url.pathname.replace(/^\//, "");
		return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}/${database}`;
	} catch {
		return "(无法解析)";
	}
}

export function maskBody(body) {
	if (body === undefined) return "(无响应体)";
	const text = JSON.stringify(body);
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
