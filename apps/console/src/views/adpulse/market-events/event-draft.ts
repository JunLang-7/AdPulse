// 事件 AI 整理建议的展示与应用：纯函数，便于单测。
// 与任务草案同一取向：原文逐字（quote）默认勾选，模型整理（idea）默认不勾、需核对。

export type EventDraftField =
	| "title"
	| "type"
	| "subjectKind"
	| "subjectName"
	| "eventTime"
	| "conditions"
	| "scope"
	| "limitations"
	| "citationSubject"
	| "citationEventTime"
	| "citationConditions";

export interface EventDraftItem {
	field: EventDraftField;
	value: string;
	source: "quote" | "idea";
	evidence?: string;
}

export const eventDraftFieldLabels: Record<EventDraftField, string> = {
	title: "事件标题",
	type: "类别",
	subjectKind: "关注对象类型",
	subjectName: "关注对象名称",
	eventTime: "事件时间",
	conditions: "适用条件",
	scope: "内容范围",
	limitations: "缺失与局限",
	citationSubject: "主体原文引用",
	citationEventTime: "事件时间原文引用",
	citationConditions: "适用条件原文引用",
};

export const eventDraftTypeLabels: Record<string, string> = {
	announcement: "公告",
	campaign: "活动",
	product_launch: "产品发布",
};

export const eventDraftScopeLabels: Record<string, string> = {
	link_only: "仅链接（未读取）",
	title_only: "仅标题",
	search_snippet: "搜索摘要",
	excerpt: "正文摘录 / 不完整",
	full_text: "完整正文",
};

/** 建议的展示值：枚举类翻译成人话，其余原样。 */
export function eventDraftDisplayValue(item: EventDraftItem): string {
	if (item.field === "type") return eventDraftTypeLabels[item.value] ?? item.value;
	if (item.field === "subjectKind") return item.value === "competitor" ? "竞品" : "品牌";
	if (item.field === "scope") return eventDraftScopeLabels[item.value] ?? item.value;
	return item.value;
}

export const eventDraftKey = (item: EventDraftItem): string =>
	`${item.field}\u0000${item.value}`;

/** 逐字引用默认选中；模型整理默认不选，等用户核对。 */
export const defaultPicked = (item: EventDraftItem): boolean => item.source === "quote";

type EventDraftInput = {
	title: string;
	type: string;
	subject: { kind: string; name: string };
	eventTime: string | null;
	conditions: string | null;
	sources: Array<{
		scope: string;
		origin: string;
		limitations: string;
		acquiredAt: string;
		content: string | null;
	}>;
	citations: {
		subject: { sourceIndex: number; quote: string } | null;
		eventTime: { sourceIndex: number; quote: string } | null;
		conditions: { sourceIndex: number; quote: string } | null;
	};
};

/**
 * 把用户勾选的建议应用到表单草稿。
 *
 * 边界：
 * - 只动建议清单里的字段，其余字段原样保留；
 * - 引用写进第 1 个来源（与现有 UI 的「引用来源」选择器一致）；
 * - **引用必须能在材料里找到**：勾了引用/事实项时，把材料写入来源正文，
 *   范围从仅链接/仅标题保守提升到「正文摘录」（不自称全文）；
 * - 来源性质（origin）从不改：那是录入者声明的，模型不参与；
 * - 获取时间不是模型结论：仅当用户勾选了「代为填时间」时才写当前时刻。
 */
export function applyEventDraftItems(
	draft: EventDraftInput,
	items: readonly EventDraftItem[],
	picked: ReadonlySet<string>,
	options: { fillAcquiredAt?: boolean; now?: string; materials?: string } = {},
): EventDraftInput {
	const chosen = items.filter((item) => picked.has(eventDraftKey(item)));
	const next = structuredClone(draft);
	const first = next.sources[0];
	const setCitation = (field: "subject" | "eventTime" | "conditions", quote: string) => {
		next.citations = { ...next.citations, [field]: { sourceIndex: 0, quote } };
	};
	for (const item of chosen) {
		switch (item.field) {
			case "title": next.title = item.value; break;
			case "type": if (["announcement", "campaign", "product_launch"].includes(item.value)) next.type = item.value; break;
			case "subjectKind": next.subject = { ...next.subject, kind: item.value === "competitor" ? "competitor" : "brand" }; break;
			case "subjectName": next.subject = { ...next.subject, name: item.value }; break;
			case "eventTime": next.eventTime = item.value; break;
			case "conditions": next.conditions = item.value; break;
			case "citationSubject": setCitation("subject", item.value); break;
			case "citationEventTime": setCitation("eventTime", item.value); break;
			case "citationConditions": setCitation("conditions", item.value); break;
			case "scope":
				// 范围只能在不与实际情况矛盾时写入：仅链接/仅标题不要求正文。
				if (first && (item.value !== "excerpt" && item.value !== "full_text" || first.content))
					first.scope = item.value;
				break;
			case "limitations": if (first) first.limitations = item.value; break;
		}
	}
	// 引用写进了表单，就必须让材料也在表单里：否则领域会以
	// 「citation not found in material」拒绝，用户看到的却是“已经填好”。
	const hasCitation = Boolean(
		next.citations.subject?.quote?.trim() ||
		next.citations.eventTime?.quote?.trim() ||
		next.citations.conditions?.quote?.trim(),
	);
	if (first && hasCitation && !first.content?.trim()) {
		const materials = options.materials?.trim();
		if (materials) {
			first.content = materials;
			// 保守提升：材料是抓到的一段原文，不声称是全文。
			if (first.scope !== "excerpt" && first.scope !== "full_text") first.scope = "excerpt";
		}
	}
	if (options.fillAcquiredAt !== false && first && !first.acquiredAt.trim()) {
		first.acquiredAt = options.now ?? new Date().toISOString();
	}
	return next;
}

/** 按字段分组，保持清单里的原始顺序（先引用、后整理字段）。 */
export function groupEventDraftItems(items: readonly EventDraftItem[]): Array<{
	field: EventDraftField;
	label: string;
	items: EventDraftItem[];
}> {
	const order: EventDraftField[] = [
		"citationSubject",
		"citationEventTime",
		"citationConditions",
		"title",
		"type",
		"subjectKind",
		"subjectName",
		"eventTime",
		"conditions",
		"scope",
		"limitations",
	];
	const groups: Array<{ field: EventDraftField; label: string; items: EventDraftItem[] }> = [];
	for (const field of order) {
		const matched = items.filter((item) => item.field === field);
		if (matched.length) groups.push({ field, label: eventDraftFieldLabels[field], items: matched });
	}
	// 未知字段不静默丢弃：放在末尾，让用户看到服务端多给了什么。
	for (const item of items) {
		if (order.includes(item.field)) continue;
		const existing = groups.find((group) => group.field === item.field);
		if (existing) existing.items.push(item);
		else groups.push({ field: item.field, label: eventDraftFieldLabels[item.field] ?? item.field, items: [item] });
	}
	return groups;
}
