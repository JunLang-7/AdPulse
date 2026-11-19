import type { IncomingMessage, ServerResponse } from "node:http";
import { UserSiteFetcher, createEventDraftExtractor, type Runtime } from "@adpluse/runtime";
import { MarketEventError, SOURCE_DEFINITIONS } from "@adpluse/core";
import { z } from "zod";
import { HttpError, json, readJson } from "../http.js";

/** 鍏佽璇诲彇鍘熸枃鐨勪富鏈猴細涓庨噰闆?allowlist 鍙屽悜涓€鑷达紝涓嶆柊澧炶寖鍥淬€?*/
const SOURCE_HOSTS = [
	...new Set(Object.values(SOURCE_DEFINITIONS).flatMap((s) => s.allowedHosts)),
];

/** 浠庡畼缃?HTML 鎻愬彇鍙姝ｆ枃锛氬幓鑴氭湰/鏍峰紡/鏍囩锛屾姌鍙犵┖鐧斤紱鍙敤浜庨濉紝涓嶆浛浠ｆ湰浜烘牳瀵广€?*/
function htmlToText(html: string): string {
	const cleaned = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
		.replace(/<!--[^-]*-->/gu, " ")
		.replace(/<[^>]+>/gu, " ")
		.replace(/&nbsp;/giu, " ")
		.replace(/&amp;/giu, "&")
		.replace(/&lt;/giu, "<")
		.replace(/&gt;/giu, ">")
		.replace(/&quot;/giu, '"')
		.replace(/&#39;/gu, "'");
	return cleaned.replace(/\s+/gu, " ").trim().slice(0, 30_000);
}

function htmlTitle(html: string): string | null {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
	if (!match) return null;
	const title = htmlToText(match[1] ?? "");
	return title ? title.slice(0, 200) : null;
}

const readSourceInput = z.object({ url: z.string().max(2000) }).strict();

/** 事件整理输入：材料必填（与来源材料上限一致）；来源名与链接仅作上下文。 */
const extractInput = z
	.object({
		materials: z.string().trim().min(1).max(30_000),
		publisher: z.string().max(200).optional(),
		url: z.string().max(2000).optional(),
	})
	.strict();

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
	if (path === "/api/market-events/extract" && req.method === "POST") {
		// 先校验输入再查模型：空材料等错误应得到 400，而不是误导性的 503。
		const body = extractInput.parse(await readJson(req));
		// 统一模型出口：优先用「模型配置」的默认持久化连接，无需逐处选择。
		const complete = (systemPrompt: string, brief: string, maxTokens?: number) =>
			runtime.jsonCompleter
				? runtime.jsonCompleter(ownerId, systemPrompt, brief, maxTokens)
				: runtime.taskDraftModels?.completeJson(ownerId, systemPrompt, brief, undefined, maxTokens) ?? Promise.resolve(null);
		const extract = createEventDraftExtractor(complete);
		const items = await extract({
			materials: body.materials,
			...(body.publisher !== undefined ? { publisher: body.publisher } : {}),
			...(body.url !== undefined ? { url: body.url } : {}),
		});
		if (!items) throw new HttpError(503, "event draft extraction unavailable");
		json(res, 200, { items });
		return true;
	}
	if (path === "/api/market-events/read-source" && req.method === "POST") {
		const { url } = readSourceInput.parse(await readJson(req));
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			throw new HttpError(400, "invalid url");
		}
		// 鍐呯疆 allowlist + 鏈汉宸茬櫥璁扮殑鐢ㄦ埛绔欑偣涓绘満锛涗粬浜虹櫥璁扮殑涓绘満涓嶅湪杩欎唤鍚嶅崟閲屻€?
		const userHosts = await runtime.storage.transaction((tx) =>
			tx.userSources.listByOwner(ownerId),
		);
		const allowed = new Set([...SOURCE_HOSTS, ...userHosts.map((s) => s.host)]);
		if (!allowed.has(target.host)) throw new HttpError(403, "host not allowed");
		try {
			const fetched = await new UserSiteFetcher([target.host]).fetchText(url, {
				maxBytes: 512 * 1024,
				timeoutMs: 15_000,
			});
			json(res, 200, { title: htmlTitle(fetched.body), content: htmlToText(fetched.body) });
		} catch {
			throw new HttpError(502, "source read failed");
		}
		return true;
	}
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
