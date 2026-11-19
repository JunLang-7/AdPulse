// 事件 AI 整理的展示与应用：默认只勾原文，应用只动建议字段。
import assert from "node:assert/strict";
import test from "node:test";
import {
	applyEventDraftItems,
	defaultPicked,
	eventDraftDisplayValue,
	eventDraftKey,
	groupEventDraftItems,
	type EventDraftItem,
} from "../apps/console/src/views/adpulse/market-events/event-draft.ts";

const baseDraft = () => ({
	title: "",
	type: "announcement",
	subject: { kind: "brand", name: "" },
	eventTime: null as string | null,
	conditions: null as string | null,
	sources: [{
		scope: "link_only",
		origin: "unknown",
		limitations: "",
		acquiredAt: "",
		content: null as string | null,
	}],
	citations: {
		subject: null as { sourceIndex: number; quote: string } | null,
		eventTime: null as { sourceIndex: number; quote: string } | null,
		conditions: null as { sourceIndex: number; quote: string } | null,
	},
});

const item = (field: EventDraftItem["field"], value: string, source: "quote" | "idea" = "idea"): EventDraftItem =>
	({ field, value, source });

test("默认只勾选原文逐字项，模型整理项留给用户核对", () => {
	assert.equal(defaultPicked(item("title", "标题", "quote")), true);
	assert.equal(defaultPicked(item("title", "标题", "idea")), false);
	assert.equal(defaultPicked(item("type", "campaign")), false);
	assert.equal(defaultPicked(item("limitations", "局限")), false);
});

test("应用建议只写勾选项，且不碰来源性质", () => {
	const draft = baseDraft();
	const items = [
		item("title", "关于新品发布的公告", "quote"),
		item("type", "product_launch"),
		item("subjectName", "本公司", "quote"),
		item("eventTime", "2026年11月16日", "quote"),
		item("conditions", "仅限试点地区销售", "quote"),
		item("citationSubject", "本公司", "quote"),
		item("citationEventTime", "2026年11月16日", "quote"),
		item("citationConditions", "仅限试点地区销售", "quote"),
		item("limitations", "仅取得公告摘要。"),
		item("scope", "excerpt"),
	];
	const picked = new Set(items.map(eventDraftKey));
	const next = applyEventDraftItems(draft, items, picked, { now: "2026-11-19T00:00:00.000Z" });
	assert.equal(next.title, "关于新品发布的公告");
	assert.equal(next.type, "product_launch");
	assert.equal(next.subject.name, "本公司");
	assert.equal(next.eventTime, "2026年11月16日");
	assert.equal(next.conditions, "仅限试点地区销售");
	assert.deepEqual(next.citations.subject, { sourceIndex: 0, quote: "本公司" });
	assert.equal(next.sources[0]!.limitations, "仅取得公告摘要。");
	// 来源性质是录入者声明：模型与建议都不改它。
	assert.equal(next.sources[0]!.origin, "unknown");
	// 材料为空时 scope 不能写成 excerpt（否则保存会因缺正文被拒）。
	assert.equal(next.sources[0]!.scope, "link_only");
	// 获取时间不是模型结论：仅在为空时补当前时间。
	assert.equal(next.sources[0]!.acquiredAt, "2026-11-19T00:00:00.000Z");
	// 输入不被修改。
	assert.equal(draft.title, "");
});

test("未勾选的建议不写入；已有获取时间不覆盖", () => {
	const draft = baseDraft();
	draft.sources[0]!.acquiredAt = "2026-01-01T00:00:00.000Z";
	draft.sources[0]!.content = "原文";
	const items = [item("title", "标题"), item("type", "campaign"), item("scope", "full_text")];
	const next = applyEventDraftItems(draft, items, new Set([eventDraftKey(items[1]!), eventDraftKey(items[2]!)]), { now: "2026-11-19T00:00:00.000Z" });
	assert.equal(next.title, "", "未勾选的标题不写入");
	assert.equal(next.type, "campaign");
	assert.equal(next.sources[0]!.scope, "full_text", "有正文时允许写全文范围");
	assert.equal(next.sources[0]!.acquiredAt, "2026-01-01T00:00:00.000Z");
});

test("枚举值展示成人话，未知值原样保留", () => {
	assert.equal(eventDraftDisplayValue(item("type", "product_launch")), "产品发布");
	assert.equal(eventDraftDisplayValue(item("subjectKind", "competitor")), "竞品");
	assert.equal(eventDraftDisplayValue(item("scope", "title_only")), "仅标题");
	assert.equal(eventDraftDisplayValue(item("type", "unknown_type")), "unknown_type");
	assert.equal(eventDraftDisplayValue(item("title", "原样")), "原样");
});

test("按字段分组：引用在前，未知字段放末尾且不丢弃", () => {
	const items = [
		item("limitations", "局限"),
		item("citationSubject", "主体", "quote"),
		item("title", "标题", "quote"),
		item("weirdField" as EventDraftItem["field"], "未知"),
	];
	const groups = groupEventDraftItems(items);
	assert.deepEqual(groups.map((group) => group.field), ["citationSubject", "title", "limitations", "weirdField"]);
	assert.equal(groups[1]!.label, "事件标题");
	assert.equal(groups[3]!.items.length, 1, "未知字段保留给用户看");
});
