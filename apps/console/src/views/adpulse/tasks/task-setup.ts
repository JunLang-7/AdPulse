import type { components } from "../../../generated/api.js";
import { emptyChannel, type FormState } from "./task-form.ts";

export type TaskDraftSuggestions = components["schemas"]["TaskDraftSuggestions"];

export const guideQuestions = [
	{ field: "product", label: "产品或服务", question: "这次要推广什么？", example: "例如：新品试用装", maxLength: 200 },
	{ field: "objective", label: "推广目标", question: "你希望这次推广带来什么？", example: "例如：让更多客户来咨询", maxLength: 2000 },
	{ field: "audience", label: "目标人群", question: "你最想让哪些人看到？", example: "例如：准备装修的新房业主", maxLength: 2000 },
	{ field: "sellingPoints", label: "卖点", question: "有什么值得告诉客户的？", example: "例如：可以先领取免费样品", maxLength: 2000 },
	{ field: "channels", label: "投放渠道", question: "打算在哪里推广？", example: "例如：小红书、抖音", maxLength: 2000 },
] as const;

type GuideField = typeof guideQuestions[number]["field"];

export function guideValue(form: FormState, field: GuideField): string {
	return field === "channels" ? form.channels.map((channel) => channel.name).filter(Boolean).join("、") : form[field].trim();
}

export function nextGuideQuestion(form: FormState, after = -1): number {
	return guideQuestions.findIndex(({ field }, index) => index > after && !guideValue(form, field));
}

export function applyTaskSuggestions(form: FormState, draft: TaskDraftSuggestions): FormState {
	return {
		...form,
		product: form.product.trim() ? form.product : draft.product ?? form.product,
		objective: form.objective.trim() ? form.objective : draft.objective ?? form.objective,
		audience: form.audience.trim() ? form.audience : draft.audience?.join("\n") ?? form.audience,
		sellingPoints: form.sellingPoints.trim() ? form.sellingPoints : draft.sellingPoints?.join("\n") ?? form.sellingPoints,
		channels: form.channels.length > 0 || !draft.channels
			? form.channels
			: draft.channels.map((name) => ({ ...emptyChannel, name })),
	};
}

export function addGuideAnswer(form: FormState, field: GuideField, value: string): FormState {
	const answer = value.trim();
	if (field === "product" && !answer) throw new Error("填个名称就可以，例如“新品试用装”。");
	if (!answer) return form;
	if (field === "product" || field === "objective") return { ...form, [field]: answer };
	const items = [...new Set(answer.split(/[\n、，,]+/).map((item) => item.trim()).filter(Boolean))];
	if (items.length > 100) throw new Error("请先记录最重要的 100 项。");
	if (field !== "channels") return { ...form, [field]: items.join("\n") };
	if (items.some((name) => name.length > 128 || ["__proto__", "prototype", "constructor"].includes(name)))
		throw new Error("请填写有效的渠道名称，每项最多 128 字。");
	if (form.channels.length > 0) {
		const newNames = items.filter((name) => !form.channels.some((channel) => channel.name === name));
		return { ...form, channels: [...form.channels, ...newNames.map((name) => ({ ...emptyChannel, name }))] };
	}
	return { ...form, channels: items.map((name) => ({ ...emptyChannel, name })) };
}
