import type { IncomingMessage, ServerResponse } from "node:http";
import type { Runtime } from "@adpluse/runtime";
import { createHypothesisReasoning } from "@adpluse/runtime";
import { HypothesisError, type HypothesisSubjectRef } from "@adpluse/core";
import { z } from "zod";
import { HttpError, json, readJson } from "../http.js";

const nonBlank = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().max(max).optional();

const subject = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("market_event"), eventId: nonBlank(256), version: z.number().int().min(1) }).strict(),
	z.object({ kind: z.literal("source_item"), sourceItemId: nonBlank(256) }).strict(),
	z.object({ kind: z.literal("comparison"), comparisonResultId: nonBlank(256) }).strict(),
]);

const draftRef = z.object({
	modelRef: nonBlank(256),
	generatedAt: z.iso.datetime({ offset: true }),
	iterations: z.number().int().min(0),
}).strict();

const createBody = z.object({
	statement: nonBlank(200),
	rationale: nonBlank(500),
	testable: optionalText(400),
	origin: z.enum(["manual", "model_draft_accepted"]),
	draftRef: draftRef.optional(),
}).strict();

const revisionBody = z.object({
	expectedVersion: z.number().int().min(1),
	statement: nonBlank(200),
	rationale: nonBlank(500),
	testable: optionalText(400),
}).strict();

const retireBody = z.object({ expectedVersion: z.number().int().min(1) }).strict();

const verdictBody = z.object({
	subject,
	judgment: z.enum(["supports", "challenges", "unclear"]),
	explanation: nonBlank(1000),
	quote: optionalText(2000),
}).strict();

const draftsBody = z.object({
	materials: optionalText(2500),
	feedback: optionalText(1000),
	previous: z.array(z.object({
		statement: nonBlank(200),
		outcome: z.enum(["accepted", "rejected", "revised"]),
	}).strict()).max(8).optional(),
}).strict();

const fail = (error: unknown): never => {
	if (error instanceof HypothesisError) throw new HttpError(error.status, error.message);
	throw error as Error;
};

export async function handleHypotheses(req: IncomingMessage, res: ServerResponse, runtime: Runtime, ownerId: string, path: string): Promise<boolean> {
	const taskHypotheses = path.match(/^\/api\/tasks\/([^/]+)\/hypotheses$/);
	if (taskHypotheses?.[1] && req.method === "GET") {
		json(res, 200, { items: await runtime.hypotheses.list(ownerId, decodeURIComponent(taskHypotheses[1])) });
		return true;
	}
	const drafts = path.match(/^\/api\/tasks\/([^/]+)\/hypotheses\/drafts$/);
	if (drafts?.[1] && req.method === "POST") {
		const taskId = decodeURIComponent(drafts[1]);
		const models = runtime.taskDraftModels;
		if (!models) throw new HttpError(503, "hypothesis draft generation unavailable");
		const body = draftsBody.parse(await readJson(req));
		const context = await runtime.storage.transaction(async (tx) => {
			const task = await tx.tasks.get(taskId);
			if (!task || task.ownerId !== ownerId) throw new HttpError(404, "task not found");
			const version = await tx.taskVersions.get(`${task.id}:${task.currentVersion}`);
			if (!version) throw new HttpError(404, "task version not found");
			const eventTitles = (await tx.marketEventVersions.listByOwner(ownerId))
				.filter((item) => item.input.taskRefs.some((ref) => ref.taskId === taskId))
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				.slice(0, 20)
				.map((item) => item.input.title);
			return { version, eventTitles };
		});
		const reasoning = createHypothesisReasoning((systemPrompt, brief, maxTokens) =>
			models.completeJson(ownerId, systemPrompt, brief, undefined, maxTokens));
		const brief = [context.version.product, body.materials].filter((item) => item && item.length > 0).join("\n");
		const result = await reasoning.drafts({
			brief,
			strategy: {
				objective: context.version.strategy.objective,
				audience: context.version.strategy.audience,
				sellingPoints: context.version.strategy.sellingPoints,
				channels: Object.keys(context.version.strategy.channels),
			},
			eventTitles: context.eventTitles,
			...(body.feedback && body.previous ? { feedback: body.feedback, previous: body.previous } : {}),
		});
		if (!result) throw new HttpError(503, "hypothesis draft generation unavailable");
		// 逐字校验：evidenceHint 必须能在任务说明中找到，否则丢弃，不冒充摘录。
		const items = result.map((draft) =>
			draft.evidenceHint && !brief.includes(draft.evidenceHint)
				? { statement: draft.statement, rationale: draft.rationale, ...(draft.testable ? { testable: draft.testable } : {}) }
				: draft);
		json(res, 200, { drafts: items });
		return true;
	}
	if (taskHypotheses?.[1] && req.method === "POST") {
		const key = z.uuid().parse(req.headers["idempotency-key"]);
		const body = createBody.parse(await readJson(req));
		const result = await runtime.hypotheses.create(ownerId, key, {
			taskId: decodeURIComponent(taskHypotheses[1]),
			statement: body.statement,
			rationale: body.rationale,
			...(body.testable !== undefined ? { testable: body.testable } : {}),
			origin: body.origin,
			...(body.draftRef ? { draftRef: body.draftRef } : {}),
		}).catch(fail);
		json(res, result.status === "created" ? 201 : 200, result);
		return true;
	}
	if (path === "/api/hypotheses/pending" && req.method === "GET") {
		json(res, 200, { items: await runtime.hypotheses.pendingVerdicts(ownerId) });
		return true;
	}
	const detail = path.match(/^\/api\/hypotheses\/([^/]+)$/);
	if (detail?.[1] && req.method === "GET") {
		const result = await runtime.hypotheses.detail(ownerId, decodeURIComponent(detail[1]));
		if (!result) throw new HttpError(404, "hypothesis not found");
		json(res, 200, result);
		return true;
	}
	const revise = path.match(/^\/api\/hypotheses\/([^/]+)\/revisions$/);
	if (revise?.[1] && req.method === "POST") {
		const key = z.uuid().parse(req.headers["idempotency-key"]);
		const body = revisionBody.parse(await readJson(req));
		const result = await runtime.hypotheses.revise(
			ownerId,
			decodeURIComponent(revise[1]),
			key,
			body.expectedVersion,
			{ statement: body.statement, rationale: body.rationale, ...(body.testable !== undefined ? { testable: body.testable } : {}) },
		).catch(fail);
		json(res, 200, result);
		return true;
	}
	const retire = path.match(/^\/api\/hypotheses\/([^/]+)\/retire$/);
	if (retire?.[1] && req.method === "POST") {
		const key = z.uuid().parse(req.headers["idempotency-key"]);
		const body = retireBody.parse(await readJson(req));
		const result = await runtime.hypotheses.retire(ownerId, decodeURIComponent(retire[1]), key, body.expectedVersion).catch(fail);
		json(res, 200, result);
		return true;
	}
	const verdict = path.match(/^\/api\/hypotheses\/([^/]+)\/verdicts$/);
	if (verdict?.[1] && req.method === "POST") {
		const key = z.uuid().parse(req.headers["idempotency-key"]);
		const body = verdictBody.parse(await readJson(req));
		const result = await runtime.hypotheses.verdict(ownerId, decodeURIComponent(verdict[1]), key, {
			subject: body.subject as HypothesisSubjectRef,
			judgment: body.judgment,
			explanation: body.explanation,
			...(body.quote !== undefined ? { quote: body.quote } : {}),
		}).catch(fail);
		json(res, result.status === "verdict_recorded" ? 201 : 200, result);
		return true;
	}
	const confirm = path.match(/^\/api\/hypotheses\/verdicts\/([^/]+)\/(confirm|reject)$/);
	if (confirm?.[1] && confirm[2] && req.method === "POST") {
		const verdictId = decodeURIComponent(confirm[1]);
		const result = confirm[2] === "confirm"
			? await runtime.hypotheses.confirmVerdict(ownerId, verdictId).catch(fail)
			: await runtime.hypotheses.rejectVerdict(ownerId, verdictId).catch(fail);
		json(res, 200, result);
		return true;
	}
	return false;
}
