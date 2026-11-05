import type { IncomingMessage, ServerResponse } from "node:http";
import type { Runtime } from "@adpluse/runtime";
import { readBody } from "../http.js";

export async function handleWebhook(
	req: IncomingMessage,
	res: ServerResponse,
	runtime: Runtime,
	accountId: string,
): Promise<void> {
	const rawBody = await readBody(req);
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(req.headers))
		if (typeof value === "string") headers[key] = value;
	const response = await runtime.channels.handle(
		accountId,
		{
			method: req.method ?? "POST",
			url: req.url ?? "/",
			headers,
			rawBody,
		},
		runtime.decisions,
	);
	res.statusCode = response.status;
	for (const [key, value] of Object.entries(response.headers))
		res.setHeader(key, value);
	res.end(response.body);
}
