// 模型调用的受控出网层（#86 §7）。
// 与来源采集共用同一套地址判断：只允许 HTTPS、按 DNS 全部解析结果校验公网地址、
// 把连接绑定到已校验的地址（防 DNS rebinding）、禁止跟随重定向、不读取环境代理、
// 限制响应大小与超时。任何无法满足这些约束的请求都不发出。

import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { isPublicAddress } from "./source-fetch.js";

export const modelEgressTimeoutMs = 15_000;
export const modelEgressMaxBytes = 512 * 1024;

export class ModelEgressError extends Error {
	constructor(
		readonly reason: "blocked" | "network" | "too_large",
		message: string,
	) {
		super(message);
		this.name = "ModelEgressError";
	}
}

type EgressOptions = {
	/** 测试注入点；默认使用系统解析器。 */
	lookup?: typeof lookup;
	/** 测试注入点；默认使用 node:https。 */
	request?: typeof httpsRequest;
	timeoutMs?: number;
	maxBytes?: number;
};

function targetUrl(input: RequestInfo | URL): URL {
	let url: URL;
	try {
		url = new URL(input instanceof Request ? input.url : String(input));
	} catch {
		throw new ModelEgressError("blocked", "invalid target url");
	}
	if (url.protocol !== "https:")
		throw new ModelEgressError("blocked", "https required");
	if (url.username || url.password)
		throw new ModelEgressError("blocked", "credentials in url");
	return url;
}

/** 全部解析结果都必须是公网地址；混合答案直接拒绝，避免 rebinding。 */
async function pinnedAddress(url: URL, resolver: typeof lookup): Promise<string> {
	let results: { address: string; family: number }[];
	try {
		results = await (resolver as unknown as (
			hostname: string,
			options: { all: true },
		) => Promise<{ address: string; family: number }[]>)(url.hostname, { all: true });
	} catch {
		throw new ModelEgressError("network", "dns lookup failed");
	}
	if (results.length === 0) throw new ModelEgressError("network", "no address");
	for (const entry of results)
		if (!isPublicAddress(entry.address))
			throw new ModelEgressError("blocked", "non-public address");
	const first = results[0];
	if (!first) throw new ModelEgressError("network", "no address");
	return first.address;
}

function bodyOf(init: RequestInit | undefined): string | undefined {
	if (init?.body === undefined || init.body === null) return undefined;
	// 只支持我们自己的 JSON 请求体；不转发任意流或 FormData。
	if (typeof init.body === "string") return init.body;
	if (init.body instanceof Uint8Array) return Buffer.from(init.body).toString("utf8");
	throw new ModelEgressError("blocked", "unsupported request body");
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	const source = init?.headers;
	if (!source) return headers;
	const entries = source instanceof Headers ? [...source.entries()] : Array.isArray(source) ? source : Object.entries(source);
	for (const [name, value] of entries) {
		if (value === undefined) continue;
		// 由本层控制的头不允许被调用方覆盖。
		if (["host", "content-length", "connection", "transfer-encoding", "accept-encoding"].includes(name.toLowerCase()))
			continue;
		headers[name] = String(value);
	}
	return headers;
}

/**
 * 面向模型请求的 fetch 兼容实现。返回的 Response 带流式 body，pi-ai 可直接解析 SSE；
 * 3xx 不跟随，location 头被移除，调用方只会看到一个非 2xx 响应。
 */
export function createModelEgressFetch(options: EgressOptions = {}): typeof fetch {
	const resolver = options.lookup ?? lookup;
	const request = options.request ?? httpsRequest;
	const timeoutMs = options.timeoutMs ?? modelEgressTimeoutMs;
	const maxBytes = options.maxBytes ?? modelEgressMaxBytes;

	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = targetUrl(input);
		const address = await pinnedAddress(url, resolver);
		const body = bodyOf(init);
		const headers = headerRecord(init);
		headers.Host = url.host;
		headers["Accept-Encoding"] = "identity";
		if (body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(body, "utf8"));

		return await new Promise<Response>((resolve, reject) => {
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			const req = request({
				protocol: "https:",
				host: address,
				servername: url.hostname,
				port: Number(url.port || 443),
				path: `${url.pathname}${url.search}`,
				method: init?.method ?? "GET",
				headers,
			}, (response: IncomingMessage) => {
				if (settled) {
					response.resume();
					return;
				}
				settled = true;
				const responseHeaders = new Headers();
				for (const [name, value] of Object.entries(response.headers)) {
					if (name === "location" || name === "content-encoding") continue;
					if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
					else if (value !== undefined) responseHeaders.set(name, value);
				}
				let bytes = 0;
				const reader = (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>).getReader();
				const limited = new ReadableStream<Uint8Array>({
					async pull(controller) {
						const { done, value } = await reader.read();
						if (done) {
							controller.close();
							return;
						}
						const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
						bytes += chunk.byteLength;
						if (bytes > maxBytes) {
							controller.error(new ModelEgressError("too_large", "response exceeds limit"));
							await reader.cancel();
							return;
						}
						controller.enqueue(chunk);
					},
					async cancel(reason) {
						await reader.cancel(reason);
					},
				});
				resolve(new Response(limited, {
					status: response.statusCode ?? 0,
					statusText: response.statusMessage ?? "",
					headers: responseHeaders,
				}));
			});
			req.setTimeout(timeoutMs, () => {
				req.destroy(new ModelEgressError("network", "request timed out"));
			});
			req.on("error", (error) => {
				fail(error instanceof ModelEgressError ? error : new ModelEgressError("network", error.message));
			});
			if (init?.signal) {
				if (init.signal.aborted) {
					req.destroy(new ModelEgressError("network", "aborted"));
					return;
				}
				init.signal.addEventListener("abort", () => {
					req.destroy(new ModelEgressError("network", "aborted"));
				}, { once: true });
			}
			if (body !== undefined) req.write(body);
			req.end();
		});
	}) as typeof fetch;
}
