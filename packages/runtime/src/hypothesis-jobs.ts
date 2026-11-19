// 假设偏差初判 job 的运行时实现：模型调用在事务外完成，结果经 core 写回。
//
// 限制（探索阶段如实声明）：
// - 模型连接保存在 API 进程内；独立 worker 进程未注入处理器时初判 job 失败，
//   由运维决定重试或放任失败，不影响其他任务。
// - 未配置模型（无个人连接也无部署路由）时初判直接跳过，不产生待确认条目。
import {
	HypothesisPreliminaryWriter,
	HypothesisService,
	type Storage,
} from "@adpluse/core";
import { createHypothesisReasoning } from "./hypothesis-reasoning.js";

export type HypothesisVerdictSource =
	| { kind: "market_event"; eventId: string; version: number }
	| { kind: "comparison"; comparisonResultId: string };

interface SourceMaterial {
	ownerId: string;
	taskIds: string[];
	title: string;
	content: string;
	subject: HypothesisVerdictSource;
}

const targetStatuses = ["open", "supported", "challenged"] as const;

async function loadMaterial(storage: Storage, source: HypothesisVerdictSource): Promise<SourceMaterial | null> {
	return storage.transaction(async (tx) => {
		if (source.kind === "market_event") {
			const head = await tx.marketEvents.get(source.eventId);
			if (!head) return null;
			const version = await tx.marketEventVersions.get(`${source.eventId}:${source.version}`);
			if (!version) return null;
			const content = [
				version.input.title,
				version.input.conditions ? `适用条件：${version.input.conditions}` : null,
				...version.input.sources
					.map((item) => item.content)
					.filter((item): item is string => typeof item === "string" && item.length > 0),
			].filter(Boolean).join("\n");
			return {
				ownerId: head.ownerId,
				taskIds: [...new Set(version.input.taskRefs.map((ref) => ref.taskId))],
				title: version.input.title,
				content,
				subject: source,
			};
		}
		const result = await tx.comparisonResults.get(source.comparisonResultId);
		if (!result) return null;
		const cost = result.comparisons.costPerConsultation;
		const lines: string[] = [];
		if (cost) {
			lines.push(`单次咨询成本基线：${cost.baseline.numeratorMinor}分 / ${cost.baseline.denominatorConsultations}次咨询`);
			lines.push(`当前：${cost.current.numeratorMinor}分 / ${cost.current.denominatorConsultations}次咨询，方向 ${cost.direction}`);
		}
		lines.push(`阈值评估：${result.thresholdEvaluation.status}`);
		if (result.comparisons.consultations)
			lines.push(`咨询数：基线 ${result.comparisons.consultations.baseline} → 当前 ${result.comparisons.consultations.current}`);
		if (result.comparisons.spendMinor)
			lines.push(`消耗：基线 ${result.comparisons.spendMinor.baseline}分 → 当前 ${result.comparisons.spendMinor.current}分`);
		return {
			ownerId: result.ownerId,
			taskIds: [result.taskId],
			title: `投放效果比较 ${result.id}`,
			content: lines.join("\n"),
			subject: source,
		};
	});
}

/**
 * 假设偏差初判 job 处理器：按 owner 取默认模型路由，为每条非停用假设生成初判。
 * 模型不可用或输出不可接受时跳过该假设（不产生待确认条目），job 仍标记完成。
 */
export function createHypothesisVerdictJobHandler(
	storage: Storage,
	completeJson: (
		ownerId: string,
		systemPrompt: string,
		brief: string,
		maxTokens?: number,
	) => Promise<string | null>,
	modelLabelFor: (ownerId: string) => string | null | Promise<string | null>,
	now: () => string = () => new Date().toISOString(),
) {
	return {
		async prepare(source: HypothesisVerdictSource): Promise<void> {
			const material = await loadMaterial(storage, source);
			if (!material || !material.taskIds.length) return;
			const label = await modelLabelFor(material.ownerId);
			if (!label) return;
			const service = new HypothesisService(storage, now);
			const targets = [];
			for (const taskId of material.taskIds) {
				const list = await service.list(material.ownerId, taskId);
				targets.push(...list.filter((item) => targetStatuses.includes(item.head.status as typeof targetStatuses[number])));
			}
			if (!targets.length) return;
			const reasoning = createHypothesisReasoning(
				(systemPrompt, brief, maxTokens) => completeJson(material.ownerId, systemPrompt, brief, maxTokens),
			);
			const writer = new HypothesisPreliminaryWriter(storage, now);
			for (const target of targets) {
				const suggestion = await reasoning.judge({
					statement: target.current.statement,
					...(target.current.testable ? { testable: target.current.testable } : {}),
					evidenceTitle: material.title,
					evidenceContent: material.content,
					evidenceKind: source.kind === "market_event" ? "market_event" : "comparison",
				});
				if (!suggestion) continue;
				await writer.record({
					ownerId: material.ownerId,
					hypothesisId: target.head.id,
					subject: material.subject,
					judgment: suggestion.judgment,
					explanation: suggestion.explanation,
					...(suggestion.quote ? { quote: suggestion.quote } : {}),
					preliminary: { modelRef: label, generatedAt: now() },
				});
			}
		},
	};
}
