import { json, serve } from "./harness.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import MarketEventsPage from "../src/views/adpulse/market-events/index.tsx";
import type { components } from "../src/adpulse-client.ts";

type Input = components["schemas"]["MarketEventInput"];
type Version = components["schemas"]["MarketEventVersion"];
const input = (): Input => ({ occurrenceKey: "release", title: "样例发布", type: "announcement", subject: { kind: "brand", name: "测试品牌" }, eventTime: null, conditions: null, sources: [{ url: "https://example.com/news", publisher: "测试来源", content: null, scope: "link_only", origin: "unknown", publishedAt: null, acquiredAt: "2026-11-16T01:00:00Z", limitations: "正文缺失" }], citations: { subject: null, eventTime: null, conditions: null }, taskRefs: [], provenance: { simulated: false, reference: null, transformation: null } });
const version = (event: Input = input(), number = 1): Version => ({ id: `event-1:${number}`, eventId: "event-1", ownerId: "owner", version: number, evidenceRevision: 1, input: event, method: "manual", sourceItemId: null, materials: [{ id: `event-1:${number}:source:0`, method: "manual", sourceItemId: null }], createdAt: "2026-11-16T01:00:00Z", changeReason: "人工录入", candidate: { status: "insufficient", reasons: ["事件时间未知", "合成样例，仅供测试"] } });
const closedSources = [
	{ key: "weichai_news", label: "潍柴新闻与事件", subject: { kind: "brand" as const, name: "潍柴" }, enabled: false },
	{ key: "haier_news", label: "海尔品牌资讯", subject: { kind: "brand" as const, name: "海尔" }, enabled: false },
];
const defaults = { "GET /api/tasks": () => json({ items: [] }), "GET /api/market-events": () => json({ items: [] }), "GET /api/me/source-leads": () => json({ leads: [], sources: closedSources }) };
function mount(path = "/market-events") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes><Route path="/market-events" element={<MarketEventsPage />} /><Route path="/market-events/:eventId" element={<MarketEventsPage />} /></Routes></MemoryRouter></QueryClientProvider>);
}
function fillLink() {
	fireEvent.change(screen.getByLabelText("事件标题"), { target: { value: "样例发布" } });
	fireEvent.change(screen.getByLabelText("同一事件标识", { exact: false }), { target: { value: "release" } });
	fireEvent.change(screen.getByLabelText("关注对象名称"), { target: { value: "测试品牌" } });
	fireEvent.change(screen.getByLabelText("来源名称"), { target: { value: "测试来源" } });
	fireEvent.change(screen.getByLabelText("原文链接（不自动读取）"), { target: { value: "https://example.com/news" } });
}
test("市场事件页：来源线索只展示标题与链接，转事件预填标题/主体/仅标题来源", async t => {
	t.after(cleanup);
	const lead = {
		sourceKey: "weichai_news", sourceLabel: "潍柴新闻与事件", subject: { kind: "brand", name: "潍柴" },
		itemId: "weichai_news:1", title: "潍柴列表标题", url: "https://www.weichai.com/news/1.html",
		publishedAt: "2026-11-15", firstSeenAt: "2026-11-16T00:01:00.000Z", lastSeenAt: "2026-11-16T00:02:00.000Z",
	};
	const bodies: Input[] = [];
	serve(defaults, {
		"POST /api/market-events": async (req) => {
			const body: Input = await req.json();
			bodies.push(body);
			return json({ status: "created", version: version(body) }, 201);
		},
		"GET /api/market-events/event-1": () => json({ current: version(), versions: [version()] }),
		"GET /api/me/source-leads": () => json({
			leads: [lead, { ...lead, itemId: "weichai_news:2", title: "已录入的标题", convertedEventId: "event-1" }],
			sources: [{ ...closedSources[0]!, enabled: true }, closedSources[1]!],
		}),
	});
	mount();
	const link = await screen.findByRole("link", { name: "潍柴列表标题" });
	assert.equal(link.getAttribute("href"), "https://www.weichai.com/news/1.html");
	assert.equal(screen.getAllByText(/声明主体 潍柴/).length, 2, "每条线索都标出声明主体");
	assert.equal(screen.getAllByText(/发布时间 2026-11-15/).length, 2);
	assert.equal(screen.getByRole("link", { name: "已录入，查看事件" }).getAttribute("href"), "/market-events/event-1");
	fireEvent.click(screen.getAllByRole("button", { name: "转事件" })[0]!);
	assert.equal((screen.getByLabelText("事件标题") as HTMLInputElement).value, "潍柴列表标题");
	assert.equal((screen.getByLabelText("关注对象名称") as HTMLInputElement).value, "潍柴");
	assert.equal((screen.getByLabelText("原文链接（不自动读取）") as HTMLInputElement).value, "https://www.weichai.com/news/1.html");
	assert.equal((screen.getByLabelText("内容范围") as HTMLSelectElement).value, "title_only");
	assert.ok(screen.getByText(/仅取得来源列表的标题与链接/));
	// 实际提交：仅标题来源必须带上已取得的标题作为 content，否则领域会拒。
	fireEvent.change(screen.getByLabelText("同一事件标识", { exact: false }), { target: { value: "lead-release" } });
	fireEvent.click(screen.getByRole("button", { name: "保存事件" }));
	await waitFor(() => assert.equal(bodies.length, 1));
	const submitted = bodies[0]!;
	assert.equal(submitted.sources[0]?.scope, "title_only");
	assert.equal(submitted.sources[0]?.content, "潍柴列表标题", "把已取得的标题填入材料，不补造正文");
	assert.equal(submitted.sources[0]?.url, "https://www.weichai.com/news/1.html");
	assert.equal(submitted.subject.name, "潍柴");
	assert.equal(submitted.eventTime, null, "未知事件时间不补造");
});

test("市场事件页：仅链接保持未知，保存中禁用，成功后可追溯且不请求决策接口", async t => {
	t.after(cleanup); let release!: () => void; const pending = new Promise<void>(resolve => { release=resolve; }); let saved=version();
	const { calls } = serve(defaults, { "POST /api/market-events": async req => { const body: Input = await req.json(); saved=version(body); await pending; return json({ status: "created", version: saved },201); }, "GET /api/market-events/event-1": () => json({ current: saved, versions: [saved] }) });
	mount(); await screen.findByText(/还没有录入事件/); fireEvent.click(screen.getByRole("button",{name:"录入事件"})); fillLink();
	fireEvent.click(screen.getByRole("button",{name:"保存事件"})); await screen.findByRole("button",{name:"正在保存…"});
	assert.equal((screen.getByLabelText("事件标题") as HTMLInputElement).matches(":disabled"),true);
	release(); await screen.findByRole("heading",{name:"样例发布"});
	assert.equal(saved.input.eventTime,null); assert.equal(saved.input.sources[0]?.content,null); assert.equal(saved.input.sources[0]?.publishedAt,null);
	assert.ok(screen.getByText("未读取正文")); assert.ok(screen.getByText("尚未关联个人任务，不推断任务影响。")); assert.ok(screen.getByRole("link",{name:"查看原文"}));
	assert.equal(calls.some(c=>/sessions|choices|deliveries/.test(c)),false);
});
test("市场事件页：失败保留草稿，重试复用幂等键，引用可以选择第二来源", async t => {
	t.after(cleanup); const keys:string[]=[]; const bodies:Input[]=[];
	serve(defaults,{"POST /api/market-events":async req=>{keys.push(req.headers.get("Idempotency-Key")!);bodies.push(await req.json());return json({error:"failed"},503);}});
	mount(); fireEvent.click(await screen.findByRole("button",{name:"录入事件"}));fillLink();fireEvent.click(screen.getByRole("button",{name:"补充来源"}));
	const names=screen.getAllByLabelText("来源名称");fireEvent.change(names[1]!,{target:{value:"第二来源"}});
	fireEvent.change(screen.getAllByLabelText("内容范围")[1]!,{target:{value:"excerpt"}});
	fireEvent.change(screen.getByLabelText("原始材料文字"),{target:{value:"测试品牌的原文片段"}});
	fireEvent.change(screen.getByLabelText("公告主体引用来源"),{target:{value:"1"}});
	fireEvent.change(screen.getByLabelText("公告主体原文引用"),{target:{value:"测试品牌"}});
	fireEvent.click(screen.getByRole("button",{name:"保存事件"}));await screen.findByRole("alert");
	assert.equal((screen.getByLabelText("事件标题") as HTMLInputElement).value,"样例发布");
	assert.deepEqual(bodies[0]!.citations.subject,{sourceIndex:1,quote:"测试品牌"});
	fireEvent.click(screen.getByRole("button",{name:"保存事件"})); await waitFor(()=>assert.equal(keys.length,2)); assert.equal(keys[0],keys[1]);
});
test("市场事件页：修订带版本，冲突不冒充成功，旧依据和模拟标记保留", async t => {
	t.after(cleanup); const current=version({...input(),provenance:{simulated:true,reference:"guance-ai@pinned/file#record",transformation:"原引语映射，未知保留"}},2); const old=version(current.input,1); let payload:unknown;
	serve(defaults,{"GET /api/market-events/event-1":()=>json({current,versions:[current,old]}),"POST /api/market-events/event-1/revisions":async req=>{payload=await req.json();return json({error:"event version conflict"},409);}});
	mount("/market-events/event-1");await screen.findByRole("heading",{name:"样例发布"});
	assert.ok(screen.getAllByText(/模拟材料 · 不代表真实公告或采集结果/).length); assert.ok(screen.getByText("修订 v1 · 人工录入"));
	fireEvent.click(screen.getByRole("button",{name:"修订事件 / 补充转载"}));
	assert.equal((screen.getByLabelText("这是合成 / 模拟材料") as HTMLInputElement).disabled,true);
	fireEvent.change(screen.getByLabelText("本次修订说明"),{target:{value:"补充来源"}});fireEvent.click(screen.getByRole("button",{name:"保存修订"}));
	await screen.findByRole("alert");assert.ok(screen.getByText(/保存冲突/));assert.equal((payload as {expectedVersion:number}).expectedVersion,2);
	assert.ok(screen.getByRole("button",{name:"保存修订"}));
});
test("市场事件页：无权详情只显示拒绝结果，不渲染录入或修订动作",async t=>{
	t.after(cleanup);serve(defaults,{"GET /api/market-events/event-1":()=>json({error:"not found"},404)});mount("/market-events/event-1");await screen.findByText("事件不存在或无权访问");assert.equal(screen.queryByRole("button",{name:"修订事件 / 补充转载"}),null);
});

test("市场事件页：重复录入展示原版本并明确告知新材料未附加",async t=>{
	t.after(cleanup);const existing=version();serve(defaults,{"POST /api/market-events":()=>json({status:"duplicate",version:existing}),"GET /api/market-events/event-1":()=>json({current:existing,versions:[existing]})});
	mount();fireEvent.click(await screen.findByRole("button",{name:"录入事件"}));fillLink();fireEvent.click(screen.getByRole("button",{name:"保存事件"}));
	await screen.findByText("已存在相同事件，展示原版本。新材料尚未附加，请修订原事件。");assert.ok(await screen.findByRole("button",{name:"修订事件 / 补充转载"}));
});
test("市场事件页：移除来源时清除指向该材料的引用",async t=>{
	t.after(cleanup);let body:Input|undefined;serve(defaults,{"POST /api/market-events":async req=>{body=await req.json();return json({error:"test"},503);}});
	mount();fireEvent.click(await screen.findByRole("button",{name:"录入事件"}));fillLink();fireEvent.click(screen.getByRole("button",{name:"补充来源"}));
	fireEvent.change(screen.getByLabelText("公告主体引用来源"),{target:{value:"1"}});fireEvent.change(screen.getByLabelText("公告主体原文引用"),{target:{value:"待移除"}});
	fireEvent.click(screen.getByRole("button",{name:"移除来源 2"}));fireEvent.click(screen.getByRole("button",{name:"保存事件"}));await screen.findByRole("alert");
	assert.equal(body?.sources.length,1);assert.equal(body?.citations.subject,null);
});
