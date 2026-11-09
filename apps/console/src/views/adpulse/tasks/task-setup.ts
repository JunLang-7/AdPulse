import type { components } from "../../../generated/api.js";
import { emptyChannel, type FormState } from "./task-form.ts";

type TaskDraftSuggestions = components["schemas"]["TaskDraftSuggestions"];
export type TaskDraftStage = components["schemas"]["TaskDraftStage"];

export const taskStages = [
	{
		id: "overview", title: "推广内容", description: "先确定推广什么、希望带来什么结果。",
		placeholder: "例如：准备推广门店的新品试用装，希望增加到店咨询。",
		fields: ["product", "objective"],
	},
	{
		id: "audience", title: "人群与卖点", description: "选出你已确定的人群和优势，也可以补充一段已有的客户或产品说明。",
		placeholder: "例如：面向最近准备装修的业主，可以预约免费上门测量。",
		fields: ["audience", "sellingPoints"],
	},
	{
		id: "channels", title: "投放渠道", description: "选出已确定的平台。渠道未定时，可以直接进入核对。",
		placeholder: "例如：计划先在品牌公众号和小红书发布新品介绍。",
		fields: ["channels"],
	},
] as const satisfies readonly {
	id: TaskDraftStage;
	title: string;
	description: string;
	placeholder: string;
	fields: readonly (keyof TaskDraftSuggestions)[];
}[];

type DraftField = keyof TaskDraftSuggestions;
export type ChoiceField = Exclude<DraftField, "product">;
export type ExcludedChoices = Partial<Record<ChoiceField, readonly string[]>>;

export const fieldLabels: Record<DraftField, string> = {
	product: "产品或服务",
	objective: "推广目标",
	audience: "目标人群",
	sellingPoints: "主要卖点",
	channels: "投放渠道",
};

export const fieldOptions: Record<ChoiceField, readonly string[]> = {
	objective: ["增加咨询", "促进购买", "提高品牌曝光", "吸引客户到店"],
	audience: ["新客户", "老客户", "有明确需求的人", "企业客户"],
	sellingPoints: ["可免费试用", "价格优惠", "专业服务", "快速交付"],
	channels: ["小红书", "抖音", "微信视频号", "微信公众号", "搜索广告"],
};

function readList(text: string): string[] {
	return text.split("\n").map((item) => item.trim()).filter(Boolean);
}

export function selectedValues(form: FormState, field: ChoiceField): string[] {
	if (field === "channels") return form.channels.map((channel) => channel.name).filter(Boolean);
	return readList(form[field]);
}

export function stageValue(form: FormState, field: DraftField): string {
	return field === "product" ? form.product.trim() : selectedValues(form, field).join("、");
}

export function withSelectedValue(form: FormState, field: ChoiceField, value: string): FormState {
	const items = selectedValues(form, field);
	const selected = items.includes(value);
	const values = selected ? items.filter((item) => item !== value) : [...items, value];
	if (field === "channels") {
		const channels = selected
			? form.channels.filter(({ name }) => name !== value)
			: [...form.channels, { ...emptyChannel, name: value }];
		return { ...form, channels };
	}
	return { ...form, [field]: values.join("\n") };
}

export function stageBrief(form: FormState, stage: typeof taskStages[number], notes: string): string {
	const known = stage.fields.flatMap((field) => {
		const value = stageValue(form, field);
		return value ? [fieldLabels[field] + "：" + value] : [];
	});
	return [...known, notes.trim()].filter(Boolean).join("\n");
}

export function applyStageSuggestions(
	form: FormState,
	stage: TaskDraftStage,
	draft: TaskDraftSuggestions,
	excluded: ExcludedChoices = {},
): FormState {
	const available = (field: ChoiceField, values: readonly string[] = []) =>
		values.filter((value) => !excluded[field]?.includes(value));
	if (stage === "overview") {
		return {
			...form,
			product: form.product.trim() ? form.product : draft.product ?? form.product,
			objective: form.objective.trim() ? form.objective
				: available("objective", draft.objective ? [draft.objective] : [])[0] ?? form.objective,
		};
	}
	if (stage === "audience") {
		return {
			...form,
			audience: mergeList(form.audience, available("audience", draft.audience)),
			sellingPoints: mergeList(form.sellingPoints, available("sellingPoints", draft.sellingPoints)),
		};
	}
	return {
		...form,
		channels: [
			...form.channels,
			...available("channels", draft.channels)
				.filter((name) => !form.channels.some((channel) => channel.name === name))
				.map((name) => ({ ...emptyChannel, name })),
		],
	};
}

function mergeList(current: string, suggestions: string[]): string {
	if (!suggestions.length) return current;
	const existing = readList(current);
	const added = suggestions.filter((value) => !existing.includes(value)).slice(0, Math.max(0, 100 - existing.length));
	return added.length ? [current.trim(), ...added].filter(Boolean).join("\n") : current;
}
