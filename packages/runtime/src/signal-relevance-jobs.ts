// 发现线索的重要性/任务关联初判 job：模型调用在事务外，结果经 core 写回。
// 模型不可用或未配置时不编造初判；job 失败会由 worker 记录原因。
import {
	SignalAssessmentService,
	taskActiveIn,
	type Storage,
} from "@adpluse/core";
import type { JsonCaller } from "./task-draft-extractor.js";

export interface SignalAssessmentSuggestion {
	importance: "high" | "medium" | "low" | "unclear";
	relation: "direct" | "indirect" | "unclear";
	explanation: string;
	quote?: string;
}

const prompt = [
	"判断一条新发现的线索对当前推广任务是否重要、是否直接相关。",
	"只能依据给出的线索标题与任务策略摘要；不得引入外部知识、不得推测正文、价格或竞品花费。",
	"importance 取 high/medium/low/unclear；relation 取 direct/indirect/unclear。",
	"explanation（不超过400字）须指出标题中与任务目标、人群、卖点或渠道的具体联系；没有明确联系时 importance 与 relation 都必须返回 unclear。",
	"quote 只能是线索标题中连续出现的原文片段（不超过200字），摘不到就省略；禁止改写。",
	"JSON 格式：{\"importance\":\"high|medium|low|unclear\",\"relation\":\"direct|indirect|unclear\",\"explanation\":\"…\",\"quote\":\"…\"}。",
].join("\n");

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const short = (value: unknown, max: number): string | undefined => {
	if (typeof value !== "string") return;
	const result = value.trim();
	return result && result.length <= max ? result : undefined;
};

export function parseSignalSuggestion(text: string | null, title: string): SignalAssessmentSuggestion | null {
	if (!text || Buffer.byteLength(text, "utf8") > 16 * 1024) return null;
	let data: unknown;
	try { data = JSON.parse(text); } catch { return null; }
	if (!isObject(data)) return null;
	const importance = data.importance;
	const relation = data.relation;
	if (!["high", "medium", "low", "unclear"].includes(String(importance))) return null;
	if (!["direct", "indirect", "unclear"].includes(String(relation))) return null;
	const explanation = short(data.explanation, 1000);
	if (!explanation) return null;
	const quote = short(data.quote, 500);
	return {
		importance: importance as SignalAssessmentSuggestion["importance"],
		relation: relation as SignalAssessmentSuggestion["relation"],
		explanation,
		// 逐字校验：不在标题中的摘录一律丢弃，不冒充原文。
		...(quote && title.includes(quote) ? { quote } : {}),
	};
}

export function createSignalAssessmentJobHandler(
	storage: Storage,
	complete: (ownerId: string, prompt: string, brief: string) => Promise<string | null>,
	modelLabelFor: (ownerId: string) => string | null,
	now: () => string = () => new Date().toISOString(),
) {
	return {
		async prepare(leadId: string): Promise<void> {
			const context = await storage.transaction(async (tx) => {
				const lead = await tx.discoveryLeads.get(leadId);
				if (!lead) return null;
				const active = [];
				for (const task of await tx.tasks.listByOwner(lead.ownerId)) {
					if (await taskActiveIn(tx, task, new Date(now()))) active.push(task);
				}
				return { lead, active };
			});
			if (!context || !context.active.length) return;
			const label = modelLabelFor(context.lead.ownerId);
			if (!label) return; // 未配置模型：跳过，不编造。
			const service = new SignalAssessmentService(storage, now);
			for (const task of context.active) {
				const strategy = await storage.transaction(async (tx) =>
					(await tx.taskVersions.get(`${task.id}:${task.currentVersion}`))?.strategy ?? null);
				if (!strategy) continue;
				const brief = [
					`任务：${strategy.objective || "目标未知"}`,
					`人群：${strategy.audience.join("、") || "未知"}`,
					`卖点：${strategy.sellingPoints.join("、") || "未知"}`,
					`渠道：${Object.keys(strategy.channels).join("、") || "未知"}`,
					"",
					`线索标题：${context.lead.title}`,
					`发现主题：${context.lead.topic}`,
					`原始查询词：${context.lead.query}`,
					`声明主体：${context.lead.subject ? `${context.lead.subject.kind} ${context.lead.subject.name}` : "未知"}`,
				].join("\n");
				const suggestion = parseSignalSuggestion(
					await complete(context.lead.ownerId, prompt, brief),
					context.lead.title,
				);
				if (!suggestion) continue;
				await service.recordPreliminary({
					ownerId: context.lead.ownerId,
					leadId: context.lead.id,
					taskId: task.id,
					...suggestion,
					preliminary: { modelRef: label, generatedAt: now() },
				});
			}
		},
	};
}
