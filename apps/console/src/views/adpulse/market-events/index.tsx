import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useLocation } from "react-router";
import { consoleClient, type components } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Section } from "../../../components/ui/section";
import { formatBeijing } from "../settings/notification-records/record-view.js";

type EventInput = components["schemas"]["MarketEventInput"];
type EventVersion = components["schemas"]["MarketEventVersion"];
type Source = EventInput["sources"][number];
const types = { announcement: "公告", campaign: "活动", product_launch: "产品发布" };
const scopes = { link_only: "仅链接（未读取）", title_only: "仅标题", search_snippet: "搜索摘要", excerpt: "正文摘录 / 不完整", full_text: "完整正文（录入者声明）" };
const origins = { unknown: "来源未核验", official: "官方原文（录入者声明）", repost: "转载", search: "搜索结果" };
const fields = { subject: "公告主体", eventTime: "事件时间", conditions: "适用条件" };
const control = "w-full rounded-md border bg-background px-3 py-2 text-sm";
const source = (): Source => ({ url: null, publisher: "", content: null, scope: "link_only", origin: "unknown", publishedAt: null, acquiredAt: new Date().toISOString(), limitations: "" });
const blank = (): EventInput => ({ occurrenceKey: `manual:${crypto.randomUUID()}`, title: "", type: "announcement", subject: { kind: "brand", name: "" }, eventTime: null, conditions: null, sources: [source()], citations: { subject: null, eventTime: null, conditions: null }, taskRefs: [], provenance: { simulated: false, reference: null, transformation: null } });
function failure(status: number): Error {
	return new Error(status === 409 ? "保存冲突：版本已更新或重复请求内容不同，请刷新核对后重试。" : status === 404 ? "事件或关联任务不可访问。" : "保存失败，请核对来源、引用、日期和必填字段后重试。");
}
/** 后端给的是结构化判断原因，界面只挑对用户有意义的说法，不把字段名和防御性表述直接摊开。 */
const FIELD_LABELS = { subject: "公告主体", eventTime: "事件时间", conditions: "适用条件" };

function plainReasons(reasons: string[]): { gaps: string[]; notes: string[] } {
	const gaps: string[] = [];
	const notes: string[] = [];
	for (const reason of reasons) {
		const citation = /^(subject|eventTime|conditions): 缺少官方原文引用/.exec(reason);
		if (citation) { gaps.push(FIELD_LABELS[citation[1] as keyof typeof FIELD_LABELS]); continue; }
		// 这两条事实在下面单独显示「未知」，不再重复列一遍原因。
		if (reason === "事件时间未知" || reason === "适用条件未知") continue;
		if (reason === "发布时间未知") { notes.push("材料没有发布时间"); continue; }
		if (reason === "合成样例，仅供测试") { notes.push("这是合成样例，仅供测试"); continue; }
		// 未识别的新原因原样显示，避免以后加了判断条件而界面沉默。
		notes.push(reason);
	}
	return { gaps, notes };
}

function Summary({ version }: { version: EventVersion }) {
	const input = version.input;
	const { gaps, notes } = plainReasons(version.candidate.reasons);
	const ready = version.candidate.status === "evidence_ready";
	return <div className="space-y-4 text-sm">
		{input.provenance.simulated && <p className="font-semibold text-amber-700">模拟样例 · 不是真实公告</p>}
		<p className="text-muted-foreground">{types[input.type]} · {input.subject.name} · 第 {version.version} 版</p>
		<p className={ready ? "text-sm" : "text-sm text-amber-700"}>
			{ready ? "依据齐备，会进入通知筛选。" : "还缺依据，暂时不会进入通知筛选。"}
			<span className="text-muted-foreground">保存只是存档，不会发出通知。</span>
		</p>
		{gaps.length ? <p>还差这几处的原文引用：{gaps.join("、")}</p> : null}
		{notes.length ? <p className="text-muted-foreground">{notes.join("；")}</p> : null}
		<div className="space-y-1">
			<p>事件时间：{input.eventTime ?? "未知"}</p>
			<p>适用条件：{input.conditions ?? "未知"}</p>
		</div>
		<div className="space-y-1">
			<p className="font-medium">用到的材料</p>
			{input.sources.map((s, index) => <div key={version.materials[index]?.id ?? index} className="space-y-1 rounded-md border p-3">
				<p>{index + 1}. {s.publisher || "未命名来源"}<span className="text-muted-foreground">（{scopes[s.scope]}）</span></p>
				{s.url
					? <a className="break-all text-sm hover:underline" href={s.url} target="_blank" rel="noreferrer">{s.content ?? s.url}</a>
					: <p>{s.content ?? "没有原文链接"}</p>}
				<p className="text-xs text-muted-foreground">
					发布 {s.publishedAt ? formatLeadDate(s.publishedAt) : "时间未知"}
					{s.scope === "link_only" || s.scope === "title_only" ? " · 只拿到列表里的标题和链接，没有读正文" : ""}
				</p>
			</div>)}
		</div>
		<div className="space-y-1">
			<p className="font-medium">事实依据</p>
			{(Object.keys(fields) as Array<keyof typeof fields>).map(field => {
				const citation = input.citations[field];
				return <p key={field} className="text-muted-foreground">
					{fields[field]}：{citation ? `材料 ${citation.sourceIndex + 1}「${citation.quote}」` : "还没有引用原文"}
				</p>;
			})}
		</div>
		<div className="space-y-1">
			<p className="font-medium">关联任务</p>
			{input.taskRefs.length
				? input.taskRefs.map(ref => <p key={ref.taskId} className="text-muted-foreground">
					你标记为相关：<Link className="hover:underline" to={`/tasks/${ref.taskId}`}>任务 v{ref.taskVersion}</Link>{ref.reason ? ` · ${ref.reason}` : ""}
				</p>)
				: <p className="text-muted-foreground">没有关联推广任务。</p>}
		</div>
		<details className="text-xs text-muted-foreground">
			<summary className="cursor-pointer">技术细节</summary>
			<div className="space-y-1 pt-2">
				<p>录入方式：{version.method === "manual" ? "人工录入" : "来源线索导入"} · 录入时间 {formatBeijing(version.createdAt)}</p>
				{input.sources.map((s, index) => <p key={version.materials[index]?.id ?? index}>
					材料 {index + 1} 编号 {version.materials[index]?.id ?? "未知"} · 取得于 {s.acquiredAt ? formatBeijing(s.acquiredAt) : "未知"}
					{" · "}{origins[s.origin]}
					{s.limitations ? ` · 局限：${s.limitations}` : ""}
				</p>)}
				{input.provenance.reference ? <p>来源：{input.provenance.reference}</p> : null}
				{input.provenance.transformation ? <p>转换：{input.provenance.transformation}</p> : null}
				<p>版本说明：{version.changeReason}</p>
			</div>
		</details>
	</div>;
}
type Lead = components["schemas"]["SourceLead"];

/** 「并入已有事件」时从路由 state 里取线索；state 不在或形状不对就当没有。 */
function stateLead(state: unknown): Lead | null {
	if (!state || typeof state !== "object" || !("attachLead" in state)) return null;
	const lead = (state as { attachLead?: unknown }).attachLead;
	return lead && typeof lead === "object" && "itemId" in lead && "url" in lead ? (lead as Lead) : null;
}

/** 列表页只给日期时按日期展示；带时间的按北京时间显示，不把 UTC 串直接丢给用户。 */
export function formatLeadDate(value: string | null): string {
	if (!value) return "未知";
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const [year, month, day] = value.split("-");
		return `${year}年${Number(month)}月${Number(day)}日`;
	}
	return formatBeijing(value);
}

/** 保留期要到一年后，只显示「月日」会含糊，这里固定「年月日 时:分」（北京时间）。 */
export function formatRetention(value: string): string {
	const beijing = new Date(Date.parse(value) + 8 * 60 * 60 * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${beijing.getUTCFullYear()}年${beijing.getUTCMonth() + 1}月${beijing.getUTCDate()}日 ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}`;
}

/** 采集结果码翻译成人话；未知码原样显示，不猜。 */
const OUTCOME_LABELS: Record<string, string> = {
	ok: "成功",
	parse_failed: "页面结构变化，未取到条目",
	http_error: "站点返回错误",
	blocked: "被站点拒绝访问",
	stopped: "已停止（需人工恢复）",
};

export const outcomeLabel = (outcome: string | null): string =>
	outcome ? (OUTCOME_LABELS[outcome] ?? outcome) : "暂无记录";
/** 从原文链接取一个稳定短标识，用于默认的事件编号（同一篇文章永远是同一个值）。 */
export function occurrenceKeyFromUrl(sourceKey: string, url: string): string {
	let slug = "";
	try {
		const parts = new URL(url).pathname.split("/").filter(Boolean);
		const last = parts[parts.length - 1] ?? "";
		slug = last === "index.html" || last === "index.shtml"
			? (parts[parts.length - 2] ?? "")
			: last.replace(/\.s?html?$/, "");
	} catch {
		slug = url;
	}
	return `${sourceKey}:${slug || url}`.slice(0, 200);
}

/** 一条线索变成一个「仅标题」来源：只有标题和原文链接，正文未读取。 */
export function leadSource(lead: Lead): Source {
	return {
		url: lead.url, publisher: lead.sourceLabel, content: lead.title, scope: "title_only", origin: "official",
		publishedAt: lead.publishedAt, acquiredAt: lead.lastSeenAt,
		limitations: "仅取得来源列表的标题与链接，未读取正文；主体按来源站点声明归属，不是标题推断",
	};
}

/** 线索转事件：只预填标题、主体声明与那条标题+链接，引用/类型仍需本人补。 */
export function leadDraft(lead: Lead): EventInput {
	return {
		...blank(),
		title: lead.title,
		// 事件编号按原文链接生成：同一篇文章永远得到同一个值，避免重复事件。
		occurrenceKey: occurrenceKeyFromUrl(lead.sourceKey, lead.url),
		subject: { kind: lead.subject.kind, name: lead.subject.name },
		sources: [leadSource(lead)],
		provenance: { simulated: false, reference: `${lead.sourceKey} · 来源线索 ${lead.itemId}`, transformation: null },
	};
}

/** 勾选多条线索合并成一条事件：用户用「选择」表达同一件事，编号取第一条链接的自动值。 */
export function mergeLeadDraft(leads: Lead[]): EventInput {
	const first = leads[0];
	if (!first) return blank();
	return {
		...leadDraft(first),
		sources: leads.map(leadSource),
		provenance: {
			simulated: false,
			reference: leads.map(l => `${l.sourceKey} · 来源线索 ${l.itemId}`).join("；"),
			transformation: null,
		},
	};
}
function EventForm({ current, prefill, attach, saved }: { current?: EventVersion; prefill?: EventInput; attach?: Lead; saved: (id: string, status: components["schemas"]["MarketEventWriteResult"]["status"]) => void }) {
	const attachAlreadyIn = !!(current && attach && current.input.sources.some(s => s.url === attach.url));
	const [draft, setDraft] = useState<EventInput>(() => {
		const base = current ? structuredClone(current.input) : (prefill ?? blank());
		// 并入线索：把该链接作为新增来源放进修订表单，由本人核对后保存；已在事件里的不重复加。
		if (current && attach && !attachAlreadyIn) base.sources = [...base.sources, leadSource(attach)];
		return base;
	});
	const [reason, setReason] = useState("");
	const [taskId, setTaskId] = useState("");
	const operation = useRef<{ body: string; key: string } | null>(null);
	const tasks = useQuery({ queryKey: ["tasks"], queryFn: async () => { const r = await consoleClient.GET("/api/tasks"); if (!r.data) throw new Error("无法读取任务"); return r.data.items; } });
	const mutation = useMutation({ mutationFn: async () => {
		const event: EventInput = { ...draft, citations: {
			subject: draft.citations.subject?.quote.trim() ? draft.citations.subject : null,
			eventTime: draft.citations.eventTime?.quote.trim() ? draft.citations.eventTime : null,
			conditions: draft.citations.conditions?.quote.trim() ? draft.citations.conditions : null,
		} };
		const serialized = JSON.stringify({ event, reason });
		if (operation.current?.body !== serialized) operation.current = { body: serialized, key: crypto.randomUUID() };
		const headers = { "Idempotency-Key": operation.current.key };
		const result = current
			? await consoleClient.POST("/api/market-events/{eventId}/revisions", { params: { path: { eventId: current.eventId }, header: headers }, body: { expectedVersion: current.version, event, changeReason: reason } })
			: await consoleClient.POST("/api/market-events", { params: { header: headers }, body: event });
		if (!result.data) {
			if (result.error?.error === "event write in progress") throw new Error("另一个保存仍在进行，请稍后重试。");
			throw failure(result.response.status);
		}
		return result.data;
	}, onSuccess: result => saved(result.version.eventId, result.status) });
	const patchSource = (index: number, patch: Partial<Source>) => setDraft(d => ({ ...d, sources: d.sources.map((s,i) => i === index ? { ...s, ...patch } : s) }));
	return <form className="space-y-4" onSubmit={event => { event.preventDefault(); mutation.mutate(); }}>
		<fieldset disabled={mutation.isPending} className="space-y-4">
			{attach && (attachAlreadyIn
				? <p className="text-sm text-amber-700">这条链接已经在本事件来源里，没有重复添加。</p>
				: <p className="text-sm text-muted-foreground">已把线索「{attach.title}」加入下方来源列表，核对后填写修订说明并保存。</p>)}
			<div className="grid gap-3 md:grid-cols-2">
				<label>事件标题<Input required maxLength={200} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
				<label>类别<select className={control} value={draft.type} onChange={e => { const type = (Object.keys(types) as Array<keyof typeof types>).find(k => k === e.target.value); if (type) setDraft({ ...draft, type }); }}>{Object.entries(types).map(([v,label]) => <option key={v} value={v}>{label}</option>)}</select></label>
				<label>关注对象类型<select className={control} value={draft.subject.kind} onChange={e => setDraft({ ...draft, subject: { ...draft.subject, kind: e.target.value === "brand" ? "brand" : "competitor" } })}><option value="brand">品牌</option><option value="competitor">竞品</option></select></label>
				<label>关注对象名称<Input required maxLength={200} value={draft.subject.name} onChange={e => setDraft({ ...draft, subject: { ...draft.subject, name: e.target.value } })} /></label>
				<label>事件时间（未知留空）<Input maxLength={2000} value={draft.eventTime ?? ""} onChange={e => setDraft({ ...draft, eventTime: e.target.value || null })} /></label>
			</div>
			<label className="block">适用条件（未知留空）<textarea className={control} maxLength={2000} value={draft.conditions ?? ""} onChange={e => setDraft({ ...draft, conditions: e.target.value || null })} /></label>
			{draft.sources.map((s,index) => <fieldset key={index} className="space-y-3 rounded-md border p-4"><legend>来源 {index + 1}</legend>
				<label className="block">来源名称<Input required maxLength={200} value={s.publisher} onChange={e => patchSource(index, { publisher: e.target.value })} /></label>
				<label className="block">原文链接（不自动读取）<Input type="url" maxLength={2000} value={s.url ?? ""} onChange={e => patchSource(index, { url: e.target.value || null })} /></label>
				<div className="grid gap-3 md:grid-cols-2">
					<label>内容范围<select className={control} value={s.scope} onChange={e => { const scope = (Object.keys(scopes) as Array<keyof typeof scopes>).find(k => k === e.target.value); if (scope) patchSource(index, { scope, ...(scope === "link_only" ? { content: null } : {}) }); }}>{Object.entries(scopes).map(([v,label]) => <option key={v} value={v}>{label}</option>)}</select></label>
					<label>来源性质<select className={control} value={s.origin} onChange={e => { const origin = (Object.keys(origins) as Array<keyof typeof origins>).find(k => k === e.target.value); if (origin) patchSource(index, { origin }); }}>{Object.entries(origins).map(([v,label]) => <option key={v} value={v}>{label}</option>)}</select></label>
					<label>发布时间（日期或 ISO 时间，未知留空）<Input value={s.publishedAt ?? ""} onChange={e => patchSource(index, { publishedAt: e.target.value || null })} /></label>
					<label>获取 / 录入时间（ISO 日期时间）<Input required value={s.acquiredAt} onChange={e => patchSource(index, { acquiredAt: e.target.value })} /></label>
				</div>
				{s.scope !== "link_only" && <label className="block">原始材料文字<textarea className={control} required maxLength={30000} rows={5} value={s.content ?? ""} onChange={e => patchSource(index, { content: e.target.value || null })} /></label>}
				<label className="block">缺失与局限<textarea className={control} maxLength={2000} value={s.limitations} onChange={e => patchSource(index, { limitations: e.target.value })} /></label>
			<Button type="button" variant="outline" disabled={draft.sources.length === 1} onClick={() => setDraft(d => {
					const adjust = (citation: EventInput["citations"]["subject"]) => !citation || citation.sourceIndex === index ? null : { ...citation, sourceIndex: citation.sourceIndex > index ? citation.sourceIndex - 1 : citation.sourceIndex };
					return { ...d, sources: d.sources.filter((_s,i) => i !== index), citations: { subject: adjust(d.citations.subject), eventTime: adjust(d.citations.eventTime), conditions: adjust(d.citations.conditions) } };
				})}>移除来源 {index + 1}</Button>
			</fieldset>)}
			<Button type="button" variant="outline" disabled={draft.sources.length >= 10} onClick={() => setDraft({ ...draft, sources: [...draft.sources, source()] })}>补充来源</Button>
			<fieldset className="space-y-3 rounded-md border p-4"><legend>事实依据（可留空；引用要照抄上面的材料原文）</legend>{(Object.keys(fields) as Array<keyof typeof fields>).map(field => <div key={field} className="grid gap-2 md:grid-cols-3">
				<label>{fields[field]}引用来源<select className={control} value={draft.citations[field]?.sourceIndex ?? 0} onChange={e => { const citation = draft.citations[field]; setDraft({ ...draft, citations: { ...draft.citations, [field]: { quote: citation?.quote ?? "", sourceIndex: Number(e.target.value) } } }); }}>{draft.sources.map((_s,i) => <option key={i} value={i}>来源 {i + 1}</option>)}</select></label>
				<label className="md:col-span-2">{fields[field]}原文引用<Input maxLength={2000} value={draft.citations[field]?.quote ?? ""} onChange={e => setDraft({ ...draft, citations: { ...draft.citations, [field]: { sourceIndex: draft.citations[field]?.sourceIndex ?? 0, quote: e.target.value } } })} /></label>
			</div>)}</fieldset>
			<fieldset className="space-y-2 rounded-md border p-4"><legend>关联本人任务（可选）</legend>
				{tasks.error && <p role="alert">任务列表读取失败，请刷新后重试。</p>}
				<select aria-label="选择关联任务" className={control} value={taskId} onChange={e => setTaskId(e.target.value)}><option value="">请选择</option>{tasks.data?.filter(t => !draft.taskRefs.some(r => r.taskId === t.taskId)).map(t => <option key={t.taskId} value={t.taskId}>{t.product}</option>)}</select>
				<Button type="button" variant="outline" disabled={!taskId || draft.taskRefs.length >= 20} onClick={() => { const task = tasks.data?.find(t => t.taskId === taskId); if (task) { setDraft({ ...draft, taskRefs: [...draft.taskRefs, { taskId: task.taskId, taskVersion: task.version, reason: "" }] }); setTaskId(""); } }}>添加任务关联</Button>
				{draft.taskRefs.map((ref,i) => <div key={ref.taskId} className="flex items-end gap-2"><label className="grow">{tasks.data?.find(t => t.taskId === ref.taskId)?.product ?? "已关联任务"} v{ref.taskVersion} 的关联理由<Input required maxLength={1000} value={ref.reason} onChange={e => setDraft({ ...draft, taskRefs: draft.taskRefs.map((r,n) => n === i ? { ...r, reason: e.target.value } : r) })} /></label><Button type="button" variant="outline" onClick={() => setDraft({ ...draft, taskRefs: draft.taskRefs.filter((_r,n) => n !== i) })}>移除关联</Button></div>)}
			</fieldset>
			<label className="flex items-center gap-2"><input type="checkbox" checked={draft.provenance.simulated} disabled={current?.input.provenance.simulated === true} onChange={e => setDraft({ ...draft, provenance: { ...draft.provenance, simulated: e.target.checked } })} />这是合成 / 模拟材料</label>
			{draft.provenance.simulated && <div className="space-y-2"><label className="block">样例来源与版本<Input required maxLength={2000} value={draft.provenance.reference ?? ""} onChange={e => setDraft({ ...draft, provenance: { ...draft.provenance, reference: e.target.value || null } })} /></label><label className="block">转换记录<Input required maxLength={2000} value={draft.provenance.transformation ?? ""} onChange={e => setDraft({ ...draft, provenance: { ...draft.provenance, transformation: e.target.value || null } })} /></label></div>}
			{current && <label className="block">本次修订说明<Input required maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label>}
			{mutation.error && <p role="alert" className="text-red-600">{mutation.error.message}</p>}
			<Button type="submit">{mutation.isPending ? "正在保存…" : current ? "保存修订" : "保存事件"}</Button>
		</fieldset>
	</form>;
}
export default function MarketEventsPage() {
	const { eventId } = useParams();
	const navigate = useNavigate();
	const locationState: unknown = useLocation().state;
	const notice = locationState && typeof locationState === "object" && "marketEventNotice" in locationState && typeof locationState.marketEventNotice === "string" ? locationState.marketEventNotice : null;
	const attachLead = stateLead(locationState);
	const queryClient = useQueryClient();
	const [editingOverride, setEditingOverride] = useState<boolean | null>(null);
	const editing = editingOverride ?? !!attachLead;
	const setEditing = setEditingOverride;
	const [selectedLeads, setSelectedLeads] = useState<string[]>([]);
	const [leadSource, setLeadSource] = useState<string | null>(null);
	const [mergeDraftState, setMergeDraftState] = useState<{ leads: Lead[]; key: string } | null>(null);
	const list = useQuery({ queryKey: ["market-events"], enabled: !eventId, queryFn: async () => { const r = await consoleClient.GET("/api/market-events"); if (!r.data) throw new Error("无法读取事件列表"); return r.data.items; } });
	const leads = useQuery({ queryKey: ["source-leads"], enabled: !eventId, queryFn: async () => { const r = await consoleClient.GET("/api/me/source-leads"); if (!r.data) throw new Error("无法读取来源线索"); return r.data; } });
	const [leadDraftState, setLeadDraftState] = useState<{ lead: Lead; key: string } | null>(null);
	const feedStatus = useQuery({ queryKey: ["source-status"], enabled: !eventId, queryFn: async () => {
		const r = await consoleClient.GET("/api/me/source-status");
		if (!r.data) throw new Error("无法读取来源状态");
		return r.data.items;
	} });
	const leadGroups = (() => {
		const groups = new Map<string, { key: string; label: string; count: number }>();
		for (const lead of leads.data?.leads ?? []) {
			const group = groups.get(lead.sourceKey);
			if (group) group.count += 1;
			else groups.set(lead.sourceKey, { key: lead.sourceKey, label: lead.sourceLabel, count: 1 });
		}
		return [...groups.values()].sort((left, right) => right.count - left.count);
	})();
	const visibleLeads = (leads.data?.leads ?? []).filter((lead) => !leadSource || lead.sourceKey === leadSource);
	const lifecycle = useQuery({ queryKey: ["market-events", eventId, "lifecycle"], enabled: !!eventId, queryFn: async () => {
		const r = await consoleClient.GET("/api/market-events/{eventId}/lifecycle", { params: { path: { eventId: eventId! } } });
		if (!r.data) throw new Error("无法读取保留期");
		return r.data;
	} });
	const detail = useQuery({ queryKey: ["market-events", eventId], enabled: !!eventId, queryFn: async () => { const r = await consoleClient.GET("/api/market-events/{eventId}", { params: { path: { eventId: eventId! } } }); if (!r.data) throw new Error(r.response.status === 404 ? "事件不存在或无权访问" : "无法读取事件"); return r.data; } });
	const saved = async (id: string, status: components["schemas"]["MarketEventWriteResult"]["status"]) => {
		setEditing(false);
		setSelectedLeads([]);
		await queryClient.invalidateQueries({ queryKey: ["market-events"] });
		navigate(`/market-events/${id}`, { state: { marketEventNotice: status === "duplicate" ? "这条事件之前录过了，显示的是已有版本；新材料要到详情页做一次修订才会加进去。" : "事件已保存。" } });
	};
	if (eventId) return <div className="p-6 space-y-4">
		<Link className="underline text-sm" to="/market-events">返回市场与竞品事件</Link>
		{notice && <p role="status">{notice}</p>}
		{detail.isLoading && <p>正在读取事件…</p>}
		{detail.error && (lifecycle.data?.expired
			? <p role="status" className="rounded-md border border-dashed p-4 text-sm">
				这条事件已过保留期（{lifecycle.data.retentionDays} 天），内容不再展示。到期时间 {formatRetention(lifecycle.data.expiresAt)}。
			</p>
			: <p role="alert">{detail.error.message}</p>)}
		{detail.data && <><h1 className="text-2xl font-bold">{detail.data.current.input.title}</h1><Summary version={detail.data.current} />
			{lifecycle.data
				? <p className="text-xs text-muted-foreground">保留至 {formatRetention(lifecycle.data.expiresAt)}。查看与投递不会顺延，每次修订会重新计时。</p>
				: null}
			<Button variant="outline" onClick={() => setEditing(!editing)}>{editing ? "取消编辑" : "修订事件 / 补充转载"}</Button>
			{editing && <EventForm key={detail.data.current.id} current={detail.data.current} attach={attachLead ?? undefined} saved={(id, status) => { void saved(id, status); }} />}
			<h2 className="font-semibold">历史版本</h2>{detail.data.versions.slice(1).map(v => <details key={v.id} className="rounded-md border p-4"><summary>第 {v.version} 版 · {v.changeReason} · {formatBeijing(v.createdAt)}</summary><Summary version={v} /></details>)}
		</>}
	</div>;
	return <div className="p-6 space-y-8"><div className="flex items-center justify-between gap-3"><h1 className="text-2xl font-bold">市场与竞品事件</h1><Button onClick={() => setEditing(!editing)}>{editing ? "收起录入" : "录入事件"}</Button></div>
		{editing && <EventForm key={mergeDraftState?.key ?? leadDraftState?.key ?? "manual"} prefill={mergeDraftState ? mergeLeadDraft(mergeDraftState.leads) : leadDraftState ? leadDraft(leadDraftState.lead) : undefined} saved={(id, status) => { setLeadDraftState(null); setMergeDraftState(null); void saved(id, status); }} />}
		<Section title={`已记录的事件${list.data ? `（${list.data.length}）` : ""}`} hint="依据齐备才会进入通知筛选；保存不会发消息">
			{list.isLoading && <p>正在读取事件…</p>}
			{list.error && <p role="alert">{list.error.message}</p>}
			{list.data?.length === 0 && <p className="rounded-md border border-dashed p-6">还没有录入事件。可先保存链接，缺失信息保持未知。</p>}
			<div className="grid gap-4 md:grid-cols-2">{list.data?.map(v => <Link key={v.eventId} to={`/market-events/${v.eventId}`}><Card className="h-full transition hover:ring-foreground/25"><CardHeader><CardTitle>{v.input.provenance.simulated ? "【模拟】" : ""}{v.input.title}</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p>{types[v.input.type]} · {v.input.subject.name} · 第 {v.version} 版</p><p>{v.candidate.status === "evidence_ready" ? "依据齐备" : "还缺依据"}</p><p>{v.input.taskRefs.length ? `关联 ${v.input.taskRefs.length} 个任务` : "未关联任务"}</p></CardContent></Card></Link>)}</div>
		</Section>
		{leads.error && <p role="alert">{leads.error.message}</p>}
		{leads.data && leads.data.leads.length > 0 && <Section
			collapsible
			defaultOpen={false}
			title={`来源线索（${visibleLeads.length}）`}
			hint="官网列表的标题与链接，还没读正文；展开后可转成事件"
		>
			<div className="space-y-2 text-sm">
				<p className="text-xs text-muted-foreground">
					下面是官网列表页的标题和原文链接，还没有读正文。想看完整内容请点标题去原文；要变成事件，
					点「转事件」。如果几个链接说的是同一件事，先勾选这几条再点「合并为一条事件」；
					之后由你补上时间、适用条件和原文引用。
				</p>
				{feedStatus.data && feedStatus.data.length > 0 ? <ul className="space-y-1 text-xs text-muted-foreground">
					{feedStatus.data.map((feed) => <li key={feed.key}>
						{feed.status === "stopped"
							? `${feed.label}：已停止采集，需要人工恢复`
							: `${feed.label}：${feed.lastRun ? `最近一次采集在 ${formatBeijing(feed.lastRun)}` : "还没有采集记录"}，${feed.lastOutcome ? outcomeLabel(feed.lastOutcome) : "暂无结果"}，现有 ${feed.activeItems} 条`}
					</li>)}
				</ul> : null}
				{feedStatus.error ? <p role="alert" className="text-xs text-red-600">读取来源状态失败，不影响线索列表。</p> : null}
				{leadGroups.length > 1 ? <div className="flex flex-wrap items-center gap-2" role="group" aria-label="按来源筛选线索">
					<button
						type="button"
						className={`rounded-full border px-3 py-1 text-xs ${leadSource === null ? "bg-foreground text-background" : "text-muted-foreground"}`}
						aria-pressed={leadSource === null}
						onClick={() => { setLeadSource(null); setSelectedLeads([]); }}
					>全部 {leads.data.leads.length}</button>
					{leadGroups.map((group) => <button
						key={group.key}
						type="button"
						className={`rounded-full border px-3 py-1 text-xs ${leadSource === group.key ? "bg-foreground text-background" : "text-muted-foreground"}`}
						aria-pressed={leadSource === group.key}
						onClick={() => { setLeadSource(group.key); setSelectedLeads([]); }}
					>{group.label} {group.count}</button>)}
				</div> : null}
				{selectedLeads.length > 0 ? <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
					<span className="text-xs text-muted-foreground">已选 {selectedLeads.length} 条 · 认为是同一件事？</span>
					<Button onClick={() => {
						const chosen = (leads.data?.leads ?? []).filter(l => selectedLeads.includes(l.itemId));
						if (chosen.length === 0) return;
						setLeadDraftState(null);
						setMergeDraftState({ leads: chosen, key: chosen.map(l => l.itemId).join("+") });
						setEditing(true);
					}}>合并为一条事件</Button>
					<Button variant="outline" onClick={() => setSelectedLeads([])}>取消选择</Button>
				</div> : null}
				{visibleLeads.length === 0 ? <p className="text-xs text-muted-foreground">这个来源暂时没有线索。</p> : null}
				<ul className="space-y-2">
					{visibleLeads.map((lead) => <li key={lead.itemId} className="rounded-md border p-3">
						<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
							<div className="min-w-0 space-y-1">
								<div className="flex items-start gap-2">
									{!lead.convertedEventId ? <input
										type="checkbox" className="mt-1" aria-label={`选择线索：${lead.title}`}
										checked={selectedLeads.includes(lead.itemId)}
										onChange={() => setSelectedLeads(ids => ids.includes(lead.itemId) ? ids.filter(id => id !== lead.itemId) : [...ids, lead.itemId])}
									/> : null}
									<a className="block font-medium break-all hover:underline" href={lead.url} target="_blank" rel="noreferrer">{lead.title}</a>
								</div>
								<p className="text-xs text-muted-foreground">
									来自 {lead.sourceLabel} · 关联{lead.subject.kind === "brand" ? "品牌" : "竞品"}：{lead.subject.name}
									{" · "}发布 {formatLeadDate(lead.publishedAt)}
									{" · "}最近出现 {formatBeijing(lead.lastSeenAt)}
								</p>
							</div>
							<div className="space-y-1 sm:justify-self-end sm:text-right">
								{lead.convertedEventId
									? <Link className="text-sm text-muted-foreground hover:underline" to={`/market-events/${lead.convertedEventId}`}>已录入，查看事件</Link>
									: <>
										<Button variant="outline" onClick={() => { setMergeDraftState(null); setLeadDraftState({ lead, key: lead.itemId }); setEditing(true); }}>转事件</Button>
										{list.data && list.data.length > 0 ? <details className="text-xs">
											<summary className="cursor-pointer text-muted-foreground">同一件事已录过？并入已有事件</summary>
											<ul className="mt-1 max-h-56 space-y-1 overflow-auto">
												{list.data.map(v => <li key={v.eventId}>
													<button type="button" className="text-left hover:underline" onClick={() => navigate(`/market-events/${v.eventId}`, { state: { attachLead: lead } })}>{v.input.title}</button>
												</li>)}
											</ul>
										</details> : null}
									</>}
							</div>
						</div>
					</li>)}
				</ul>
			</div>
		</Section>}
		{leads.data && leads.data.leads.length === 0 && leads.data.sources.every((item) => !item.enabled) && <p className="text-xs text-muted-foreground">还没有开启来源站点；可以到订阅页打开已接入的站点。</p>}
	</div>;
}
