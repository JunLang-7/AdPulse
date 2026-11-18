import type { IncomingMessage, ServerResponse } from "node:http";
import type { Runtime } from "@adpluse/runtime";
import { SignalAssessmentError } from "@adpluse/core";
import { HttpError, json } from "../http.js";

const fail = (error: unknown): never => {
	if (error instanceof SignalAssessmentError) throw new HttpError(error.status, error.message);
	throw error as Error;
};

export async function handleSignalAssessments(
	req: IncomingMessage, res: ServerResponse, runtime: Runtime, ownerId: string, path: string,
): Promise<boolean> {
	const list = path.match(/^\/api\/me\/discovery-leads\/([^/]+)\/assessments$/);
	if (list?.[1] && req.method === "GET") {
		json(res, 200, { items: await runtime.signalAssessments.listForLead(ownerId, decodeURIComponent(list[1])).catch(fail) });
		return true;
	}
	const action = path.match(/^\/api\/signal-assessments\/([^/]+)\/(confirm|reject)$/);
	if (action?.[1] && action[2] && req.method === "POST") {
		const id = decodeURIComponent(action[1]);
		const result = action[2] === "confirm"
			? await runtime.signalAssessments.confirm(ownerId, id).catch(fail)
			: await runtime.signalAssessments.reject(ownerId, id).catch(fail);
		json(res, 200, result);
		return true;
	}
	const pending = path.match(/^\/api\/me\/signal-assessments\/pending$/);
	if (pending && req.method === "GET") {
		const query = new URL(req.url ?? "/", "http://localhost").searchParams;
		const taskId = query.get("taskId");
		if (taskId !== null && (!taskId || taskId.length > 128)) throw new HttpError(400, "invalid_task_id");
		json(res, 200, { items: await runtime.signalAssessments.pending(ownerId, taskId ?? undefined).catch(fail) });
		return true;
	}
	return false;
}
