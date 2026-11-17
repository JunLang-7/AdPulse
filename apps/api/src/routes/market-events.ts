import type { IncomingMessage, ServerResponse } from "node:http";
import type { Runtime } from "@adpluse/runtime";
import { MarketEventError } from "@adpluse/core";
import { z } from "zod";
import { HttpError, json, readJson } from "../http.js";

const nonBlank = (max: number) => z.string().trim().min(1).max(max);
const citation = z.object({ sourceIndex: z.number().int().min(0).max(9), quote: nonBlank(2000) }).strict().nullable();
const input = z.object({
	occurrenceKey: nonBlank(200), title: nonBlank(200), type: z.enum(["announcement", "campaign", "product_launch"]),
	subject: z.object({ kind: z.enum(["brand", "competitor"]), name: nonBlank(200) }).strict(),
	eventTime: nonBlank(2000).nullable(), conditions: nonBlank(2000).nullable(),
	sources: z.array(z.object({
		url: z.string().max(2000).nullable(), publisher: nonBlank(200), content: z.string().min(1).max(30000).nullable(),
		scope: z.enum(["link_only", "title_only", "search_snippet", "excerpt", "full_text"]),
		origin: z.enum(["official", "repost", "search", "unknown"]),
		publishedAt: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable(), acquiredAt: z.iso.datetime({ offset: true }), limitations: z.string().max(2000),
	}).strict()).min(1).max(10),
	citations: z.object({ subject: citation, eventTime: citation, conditions: citation }).strict(),
	taskRefs: z.array(z.object({ taskId: nonBlank(128), taskVersion: z.number().int().min(1), reason: nonBlank(1000) }).strict()).max(20),
	provenance: z.object({ simulated: z.boolean(), reference: nonBlank(2000).nullable(), transformation: nonBlank(2000).nullable() }).strict(),
}).strict();
const revision = z.object({ expectedVersion: z.number().int().min(1), event: input, changeReason: nonBlank(1000) }).strict();

export async function handleMarketEvents(req: IncomingMessage, res: ServerResponse, runtime: Runtime, ownerId: string, path: string): Promise<boolean> {
	if (path === "/api/market-events" && req.method === "GET") {
		json(res, 200, { items: await runtime.marketEvents.list(ownerId) });
		return true;
	}
	if (path === "/api/market-events" && req.method === "POST") {
		const key = z.uuid().parse(req.headers["idempotency-key"]);
		const result = await runtime.marketEvents.create(ownerId, key, input.parse(await readJson(req)));
		json(res, result.status === "created" ? 201 : 200, result);
		return true;
	}
	const revise = path.match(/^\/api\/market-events\/([^/]+)\/revisions$/);
	if (revise?.[1] && req.method === "POST") {
		const key = z.uuid().parse(req.headers["idempotency-key"]);
		const body = revision.parse(await readJson(req));
		const result = await runtime.marketEvents.revise(ownerId, decodeURIComponent(revise[1]), key, body.expectedVersion, body.event, body.changeReason);
		json(res, 200, result);
		return true;
	}
	const lifecycle = path.match(/^\/api\/market-events\/([^/]+)\/lifecycle$/);
	if (lifecycle?.[1] && req.method === "GET") {
		const result = await runtime.marketEvents.lifecycle(ownerId, decodeURIComponent(lifecycle[1]));
		if (!result) throw new HttpError(404, "event not found");
		json(res, 200, result);
		return true;
	}
	const detail = path.match(/^\/api\/market-events\/([^/]+)$/);
	if (detail?.[1] && req.method === "DELETE") {
		const expectedVersion = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("expectedVersion"));
		try {
			json(res, 200, await runtime.marketEvents.delete(ownerId, decodeURIComponent(detail[1]), expectedVersion));
		} catch (error) {
			if (error instanceof MarketEventError) throw new HttpError(error.status, error.message);
			throw error;
		}
		return true;
	}
	if (detail?.[1] && req.method === "GET") {
		const result = await runtime.marketEvents.detail(ownerId, decodeURIComponent(detail[1]));
		if (!result) throw new HttpError(404, "event not found");
		json(res, 200, result);
		return true;
	}
	return false;
}
