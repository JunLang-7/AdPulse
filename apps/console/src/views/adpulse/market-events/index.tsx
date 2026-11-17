import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useLocation } from "react-router";
import { consoleClient, type components } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
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
const blank = (): EventInput => ({ occurrenceKey: "", title: "", type: "announcement", subject: { kind: "brand", name: "" }, eventTime: null, conditions: null, sources: [source()], citations: { subject: null, eventTime: null, conditions: null }, taskRefs: [], provenance: { simulated: false, reference: null, transformation: null } });
function failure(status: number): Error {
	return new Error(status === 409 ? "保存冲突：版本已更新或重复请求内容不同，请刷新核对后重试。" : status === 404 ? "事件或关联任务不可访问。" : "保存失败，请核对来源、引用、日期和必填字段后重试。");
}
function Summary({ version }: { version: EventVersion }) {
	return <div className="space-y-3 text-sm">
		{version.input.provenance.simulated && <p className="font-semibold text-amber-700">模拟材料 · 不代表真实公告或采集结果</p>}
		<p>{types[version.input.type]} · {version.input.subject.name} · 修订 v{version.version} · 证据 v{version.evidenceRevision}</p>
		<p>{version.candidate.status === "evidence_ready" ? "引用齐备，来源性质仍为录入者声明，尚待独立核验。" : "证据不足"} 保存不会发送消息。</p>
		<ul className="list-disc pl-5">{version.candidate.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
		<p>事件时间：{version.input.eventTime ?? "未知"}</p><p>适用条件：{version.input.conditions ?? "未知"}</p>
		{version.input.taskRefs.length ? version.input.taskRefs.map(ref => <p key={ref.taskId}>本人声明的任务关联：<Link className="underline" to={`/tasks/${ref.taskId}`}>查看任务 v{ref.taskVersion}</Link> · {ref.reason}（不代表因果影响）</p>) : <p>尚未关联个人任务，不推断任务影响。</p>}
		{version.input.sources.map((s, index) => <section key={version.materials[index]?.id} className="space-y-2 rounded-md border p-3">
			<p className="font-medium">来源 {index + 1}：{s.publisher} · {scopes[s.scope]} · {origins[s.origin]}</p>
			{s.url ? <a className="underline break-all" href={s.url} target="_blank" rel="noreferrer">查看原文</a> : <p>原文链接缺失</p>}
			<p>发布时间：{s.publishedAt ?? "未知"} · 获取时间：{s.acquiredAt} · {version.materials[index]?.method === "manual" ? "人工录入" : "受限列表导入"}</p>
			<p className="whitespace-pre-wrap">{s.content ?? "未读取正文"}</p><p>局限：{s.limitations || "未补充；不代表无局限"}</p>
			<p className="text-xs text-muted-foreground">材料引用：{version.materials[index]?.id}</p>
		</section>)}
		{(Object.keys(fields) as Array<keyof typeof fields>).map(field => { const c = version.input.citations[field]; return <p key={field}>{fields[field]}依据：{c ? `来源 ${c.sourceIndex + 1}「${c.quote}」` : "缺失 / 待补充"}</p>; })}
		{version.input.provenance.reference && <p className="break-all">来源版本：{version.input.provenance.reference}<br />转换记录：{version.input.provenance.transformation}</p>}
		<p className="text-muted-foreground">{version.createdAt} · {version.changeReason}</p>
	</div>;
}
type Lead = components["schemas"]["SourceLead"];

/** 列表页只给日期时按日期展示；带时间的按北京时间显示，不把 UTC 串直接丢给用户。 */
export function formatLeadDate(value: string | null): string {
	if (!value) return "未知";
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const [year, month, day] = value.split("-");
		return `${year}年${Number(month)}月${Number(day)}日`;
	}
	return formatBeijing(value);
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

/** 线索转事件：只预填标题、主体声明与那条标题+链接，引用/类型仍需本人补。 */
export function leadDraft(lead: Lead): EventInput {
	return {
		...blank(),
		title: lead.title,
		// 事件编号按原文链接生成：同一篇文章永远得到同一个值，避免用户随手填写造成重复事件。
		occurrenceKey: occurrenceKeyFromUrl(lead.sourceKey, lead.url),
		subject: { kind: lead.subject.kind, name: lead.subject.name },
		sources: [{
			url: lead.url, publisher: lead.sourceLabel, content: lead.title, scope: "title_only", origin: "official",
			publishedAt: lead.publishedAt, acquiredAt: lead.lastSeenAt,
			limitations: "仅取得来源列表的标题与链接，未读取正文；主体按来源站点声明归属，不是标题推断",
		}],
		provenance: { simulated: false, reference: `${lead.sourceKey} · 来源线索 ${lead.itemId}`, transformation: null },
	};
}
function EventForm({ current, prefill, saved }: { current?: EventVersion; prefill?: EventInput; saved: (id: string, status: components["schemas"]["MarketEventWriteResult"]["status"]) => void }) {
	const [draft, setDraft] = useState<EventInput>(() => current ? structuredClone(current.input) : (prefill ?? blank()));
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
			<div className="grid gap-3 md:grid-cols-2">
				<label>事件标题<Input required maxLength={200} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
				<label>事件编号<Input required maxLength={200} value={draft.occurrenceKey} onChange={e => setDraft({ ...draft, occurrenceKey: e.target.value })} /><span className="text-xs text-muted-foreground">用来判断「是不是同一件事」：同一对象 + 类别 + 编号会被当成同一条事件，重复保存只返回原版本，不会多出一条。从线索转过来时已按原文链接自动填好，一般不用改。</span></label>
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
			<fieldset className="space-y-3 rounded-md border p-4"><legend>事实依据（可留空；必须逐字引用上方材料）</legend>{(Object.keys(fields) as Array<keyof typeof fields>).map(field => <div key={field} className="grid gap-2 md:grid-cols-3">
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
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState(false);
	const list = useQuery({ queryKey: ["market-events"], enabled: !eventId, queryFn: async () => { const r = await consoleClient.GET("/api/market-events"); if (!r.data) throw new Error("无法读取事件列表"); return r.data.items; } });
	const leads = useQuery({ queryKey: ["source-leads"], enabled: !eventId, queryFn: async () => { const r = await consoleClient.GET("/api/me/source-leads"); if (!r.data) throw new Error("无法读取来源线索"); return r.data; } });
	const [leadDraftState, setLeadDraftState] = useState<{ lead: Lead; key: string } | null>(null);
	const feedStatus = useQuery({ queryKey: ["source-status"], enabled: !eventId, queryFn: async () => {
		const r = await consoleClient.GET("/api/me/source-status");
		if (!r.data) throw new Error("无法读取来源状态");
		return r.data.items;
	} });
	const detail = useQuery({ queryKey: ["market-events", eventId], enabled: !!eventId, queryFn: async () => { const r = await consoleClient.GET("/api/market-events/{eventId}", { params: { path: { eventId: eventId! } } }); if (!r.data) throw new Error(r.response.status === 404 ? "事件不存在或无权访问" : "无法读取事件"); return r.data; } });
	const saved = async (id: string, status: components["schemas"]["MarketEventWriteResult"]["status"]) => {
		setEditing(false);
		await queryClient.invalidateQueries({ queryKey: ["market-events"] });
		navigate(`/market-events/${id}`, { state: { marketEventNotice: status === "duplicate" ? "已存在相同事件，展示原版本。新材料尚未附加，请修订原事件。" : "事件已保存。" } });
	};
	if (eventId) return <div className="p-6 space-y-4">
		<Link className="underline text-sm" to="/market-events">返回市场与竞品事件</Link>
		{notice && <p role="status">{notice}</p>}
		{detail.isLoading && <p>正在读取事件…</p>}{detail.error && <p role="alert">{detail.error.message}</p>}
		{detail.data && <><h1 className="text-2xl font-bold">{detail.data.current.input.title}</h1><Summary version={detail.data.current} />
			<Button variant="outline" onClick={() => setEditing(!editing)}>{editing ? "取消编辑" : "修订事件 / 补充转载"}</Button>
			{editing && <EventForm key={detail.data.current.id} current={detail.data.current} saved={(id, status) => { void saved(id, status); }} />}
			<h2 className="font-semibold">修订与旧依据</h2>{detail.data.versions.slice(1).map(v => <details key={v.id} className="rounded-md border p-4"><summary>修订 v{v.version} · {v.changeReason}</summary><Summary version={v} /></details>)}
		</>}
	</div>;
	return <div className="p-6 space-y-4"><div className="flex items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">市场与竞品事件</h1><p className="text-sm text-muted-foreground">保留原文、未知字段与个人关联。几条材料不能证明整体趋势或成本变化原因。</p></div><Button onClick={() => setEditing(!editing)}>{editing ? "收起录入" : "录入事件"}</Button></div>
		{editing && <EventForm key={leadDraftState?.key ?? "manual"} prefill={leadDraftState ? leadDraft(leadDraftState.lead) : undefined} saved={(id, status) => { setLeadDraftState(null); void saved(id, status); }} />}
		{leads.error && <p role="alert">{leads.error.message}</p>}
		{leads.data && leads.data.leads.length > 0 && <Card>
			<CardHeader><CardTitle>来源线索（{leads.data.leads.length}）</CardTitle></CardHeader>
			<CardContent className="space-y-2 text-sm">
				<p className="text-xs text-muted-foreground">
					下面是官网列表页的标题和原文链接，还没有读正文。想看完整内容请点标题去原文；要变成可推送的事件，
					点「转事件」并由你补上时间、适用条件和原文引用。
				</p>
				{feedStatus.data && feedStatus.data.length > 0 ? <ul className="space-y-1 text-xs text-muted-foreground">
					{feedStatus.data.map((feed) => <li key={feed.key}>
						{feed.status === "stopped"
							? `${feed.label}：已停止采集，需要人工恢复`
							: `${feed.label}：${feed.lastRun ? `最近一次采集在 ${formatBeijing(feed.lastRun)}` : "还没有采集记录"}，${feed.lastOutcome ? outcomeLabel(feed.lastOutcome) : "暂无结果"}，现有 ${feed.activeItems} 条`}
					</li>)}
				</ul> : null}
				{feedStatus.error ? <p role="alert" className="text-xs text-red-600">读取来源状态失败，不影响线索列表。</p> : null}
				<ul className="space-y-2">
					{leads.data.leads.map((lead) => <li key={lead.itemId} className="rounded-md border p-3">
						<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
							<div className="min-w-0 space-y-1">
								<a className="block font-medium underline break-all" href={lead.url} target="_blank" rel="noreferrer">{lead.title}</a>
								<p className="text-xs text-muted-foreground">
									来自 {lead.sourceLabel} · 关联{lead.subject.kind === "brand" ? "品牌" : "竞品"}：{lead.subject.name}
									{" · "}发布 {formatLeadDate(lead.publishedAt)}
									{" · "}最近出现 {formatBeijing(lead.lastSeenAt)}
								</p>
							</div>
							<div className="sm:justify-self-end">
								{lead.convertedEventId
									? <Link className="text-sm underline" to={`/market-events/${lead.convertedEventId}`}>已录入，查看事件</Link>
									: <Button variant="outline" onClick={() => { setLeadDraftState({ lead, key: lead.itemId }); setEditing(true); }}>转事件</Button>}
							</div>
						</div>
					</li>)}
				</ul>
				<p className="text-xs text-muted-foreground">
					关联是按站点归属的：潍柴官网的条目归到潍柴、海尔官网的归到海尔，不会因为标题里出现某个名字就自动关联。
				</p>
			</CardContent>
		</Card>}
		{leads.data && leads.data.leads.length === 0 && leads.data.sources.every((item) => !item.enabled) && <p className="text-xs text-muted-foreground">尚未开启自动来源；可在订阅页开启潍柴/海尔的受限列表线索。</p>}
		{list.isLoading && <p>正在读取事件…</p>}{list.error && <p role="alert">{list.error.message}</p>}
		{list.data?.length === 0 && <p className="rounded-md border border-dashed p-6">还没有录入事件。可先保存链接，缺失信息保持未知。</p>}
		<div className="grid gap-4 md:grid-cols-2">{list.data?.map(v => <Link key={v.eventId} to={`/market-events/${v.eventId}`}><Card><CardHeader><CardTitle>{v.input.provenance.simulated ? "【模拟】" : ""}{v.input.title}</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p>{v.input.subject.name} · {types[v.input.type]} · v{v.version}</p><p>{v.candidate.status === "evidence_ready" ? "引用齐备 · 待来源核验" : "证据不足"}</p><p>{v.input.taskRefs.length ? `关联 ${v.input.taskRefs.length} 个本人任务` : "任务关联未确定"}</p></CardContent></Card></Link>)}</div>
	</div>;
}
