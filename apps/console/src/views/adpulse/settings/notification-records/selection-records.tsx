import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { consoleClient, type components } from "../../../../adpulse-client";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { CardContent } from "../../../../components/ui/card";
import { Input } from "../../../../components/ui/input";
import { formatBeijing, knownNotificationReason, needsNotificationSettings } from "./record-view";

type Selection = components["schemas"]["NotificationSelectionRecord"];
const reasons: { [K in Selection["reason"]]: string } = {
	matched: "符合你当时的关注和通知设置。",
	push_disabled: "当时未开启通知。",
	before_enabled: "这条提醒产生于你开启通知之前。",
	no_target: "你当时还没有关注相关任务或对象。",
	target_muted: "你当时暂停了相关任务或对象的通知。",
	category_excluded: "你的订阅当时没有包含这类提醒。",
	not_authorized: "当时的飞书收件设置或接收授权尚未生效。",
	duplicate: "同一条提醒已处理过。",
	previously_cancelled: "这条提醒之前已经取消或过期。",
	historical_input: "这条旧提醒重新检查过，历史提醒不会补发。",
	alert_inactive: "提醒已处理、失效或达到提醒次数上限。",
	insufficient_evidence: "事件证据不齐备（缺官方原文引用、事件时间或适用条件），不作为可推送信息",
	simulated_input: "合成样例只用于测试，不进入真实推送",
	no_association: "事件没有明确标注你关注的主体或关联任务",
	scope_excluded: "你当时选择了「只看任务」，这条事件超出订阅范围。",
};
const outcomeLabels = { queued: "已安排汇总", not_queued: "未安排发送", duplicate: "已去重", cancelled: "已取消" };
type Filters = { taskId: string; dateFrom: string; dateTo: string; outcome: Selection["outcome"] | "" };
const empty: Filters = { taskId: "", dateFrom: "", dateTo: "", outcome: "" };

function explainSelection(record: Selection): { label: string; reason: string } {
	const delivery = record.deliveryResult;
	if (record.outcome !== "queued") return { label: outcomeLabels[record.outcome], reason: reasons[record.reason] };
	switch (delivery?.status) {
		case "queued":
			return { label: "待汇总", reason: `计划 ${formatBeijing(delivery.scheduledAt)} 汇总（北京时间）。` };
		case "failed":
			return { label: "发送失败", reason: knownNotificationReason(delivery.statusReason)?.label ?? "这条提醒发送失败，未记录具体原因。" };
		case "cancelled":
		case "expired":
		case "suppressed":
			return {
				label: delivery.status === "cancelled" ? "已取消" : delivery.status === "expired" ? "已过期" : "未发送",
				reason: knownNotificationReason(delivery.statusReason)?.label ?? "没有记录具体原因。",
			};
		default:
			return { label: "已安排过汇总", reason: "当时符合发送条件。暂无可核实的发送结果。" };
	}
}

export default function SelectionRecords() {
	const [draft, setDraft] = useState(empty);
	const [filters, setFilters] = useState(empty);
	const tasks = useQuery({ queryKey: ["tasks"], queryFn: async () => {
		const result = await consoleClient.GET("/api/tasks");
		if (!result.data) throw new Error("无法读取本人任务");
		return result.data.items;
	} });
	const records = useInfiniteQuery({
		queryKey: ["notification-selections", filters], initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const result = await consoleClient.GET("/api/me/notification-selections", { params: { query: {
				...(filters.taskId ? { taskId: filters.taskId } : {}),
				...(filters.dateFrom ? { dateFrom: filters.dateFrom } : {}),
				...(filters.dateTo ? { dateTo: filters.dateTo } : {}),
				...(filters.outcome ? { outcome: filters.outcome } : {}),
				...(pageParam ? { before: pageParam } : {}),
			} } });
			if (!result.data) throw new Error(result.response.status === 400 ? "查询条件无效，请检查日期范围。" : "读取筛选记录失败，请重试。");
			return result.data;
		}, getNextPageParam: (page) => page.nextBefore ?? undefined,
	});
	const all = (records.data?.pages.flatMap((page) => page.records) ?? [])
		.filter((record) => record.deliveryResult?.status !== "sent");
	const events = useQuery({
		queryKey: ["market-events"], enabled: all.some((record) => record.marketEventRef),
		queryFn: async () => {
			const result = await consoleClient.GET("/api/market-events");
			if (!result.data) throw new Error("无法读取事件列表");
			return result.data.items;
		},
	});
	const taskNames = new Map(tasks.data?.map((task) => [task.taskId, task.product]));
	const eventNames = new Map(events.data?.map((event) => [event.eventId, event.input.title]));
	return <CardContent className="space-y-3">
		<div className="space-y-1">
			<h2 className="font-semibold">没收到通知？</h2>
			<p className="text-sm text-muted-foreground">查找还在等汇总、没有安排或发送失败的提醒。</p>
		</div>
		<form className="space-y-2" onSubmit={(event) => { event.preventDefault(); setFilters({ ...draft }); }}>
			<div className="flex flex-wrap items-end gap-2">
				<label className="space-y-1 text-sm">
					<span>按任务查找</span>
					<select aria-label="筛选任务" className="block h-8 rounded-md border border-input bg-background px-2"
						value={draft.taskId} onChange={(event) => setDraft({ ...draft, taskId: event.target.value })}>
						<option value="">全部本人任务</option>
						{tasks.data?.map((task) => <option key={task.taskId} value={task.taskId}>{task.product}</option>)}
					</select>
				</label>
				<Button type="submit" variant="outline" size="sm">查询</Button>
			</div>
			<details className="text-sm">
				<summary className="cursor-pointer text-muted-foreground">按日期或结果筛选</summary>
				<div className="mt-2 flex flex-wrap items-end gap-2">
					{(["dateFrom", "dateTo"] as const).map((key) => {
						const label = key === "dateFrom" ? "开始日期" : "结束日期";
						return <label key={key} className="space-y-1 text-sm">
							<span>{label}（北京时间）</span>
							<Input className="block" aria-label={label} type="date" value={draft[key]}
								onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
						</label>;
					})}
					<label className="space-y-1 text-sm">
						<span>结果</span>
						<select className="block h-8 rounded-md border border-input bg-background px-2" aria-label="筛选结果"
							value={draft.outcome} onChange={(event) => {
								const value = event.target.value;
								if (value === "" || value === "queued" || value === "not_queued" || value === "duplicate" || value === "cancelled")
									setDraft({ ...draft, outcome: value });
							}}>
							<option value="">全部结果</option>
							{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
						</select>
					</label>
				</div>
			</details>
		</form>
		{tasks.isError ? <p role="alert">无法读取本人任务，请刷新重试。</p> : null}
		{records.isLoading ? <p className="text-sm text-muted-foreground">正在查询提醒…</p>
			: records.isError ? <div role="alert" className="space-y-2 text-sm"><p>{records.error.message}</p><Button type="button" variant="outline" size="sm" onClick={() => void records.refetch()}>重试查询</Button></div>
			: all.length === 0 ? <p className="text-sm text-muted-foreground">{records.hasNextPage ? "已查询的记录里没有符合条件的提醒。" : "没有可查的未发送提醒。"}</p>
			: <div className="divide-y divide-border">{all.map((record) => {
			const isEvent = record.input === "event";
			const eventId = record.marketEventRef?.eventId;
			const taskName = record.taskId ? taskNames.get(record.taskId) : undefined;
			const category = isEvent ? "市场与竞品事件" : "推广效果提醒";
			const name = isEvent ? (eventId ? eventNames.get(eventId) : undefined) : taskName;
			const result = explainSelection(record);
			return <article key={record.id} className="space-y-2 py-3">
					<div className="flex flex-wrap items-start justify-between gap-2">
						<h3 className="break-words text-sm font-medium">{name || category}</h3>
						<Badge variant={record.deliveryResult?.status === "failed" ? "destructive" : "outline"}>{result.label}</Badge>
					</div>
					<p className="text-xs text-muted-foreground">{name ? category + " · " : ""}{formatBeijing(record.evaluatedAt)}</p>
					<p className="text-sm">{result.reason}</p>
					<div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
						{needsNotificationSettings(record.deliveryResult?.statusReason ?? record.reason) ? (
							<a className="underline" href="/settings/notifications">检查飞书连接和通知设置</a>
						) : null}
						{eventId ? <a className="underline" href={`/market-events/${encodeURIComponent(eventId)}`}>查看事件</a> : null}
						{record.taskId ? <a className="underline" href={`/tasks/${encodeURIComponent(record.taskId)}/review`}>
							{isEvent && taskName ? `查看关联任务「${taskName}」` : "查看推广效果"}
						</a> : null}
					</div>
			</article>;
		})}</div>}
		{records.hasNextPage ? <Button type="button" variant="outline" size="sm" disabled={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>加载更早的排查记录</Button> : null}
	</CardContent>;
}
