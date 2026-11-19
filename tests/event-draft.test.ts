// 事件 AI 整理：服务端只允许材料里能核对的内容，越界一律丢弃。
import assert from "node:assert/strict";
import test from "node:test";
import {
	createEventDraftExtractor,
	parseEventDraft,
} from "../packages/runtime/dist/event-draft-extractor.js";

const materials = [
	"关于新品发布的公告",
	"本公司于2026年11月16日发布新款背包，仅限试点地区销售，活动截止日期以门店公告为准。",
	"本次发布不包含价格调整。",
].join("\n");

test("事件整理：逐字引用通过校验，概括的时间与引用被丢弃", () => {
	const items = parseEventDraft(JSON.stringify({
		title: "关于新品发布的公告",
		type: "product_launch",
		subjectKind: "brand",
		subjectName: "本公司",
		eventTime: "2026年11月16日",
		conditions: "仅限试点地区销售",
		scope: "excerpt",
		limitations: "仅取得公告摘要，未看到附件。",
		citations: {
			subject: "本公司",
			eventTime: "2026年11月16日",
			conditions: "仅限试点地区销售",
		},
	}), materials);
	assert.ok(items);
	const byField = (field: string) => items.filter((item) => item.field === field);
	// 三条引用 + 两条事实：全部逐字命中材料。
	assert.equal(byField("citationSubject")[0]?.source, "quote");
	assert.equal(byField("eventTime")[0]?.source, "quote");
	assert.equal(byField("conditions")[0]?.source, "quote");
	// 标题在材料里出现 -> 逐字；枚举与整理类标为 idea。
	assert.equal(byField("title")[0]?.source, "quote");
	assert.equal(byField("type")[0]?.value, "product_launch");
	assert.equal(byField("type")[0]?.source, "idea");
	assert.equal(byField("scope")[0]?.value, "excerpt");
	assert.equal(byField("limitations")[0]?.source, "idea");
});

test("事件整理：材料里没有的内容不写入，包括编造的时间与条件", () => {
	const items = parseEventDraft(JSON.stringify({
		title: "某品牌明日降价",
		type: "campaign",
		subjectKind: "competitor",
		subjectName: "某竞品",
		eventTime: "2026-12-01",
		conditions: "全场五折",
		scope: "full_text",
		limitations: "未核验",
		citations: { subject: "某竞品", eventTime: "2026-12-01", conditions: "全场五折" },
	}), materials);
	assert.ok(items);
	const fields = items.map((item) => item.field);
	// 材料里没有 12-01 / 全场五折 / 某竞品：一律不出现。
	assert.equal(fields.includes("eventTime"), false);
	assert.equal(fields.includes("conditions"), false);
	assert.equal(fields.includes("citationEventTime"), false);
	assert.equal(fields.includes("citationConditions"), false);
	assert.equal(fields.includes("citationSubject"), false);
	// 标题是概括（材料没有这句）-> 标为 idea，供用户核对。
	assert.equal(items.find((item) => item.field === "title")?.source, "idea");
});

test("事件整理：非法枚举与畸形输出不产生建议", () => {
	const bad = [
		JSON.stringify({ type: "sale", scope: "everything", subjectKind: "other" }),
		JSON.stringify({ citations: { subject: null } }),
		JSON.stringify({ title: "x".repeat(201) }),
		JSON.stringify({}),
	];
	for (const reply of bad) {
		const items = parseEventDraft(reply, materials);
		assert.ok(items !== null, `合法 JSON 对象返回空数组而不是 null：${reply.slice(0, 20)}`);
		assert.deepEqual(items, []);
	}
	// 非 JSON / 非对象：整份拒绝，不当作空建议。
	assert.equal(parseEventDraft("not json", materials), null);
	assert.equal(parseEventDraft("[1,2]", materials), null);
	assert.equal(parseEventDraft("[]", materials), null);
});

test("事件整理：模型调用失败或材料为空时不返回建议", async () => {
	const failing = createEventDraftExtractor(async () => null);
	assert.equal(await failing({ materials }), null);
	const empty = createEventDraftExtractor(async () => JSON.stringify({}));
	assert.equal(await empty({ materials: "   " }), null);
	assert.equal(await empty({ materials: "x".repeat(30_001) }), null);
});

test("事件整理：提示词声明不返回来源性质、合成标记与任务关联", async () => {
	let systemPrompt = "";
	const extractor = createEventDraftExtractor(async (prompt) => {
		systemPrompt = prompt;
		return JSON.stringify({});
	});
	await extractor({ materials, publisher: "测试官网", url: "https://example.com/news/1" });
	for (const forbidden of ["来源性质", "获取时间", "是否合成", "任务关联"]) {
		assert.match(systemPrompt, new RegExp(forbidden), `提示词应明确排除「${forbidden}」`);
	}
	assert.match(systemPrompt, /逐字/);
	assert.match(systemPrompt, /禁止推测|禁止/);
});
