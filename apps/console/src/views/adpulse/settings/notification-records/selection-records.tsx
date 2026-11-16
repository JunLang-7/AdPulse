import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { consoleClient, type components } from "../../../../adpulse-client";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { formatBeijing } from "./record-view";

type Record = components["schemas"]["NotificationSelectionRecord"];
const reasons: { [K in Record["reason"]]: string } = {
	matched: "命中本人任务的效果排查订阅，已入队",
	push_disabled: "当时未开启主动推送",
	before_enabled: "该输入产生于本次开启之前，不补发旧内容",
	no_target: "当时未关注该任务",
	target_muted: "当时已退订该任务",
	category_excluded: "当时未订阅该任务的效果排查类别",
	not_authorized: "当时的身份、单聊地址或通知授权条件未满足",
	duplicate: "同一逻辑告警版本已评估，不重复入队",
	previously_cancelled: "该逻辑通知已取消或过期，不恢复旧队列",
	historical_input: "历史告警仅被重新评估，不补发",
	alert_inactive: "告警已处理、失效或达到轮次上限",
};
const outcomeLabels = { queued: "已入队", not_queued: "未入队", duplicate: "重复抑制", cancelled: "取消终态" };
type Filters = { taskId: string; dateFrom: string; dateTo: string; outcome: Record["outcome"] | "" };
const empty: Filters = { taskId: "", dateFrom: "", dateTo: "", outcome: "" };

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
	const all = records.data?.pages.flatMap((page) => page.records) ?? [];
	return <div className="p-6 space-y-4 max-w-4xl">
		<h1 className="text-2xl font-bold">筛选记录</h1>
		<p className="text-sm text-muted-foreground">仅记录效果告警当时的筛选判断；之后修改订阅不会改写历史。已入队不等于已发送，发送结果请查看「汇总与投递」。</p>
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
		{records.isLoading ? <p>正在读取筛选记录…</p> : records.isError ? <div role="alert"><p>{records.error.message}</p><button type="button" className="underline" onClick={() => void records.refetch()}>重试读取筛选记录</button></div> : all.length === 0 ? <p>暂无筛选记录。仅接入后新评估的效果告警会留痕；未记录的历史原因无法还原。</p> : all.map((record) => <Card key={record.id}>
			<CardHeader><CardTitle>{outcomeLabels[record.outcome]} · 效果告警</CardTitle><p className="text-xs text-muted-foreground">{formatBeijing(record.evaluatedAt)} · 当时设置 v{record.settingsVersion} · 通知版本 {record.revision}</p></CardHeader>
			<CardContent className="text-sm space-y-2">
				<p>{reasons[record.reason]}</p>
				<details><summary className="cursor-pointer">查看当时依据</summary><div className="mt-2 space-y-1 break-all">
					<p>关联本人任务：<a className="underline" href={`/tasks/${encodeURIComponent(record.taskId)}`}>{record.taskId}</a></p>
					<p>告警引用：{record.alertId}</p><p>比较引用：{record.comparisonResultId}</p>
					<p>证据引用：{record.evidenceRef.evidenceId} v{record.evidenceRef.version}</p>
					<p>当时命中的关注项：{record.matchedTargetIds.join("、") || "无"}</p>
				</div></details>
			</CardContent>
		</Card>)}
		{records.hasNextPage ? <button type="button" className="underline text-sm" disabled={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>加载更早的筛选记录</button> : null}
	</div>;
}
