import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { consoleClient, type components } from "../../../../adpulse-client";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { formatBeijing } from "./record-view";

type Record = components["schemas"]["NotificationSelectionRecord"];
const reasons: { [K in Record["reason"]]: string } = {
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
type Filters = { taskId: string; dateFrom: string; dateTo: string; outcome: Record["outcome"] | "" };
const empty: Filters = { taskId: "", dateFrom: "", dateTo: "", outcome: "" };

export default function SelectionRecords({ onViewDelivery }: { onViewDelivery: () => void }) {
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
	const all = records.data?.pages.flatMap((page) => page.records) ?? [];
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
	return <div className="p-6 space-y-4 max-w-4xl">
		<div className="flex flex-wrap items-start justify-between gap-3">
			<div className="space-y-1">
				<h1 className="text-2xl font-bold">筛选记录</h1>
				<p className="text-sm text-muted-foreground">查看每条提醒当时为何被安排进汇总，或为何没有安排发送。</p>
			</div>
			<Button type="button" variant="outline" onClick={onViewDelivery}>查看实际发送结果</Button>
		</div>
		<form className="flex flex-wrap gap-3 items-end" onSubmit={(event) => { event.preventDefault(); setFilters({ ...draft }); }}>
			<label className="text-sm">任务<select aria-label="筛选任务" className="block rounded-md border p-2" value={draft.taskId} onChange={(event) => setDraft({ ...draft, taskId: event.target.value })}>
				<option value="">全部本人任务</option>
				{tasks.data?.map((task) => <option key={task.taskId} value={task.taskId}>{task.product}</option>)}
			</select></label>
			{(["dateFrom", "dateTo"] as const).map((key) => <label key={key} className="text-sm">{key === "dateFrom" ? "开始日期（北京时间）" : "结束日期（北京时间）"}<input className="block rounded-md border p-2" aria-label={key === "dateFrom" ? "开始日期" : "结束日期"} type="date" value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /></label>)}
			<label className="text-sm">结果<select className="block rounded-md border p-2" aria-label="筛选结果" value={draft.outcome} onChange={(event) => {
				const value = event.target.value;
				if (value === "" || value === "queued" || value === "not_queued" || value === "duplicate" || value === "cancelled") setDraft({ ...draft, outcome: value });
			}}><option value="">全部结果</option>{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
			<button type="submit" className="rounded-md border px-3 py-2 text-sm">查询筛选记录</button>
		</form>
		{tasks.isError ? <p role="alert">无法读取本人任务，请刷新重试。</p> : null}
		{records.isLoading ? <p>正在读取筛选记录…</p> : records.isError ? <div role="alert"><p>{records.error.message}</p><button type="button" className="underline" onClick={() => void records.refetch()}>重试读取筛选记录</button></div> : all.length === 0 ? <p>暂无筛选记录。新评估的效果提醒和市场事件会在这里显示筛选结果。</p> : all.map((record) => {
			const isEvent = record.input === "event";
			const eventId = record.marketEventRef?.eventId;
			const taskName = record.taskId ? taskNames.get(record.taskId) : undefined;
			const category = isEvent ? "市场与竞品事件" : "推广效果提醒";
			const name = isEvent ? (eventId ? eventNames.get(eventId) : undefined) : taskName;
			return <Card key={record.id}>
				<CardHeader>
					<div className="flex flex-wrap items-start justify-between gap-2">
						<CardTitle className="break-words">{name || category}</CardTitle>
						<Badge variant="secondary">{outcomeLabels[record.outcome]}</Badge>
					</div>
					<p className="text-xs text-muted-foreground">{name ? category + " · " : ""}{formatBeijing(record.evaluatedAt)}</p>
				</CardHeader>
				<CardContent className="space-y-2 text-sm">
					<p>{reasons[record.reason]}</p>
					<div className="flex flex-wrap gap-x-4 gap-y-2">
						{eventId ? <a className="underline" href={`/market-events/${encodeURIComponent(eventId)}`}>查看事件</a> : null}
						{record.taskId ? <a className="underline" href={`/tasks/${encodeURIComponent(record.taskId)}/review`}>
							{isEvent && taskName ? `查看关联任务「${taskName}」` : "查看推广效果"}
						</a> : null}
					</div>
				</CardContent>
			</Card>;
		})}
		{records.hasNextPage ? <button type="button" className="underline text-sm" disabled={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>加载更早的筛选记录</button> : null}
	</div>;
}
