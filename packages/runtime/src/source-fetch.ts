import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import {
	SourceFetchError,
	type FetchedResource,
	type SourceFetcher,
} from "@adpluse/core";

/** Only markup/plain payloads are list pages or robots files. */
export function isAllowedContentType(value: string | undefined): boolean {
	if (!value) return true;
	return /^(text\/|application\/(xml|json|xhtml\+xml))/i.test(value.trim());
}

const USER_AGENT =
	"AdPulseSourceBot/0.1 (+https://github.com/JunLang-7/AdPulse)";
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Blocks loopback, private, link-local, CGNAT and metadata ranges. */
export function isPublicAddress(address: string): boolean {
	if (address.includes(":")) {
		const normalized = address.toLowerCase();
		if (normalized === "::1" || normalized === "::") return false;
		if (normalized.startsWith("fe8") || normalized.startsWith("fe9")) return false;
		if (normalized.startsWith("fea") || normalized.startsWith("feb")) return false;
		if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
		return mapped?.[1] ? isPublicAddress(mapped[1]) : true;
	}
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((part) => Number.isNaN(part)))
		return false;
	const [a, b] = octets as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a >= 224) return false;
	return true;
}

async function resolvePublic(hostname: string): Promise<string> {
	const results = await lookup(hostname, { all: true });
	if (results.length === 0) throw new SourceFetchError("network", "no address");
	for (const entry of results)
		if (!isPublicAddress(entry.address))
			throw new SourceFetchError("blocked", "non-public address");
	const first = results[0];
	if (!first) throw new SourceFetchError("network", "no address");
	return first.address;
}

function readBody(
	response: IncomingMessage,
	maxBytes: number,
): Promise<{ bytes: number; body: string }> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		response.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBytes) {
				response.destroy();
				reject(new SourceFetchError("too_large", "response exceeds limit"));
				return;
			}
			chunks.push(chunk);
		});
		response.on("end", () =>
			resolve({ bytes, body: Buffer.concat(chunks).toString("utf8") }),
		);
		response.on("error", (error) =>
			reject(new SourceFetchError("network", error.message)),
		);
	});
}

function once(
	url: URL,
	address: string,
	limits: { maxBytes: number; timeoutMs: number },
): Promise<{ status: number; bytes: number; body: string; location: string | null }> {
	return new Promise((resolve, reject) => {
		const options = {
			protocol: url.protocol,
			host: address,
			servername: url.hostname,
			port: url.port || 443,
			path: `${url.pathname}${url.search}`,
			method: "GET",
			headers: {
				Host: url.host,
				"User-Agent": USER_AGENT,
				Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
				"Accept-Encoding": "identity",
			},
		};
		const create = url.protocol === "http:" ? httpRequest : httpsRequest;
		const req = create(options, async (response) => {
			try {
				if (response.headers["content-encoding"] !== undefined)
					throw new SourceFetchError("blocked", "compressed responses refused");
				const contentType = response.headers["content-type"];
				if (!isAllowedContentType(typeof contentType === "string" ? contentType : undefined))
					throw new SourceFetchError("blocked", "unexpected content type");
				const location = response.headers.location ?? null;
				if (response.statusCode && REDIRECT_STATUS.has(response.statusCode)) {
					response.resume();
					resolve({ status: response.statusCode, bytes: 0, body: "", location });
					return;
				}
				const read = await readBody(response, limits.maxBytes);
				resolve({
					status: response.statusCode ?? 0,
					bytes: read.bytes,
					body: read.body,
					location,
				});
			} catch (error) {
				reject(error);
			}
		});
		req.setTimeout(limits.timeoutMs, () =>
			req.destroy(new SourceFetchError("network", "request timed out")),
		);
		req.on("error", (error) =>
			reject(
				error instanceof SourceFetchError
					? error
					: new SourceFetchError("network", error.message),
			),
		);
		req.end();
	});
}

/** HTTPS-only client pinned to pre-resolved public addresses. */
export class HttpSourceFetcher implements SourceFetcher {
	constructor(private allowedHosts: string[]) {}

	async fetchText(
		rawUrl: string,
		limits: { maxBytes: number; timeoutMs: number },
	): Promise<FetchedResource> {
		let url = new URL(rawUrl);
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			if (url.protocol !== "https:")
				throw new SourceFetchError("blocked", "https required");
			if (!this.allowedHosts.includes(url.hostname.toLowerCase()))
				throw new SourceFetchError("blocked", "host not allowlisted");
			const address = await resolvePublic(url.hostname);
			const result = await once(url, address, limits);
			if (result.location && result.status && REDIRECT_STATUS.has(result.status)) {
				if (hop === MAX_REDIRECTS)
					throw new SourceFetchError("redirect", "too many redirects");
				url = new URL(result.location, url);
				continue;
			}
			return { status: result.status, bytes: result.bytes, body: result.body };
		}
		throw new SourceFetchError("redirect", "too many redirects");
	}
}
