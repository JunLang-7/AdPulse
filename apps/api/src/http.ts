import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
export async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += buffer.length;
		if (length > 256 * 1024) throw new HttpError(413, "request too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}
export async function readJson(req: IncomingMessage): Promise<unknown> {
	if (!req.headers["content-type"]?.startsWith("application/json"))
		throw new HttpError(415, "JSON required");
	try {
		return JSON.parse((await readBody(req)).toString("utf8"));
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(400, "invalid JSON");
	}
}
export function json(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(body));
}
