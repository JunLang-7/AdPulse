import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebhookError } from "@adpluse/channels";
import {
	EvidenceConflictError,
	EvidenceValidationError,
	TaskInputValidationError,
} from "@adpluse/core";
import type { Runtime } from "@adpluse/runtime";
import { ZodError } from "zod";
import { HttpError, json } from "./http.js";
import { handleAdmin } from "./routes/admin.js";
import { handleWebhook } from "./routes/webhooks.js";

export function createApi(
	runtime: Runtime,
	auth: { token: string; userId: string },
) {
	if (auth.token.length < 24 || !auth.userId)
		throw new Error("console token must be at least 24 characters");
	const server = createServer(async (req, res) => {
		try {
			const path = new URL(req.url ?? "/", "http://localhost").pathname;
			if (path === "/healthz" && req.method === "GET")
				return json(res, 200, { ok: true });
			const webhook = path.match(/^\/webhooks\/([^/]+)$/);
			if (webhook?.[1])
				return await handleWebhook(
					req,
					res,
					runtime,
					decodeURIComponent(webhook[1]),
				);
			if (path.startsWith("/api/")) {
				const received = Buffer.from(req.headers.authorization ?? "");
				const expected = Buffer.from(`Bearer ${auth.token}`);
				if (
					received.length !== expected.length ||
					!timingSafeEqual(received, expected)
				)
					throw new HttpError(401, "unauthorized");
				return await handleAdmin(req, res, runtime, auth.userId, path);
			}
			throw new HttpError(404, "route not found");
		} catch (error) {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			if (error instanceof HttpError || error instanceof WebhookError)
				return json(res, error.status, { error: error.message });
			if (error instanceof TaskInputValidationError)
				return json(res, 400, { error: `invalid field: ${error.fieldPath}` });
			if (error instanceof EvidenceConflictError)
				return json(res, 409, { error: error.message });
			if (error instanceof EvidenceValidationError) {
				const status = ["task not found", "evidence not found"].includes(
					error.message,
				)
					? 404
					: 400;
				return json(res, status, { error: error.message });
			}
			if (
				error instanceof Error &&
				["idempotency conflict", "task version conflict"].includes(error.message)
			)
				return json(res, 409, { error: error.message });
			if (error instanceof Error && error.message === "task not found")
				return json(res, 404, { error: "task not found" });
			if (error instanceof Error && error.message === "task strategy mismatch")
				return json(res, 400, { error: error.message });
			if (error instanceof ZodError || error instanceof URIError)
				return json(res, 400, { error: "invalid request" });
			// Persistence failure must not produce a successful platform ACK.
			json(res, 503, { error: "temporarily unavailable" });
		}
	});
	server.requestTimeout = 15_000;
	server.headersTimeout = 10_000;
	return server;
}
