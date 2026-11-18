import type { components } from "../../../generated/api.js";
import { emptyChannel, type FormState } from "./task-form.ts";

type TaskDraftSuggestions = components["schemas"]["TaskDraftSuggestions"];
type DraftField = Exclude<keyof TaskDraftSuggestions, "recommendations">;
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
	fields: readonly DraftField[];
}[];

export type ChoiceField = Exclude<DraftField, "product">;
export type ExcludedChoices = Partial<Record<ChoiceField, readonly string[]>>;
export type TaskNotes = Record<TaskDraftStage, string>;

/** 一次性整理时覆盖的字段顺序：表单、提示、结果展示都用同一份。 */
export const draftFields = ["product", "objective", "audience", "sellingPoints", "channels"] as const;

export const emptyNotes: TaskNotes = { overview: "", audience: "", channels: "" };

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

/** 每个字段该写什么。模型没给出内容时，把这些提示连同示例一起摆出来。 */
export const fieldHints: Record<DraftField, { hint: string; example: string }> = {
	product: {
		hint: "写清卖的是什么，带上品类和规格就够；只写名字也可以。",
		example: "例如：南瓜子 500 克罐装",
	},
	objective: {
		hint: "写这次投放希望换来什么结果，也可以点上面的选项。",
		example: "例如：让本地顾客加微信咨询",
	},
	audience: {
		hint: "写你判断会买的人：身份、场景或地区，一行一项。",
		example: "例如：30 岁以上、在意养生的男性上班族",
	},
	sellingPoints: {
		hint: "写能核对的优势：口感、新鲜度、产地、规格、试吃、包邮。食品不要写功效或医疗效果。",
		example: "例如：今年新货、可以先试吃一小包",
	},
	channels: {
		hint: "写已经在用的平台；还没定就留空，之后在复盘页补。",
		example: "例如：微信视频号、抖音",
	},
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

/** 全部阶段里还没填的字段：决定要提示哪几项。 */
export function missingFields(form: FormState): DraftField[] {
	return draftFields.filter((field) => !stageValue(form, field));
}

/**
 * 送给模型的一份说明：三个阶段的已选内容和补充资料都算，一次整理全部字段，
 * 这样用户不必在每一步各点一次。
 */
export function setupBrief(form: FormState, notes: TaskNotes): string {
	const known = draftFields.flatMap((field) => {
		const value = stageValue(form, field);
		return value ? [fieldLabels[field] + "：" + value] : [];
	});
	const extra = taskStages.map(({ id }) => notes[id].trim());
	return [...known, ...extra].filter(Boolean).join("\n");
}

export type SuggestionSource = "quote" | "idea";

export type TaskSuggestion = {
	field: DraftField;
	value: string;
	/** quote：用户资料里的原话；idea：模型按资料整理的，需要用户自己核对。 */
	source: SuggestionSource;
	evidence?: string;
};

export function suggestionKey(item: TaskSuggestion): string {
	return item.field + "\u0000" + item.value;
}

/**
 * 一次请求的结果拍平成可勾选的一整份建议：原文摘录在前，模型建议在后。
 * 已经填过、或用户明确去掉的值不再出现，避免每点一次就多一堆重复项。
 */
export function taskSuggestions(
	form: FormState,
	data: TaskDraftSuggestions,
	excluded: ExcludedChoices = {},
): TaskSuggestion[] {
	const items: TaskSuggestion[] = [];
	const seen = new Set<string>();
	const push = (field: DraftField, value: unknown, source: SuggestionSource, evidence?: unknown) => {
		if (typeof value !== "string") return;
		const text = value.trim();
		if (!text) return;
		const key = field + "\u0000" + text;
		if (seen.has(key)) return;
		if (field === "product") {
			if (form.product.trim()) return;
		} else if (selectedValues(form, field).includes(text) || excluded[field]?.includes(text)) {
			return;
		}
		seen.add(key);
		items.push({
			field, value: text, source,
			...(typeof evidence === "string" && evidence.trim() ? { evidence: evidence.trim() } : {}),
		});
	};
	for (const field of ["product", "objective"] as const) push(field, data[field], "quote");
	for (const field of ["audience", "sellingPoints", "channels"] as const)
		for (const value of data[field] ?? []) push(field, value, "quote");
	const ideas = data.recommendations;
	if (ideas) {
		push("product", ideas.product?.value, "idea", ideas.product?.evidence);
		for (const value of ideas.objectives ?? []) push("objective", value, "idea");
		for (const field of ["audience", "sellingPoints", "channels"] as const)
			for (const value of ideas[field] ?? []) push(field, value, "idea");
	}
	return items;
}

/** 用户勾选后的表单：产品换成勾选的那一个，其余追加并去重。 */
export function applyTaskSuggestions(form: FormState, items: readonly TaskSuggestion[]): FormState {
	const values = (field: DraftField) => items.filter((item) => item.field === field).map((item) => item.value);
	let product = form.product;
	for (const value of values("product")) product = value;
	const channels = [...form.channels];
	for (const name of values("channels"))
		if (!channels.some((channel) => channel.name === name)) channels.push({ ...emptyChannel, name });
	return {
		...form,
		product,
		objective: mergeList(form.objective, values("objective")),
		audience: mergeList(form.audience, values("audience")),
		sellingPoints: mergeList(form.sellingPoints, values("sellingPoints")),
		channels,
	};
}

function mergeList(current: string, suggestions: string[]): string {
	if (!suggestions.length) return current;
	const existing = readList(current);
	const added = suggestions.filter((value) => !existing.includes(value)).slice(0, Math.max(0, 100 - existing.length));
	return added.length ? [current.trim(), ...added].filter(Boolean).join("\n") : current;
}
