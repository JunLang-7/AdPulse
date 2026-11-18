// 主动发现线索的重要性与任务关联初判（问题四后半）。
//
// 纪律：模型只产出 preliminary；用户确认后才生效、才可能进通知；
// 模型不可用时不编造；任务到期/删除后不可访问、不推送。
import { createHash } from "node:crypto";
import { taskActiveIn } from "./lifecycle.js";
import { NotificationQueue } from "./notifications-queue.js";
import { selectSignalAssessmentIn } from "./notifications-selection.js";
import type { Storage, Transaction } from "./ports/storage.js";
import type {
	SignalAssessment,
	SignalImportance,
	SignalRelation,
} from "./state/model.js";

export class SignalAssessmentError extends Error {
	constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}
const fail = (message: string): never => { throw new SignalAssessmentError(400, message); };
const canonical = (v: unknown): string => JSON.stringify(v, (_k, item) =>
	item && typeof item === "object" && !Array.isArray(item)
		? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
const text = (v: unknown, max: number): v is string =>
	typeof v === "string" && !!v.trim() && v.trim().length <= max;
const importanceValues: readonly SignalImportance[] = ["high", "medium", "low", "unclear"];
const relationValues: readonly SignalRelation[] = ["direct", "indirect", "unclear"];

export interface PreliminaryInput {
	ownerId: string;
	leadId: string;
	taskId: string;
	importance: SignalImportance;
	relation: SignalRelation;
	explanation: string;
	quote?: string;
	preliminary: { modelRef: string; generatedAt: string };
}

export class SignalAssessmentService {
	private readonly queue: NotificationQueue;
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		this.queue = new NotificationQueue(storage, () => new Date(now()));
	}

	private async ownedLead(tx: Transaction, ownerId: string, leadId: string) {
		const lead = await tx.discoveryLeads.get(leadId);
		if (!lead || lead.ownerId !== ownerId) throw new SignalAssessmentError(404, "lead not found");
		return lead;
	}

	private async activeTaskIn(tx: Transaction, ownerId: string, taskId: string) {
		const task = await tx.tasks.get(taskId);
		if (!task || task.ownerId !== ownerId || !(await taskActiveIn(tx, task, new Date(this.now()))))
			throw new SignalAssessmentError(404, "task not found");
		return task;
	}

	private validate(input: { importance: SignalImportance; relation: SignalRelation; explanation: string; quote?: string }): void {
		if (!importanceValues.includes(input.importance)) fail("invalid importance");
		if (!relationValues.includes(input.relation)) fail("invalid relation");
		if (!text(input.explanation, 1000)) fail("invalid explanation");
		if (input.quote !== undefined && !text(input.quote, 500)) fail("invalid quote");
	}

	/** 模型初判入库（幂等）；同一线索同一任务版本已有未驳回初判时返回原记录。 */
	async recordPreliminary(input: PreliminaryInput): Promise<{ assessment: SignalAssessment; outcome: "recorded" | "duplicate" }> {
		this.validate(input);
		if (!text(input.preliminary.modelRef, 256) || !text(input.preliminary.generatedAt, 40))
			fail("preliminary mark required");
		return this.storage.transaction(async (tx) => {
			const lead = await this.ownedLead(tx, input.ownerId, input.leadId);
			const task = await this.activeTaskIn(tx, input.ownerId, input.taskId);
			const dedupKey = hash(["signal", input.ownerId, lead.id, task.id, task.currentVersion]);
			const existing = (await tx.signalAssessments.listByOwner(input.ownerId)).find(
				(item) => item.dedupKey === dedupKey && item.stage !== "rejected");
			if (existing) return { assessment: existing, outcome: "duplicate" };
			const createdAt = this.now();
			const assessment: SignalAssessment = {
				id: hash([dedupKey, input.importance, input.relation, hash(input.explanation), "preliminary"]),
				dedupKey,
				ownerId: input.ownerId,
				leadId: lead.id,
				taskId: task.id,
				taskVersion: task.currentVersion,
				importance: input.importance,
				relation: input.relation,
				explanation: input.explanation,
				...(input.quote !== undefined ? { quote: input.quote } : {}),
				stage: "preliminary",
				preliminary: structuredClone(input.preliminary),
				createdAt,
			};
			await tx.signalAssessments.put(assessment);
			return { assessment, outcome: "recorded" };
		});
	}

	/** 线索的初判列表（含确认/驳回）；越权一律 404。 */
	async listForLead(ownerId: string, leadId: string): Promise<SignalAssessment[]> {
		const storage = this.storage;
		if (!text(ownerId, 256) || !text(leadId, 256)) fail("invalid query");
		return storage.transaction(async (tx) => {
			await this.ownedLead(tx, ownerId, leadId);
			return (await tx.signalAssessments.listByOwner(ownerId))
				.filter((item) => item.leadId === leadId)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		});
	}

	/** 本人所有待确认初判（按任务过滤可选）。 */
	async pending(ownerId: string, taskId?: string): Promise<SignalAssessment[]> {
		return this.storage.transaction(async (tx) => {
			const out: SignalAssessment[] = [];
			for (const item of (await tx.signalAssessments.listByOwner(ownerId))
				.filter((entry) => entry.stage === "preliminary")) {
				if (taskId && item.taskId !== taskId) continue;
				const lead = await tx.discoveryLeads.get(item.leadId);
				if (!lead || lead.ownerId !== ownerId) continue;
				const task = await tx.tasks.get(item.taskId);
				if (!task || task.ownerId !== ownerId || !(await taskActiveIn(tx, task, new Date(this.now())))) continue;
				out.push(item);
			}
			return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		});
	}

	private async decide(ownerId: string, id: string, action: "confirm" | "reject"): Promise<SignalAssessment> {
		return this.storage.transaction(async (tx) => {
			const item = await tx.signalAssessments.get(id);
			if (!item || item.ownerId !== ownerId) throw new SignalAssessmentError(404, "assessment not found");
			const stage = action === "confirm" ? "confirmed" : "rejected";
			if (item.stage === stage) return item; // 幂等重放。
			if (item.stage === "confirmed" && action === "reject")
				throw new SignalAssessmentError(409, "confirmed assessment cannot be rejected");
			if (item.stage === "rejected" && action === "confirm")
				throw new SignalAssessmentError(409, "rejected assessment cannot be confirmed");
			const lead = await this.ownedLead(tx, ownerId, item.leadId);
			const task = await this.activeTaskIn(tx, ownerId, item.taskId);
			if (task.currentVersion !== item.taskVersion)
				throw new SignalAssessmentError(409, "task version conflict");
			const next: SignalAssessment = {
				...item,
				stage,
				...(action === "confirm" ? { confirmedAt: this.now() } : {}),
			};
			await tx.signalAssessments.put(next);
			if (action === "confirm" && ["high", "medium"].includes(item.importance)
				&& ["direct", "indirect"].includes(item.relation)) {
				await selectSignalAssessmentIn(tx, next, task.currentVersion, lead.title, this.queue, this.now);
			}
			return next;
		});
	}

	confirm(ownerId: string, id: string): Promise<SignalAssessment> {
		return this.decide(ownerId, id, "confirm");
	}

	reject(ownerId: string, id: string): Promise<SignalAssessment> {
		return this.decide(ownerId, id, "reject");
	}
}
