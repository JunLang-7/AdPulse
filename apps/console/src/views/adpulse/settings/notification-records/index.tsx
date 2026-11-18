import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { consoleClient, type components } from "../../../../adpulse-client";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { Separator } from "../../../../components/ui/separator";
import { describeReadiness } from "../subscriptions/subscription-view";
import { describeRecord, formatBeijing, knownNotificationReason, needsNotificationSettings } from "./record-view";
import SelectionRecords from "./selection-records";

type NotificationRecord = components["schemas"]["NotificationRecord"];

const statusLabels: { [K in NotificationRecord["status"]]: string } = {
	queued: "待汇总",
	sent: "已发送",
	failed: "发送失败",
	cancelled: "已取消",
	expired: "已过期",
	suppressed: "未发送",
};

const settingsUrl = "/settings/notifications";

function statusLabel(record: NotificationRecord): string {
	return record.delivery?.status === "sent" && record.status === "sent" ? "平台已接收" : statusLabels[record.status];
}

export default function NotificationRecordsPage() {
	const [lookupOpen, setLookupOpen] = useState(false);
	const [status, setStatus] = useState("");
	const records = useInfiniteQuery({
		queryKey: ["notification-records"],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const result = await consoleClient.GET("/api/me/notifications", {
				params: { query: pageParam ? { before: pageParam } : {} },
			});
			if (!result.data) {
				throw new Error(result.response.status === 401 ? "登录已过期，请重新登录。" : "读取通知记录失败，请重试。");
			}
			return result.data;
		},
		getNextPageParam: (page) => page.nextBefore ?? undefined,
	});
	const subscription = useQuery({
		queryKey: ["subscription"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/me/subscription");
			if (!result.data) throw new Error("读取订阅设置失败");
			return result.data;
		},
	});
	const notification = useQuery({
		queryKey: ["notification-status"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/me/notification-status");
			if (!result.data) throw new Error("读取通知设置失败");
			return result.data;
		},
	});

	const all = records.data?.pages.flatMap((page) => page.records) ?? [];
	const next = all.filter((record) => record.status === "queued" &&
		record.items.some((item) => !item.status || item.status === "queued"))
		.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
	const history = all.filter((record) => record.status !== "queued" && (!status || status === record.status));
	const readiness = subscription.data && notification.data
		? describeReadiness(subscription.data, notification.data)
		: null;

	return (
		<div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
			<Card role="region" aria-labelledby="notice-title" className="gap-3 border border-border">
				<CardHeader>
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div className="space-y-1">
							<h1 id="notice-title" className="text-2xl font-bold">通知记录</h1>
							<p className="text-sm text-muted-foreground">查看下一次汇总和飞书发送结果。</p>
						</div>
						<Button type="button" variant={lookupOpen ? "outline" : "default"} aria-expanded={lookupOpen}
							aria-controls="notification-lookup" onClick={() => setLookupOpen(!lookupOpen)}>
							{lookupOpen ? "收起排查" : "没收到通知？"}
						</Button>
					</div>
				</CardHeader>
				<div id="notification-lookup" hidden={!lookupOpen}>
					{lookupOpen ? <><Separator className="h-px w-full" /><SelectionRecords /></> : null}
				</div>
				<Separator className="h-px w-full" />
				<CardContent className="space-y-3">
					<h2 className="font-semibold">下一次汇总</h2>
					{records.isPending ? <p className="text-sm text-muted-foreground">正在读取汇总…</p>
						: records.isError && !records.data ? <p className="text-sm text-muted-foreground">暂时无法确认待汇总提醒。</p>
						: next ? <DigestRow record={next} upcoming />
						: <p className="text-sm text-muted-foreground">暂无待汇总的提醒。</p>}
					{readiness && !readiness.canDeliver ? (
						<div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
							<p className="text-muted-foreground">{readiness.detail}</p>
							<a href={settingsUrl} className="underline underline-offset-4">查看通知设置</a>
						</div>
					) : null}
				</CardContent>
				<Separator className="h-px w-full" />
				<CardContent className="space-y-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h2 className="font-semibold">发送历史</h2>
						<label className="flex items-center gap-2 text-sm">发送状态
							<select className="h-8 rounded-md border border-input bg-background px-2" value={status}
								onChange={(event) => setStatus(event.target.value)}>
								<option value="">全部</option>
								{Object.entries(statusLabels).filter(([value]) => value !== "queued").map(([value, label]) =>
									<option key={value} value={value}>{label}</option>)}
							</select>
						</label>
					</div>
					{records.isPending ? <p role="status" className="text-sm text-muted-foreground">正在读取发送历史…</p> : null}
					{records.isError ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
						<p>{records.error.message}</p>
						<Button type="button" size="sm" variant="outline" onClick={() => void records.refetch()}>重试</Button>
					</div> : null}
					{history.length > 0 ? (
						<div className="divide-y divide-border">{history.map((record) => <DigestRow key={record.id} record={record} />)}</div>
					) : records.isSuccess ? (
						<p className="text-sm text-muted-foreground">
							{status || records.hasNextPage ? "已加载的历史里没有符合条件的通知。" : "暂无发送历史。有可发送的新提醒时才会生成汇总。"}
						</p>
					) : null}
					{records.hasNextPage ? (
						<Button type="button" variant="outline" size="sm" disabled={records.isFetchingNextPage}
							onClick={() => void records.fetchNextPage()}>
							{records.isFetchingNextPage ? "正在加载…" : "加载更早的记录"}
						</Button>
					) : null}
				</CardContent>
			</Card>
		</div>
	);
}

function DigestRow({ record, upcoming = false }: { record: NotificationRecord; upcoming?: boolean }) {
	const view = describeRecord(record);
	const items = upcoming ? record.items.filter((item) => !item.status || item.status === "queued") : record.items;
	const reason = knownNotificationReason(record.statusReason);
	const time = record.status === "sent" && record.sentAt ? record.sentAt : record.scheduledAt;

	return (
		<article className="space-y-2 py-3" data-testid="notification-record">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<CardTitle>{upcoming ? `计划 ${formatBeijing(time)}（北京时间）` : view.title}</CardTitle>
				<Badge variant={record.status === "failed" ? "destructive" : record.status === "sent" ? "secondary" : "outline"}>
					{statusLabel(record)}
				</Badge>
			</div>
			{upcoming ? null : <p className="text-xs text-muted-foreground">{formatBeijing(time)}（北京时间）</p>}
			{reason || (record.status !== "sent" && record.status !== "queued") ? (
				<p className="text-sm text-muted-foreground" data-testid="notification-record-reason">
					{reason?.label ?? "没有记录具体原因。"}
				</p>
			) : null}
			{needsNotificationSettings(record.statusReason) ? (
				<a className="text-sm underline underline-offset-4" href={settingsUrl}>检查飞书连接和通知设置</a>
			) : null}
			{record.status === "sent" ? (
				<p className="text-xs text-muted-foreground" data-testid="notification-record-items-note">
					{record.itemsSource === "delivery" ? "显示发送时的内容。" : "显示当前条目。发送时的内容未保存。"}
				</p>
			) : null}
			{items.length ? <ul className="divide-y divide-border text-sm">
				{items.map((item, index) => (
					<li key={item.id ?? index} className="space-y-1 py-2">
						{item.inputExpired ? <p className="text-xs text-amber-700">
							{item.inputRemoved === "deleted" ? "来源事件已被删除，标题与来源不再展示。" : "来源事件已过保留期，标题与来源不再展示。"}
						</p> : null}
						<div className="flex flex-wrap items-start justify-between gap-2">
							<p className="font-medium break-words">{item.title}</p>
							{item.taskId ? <a className="underline underline-offset-4" href={`/tasks/${encodeURIComponent(item.taskId)}/review`}>查看推广效果</a> : null}
						</div>
						{item.status === "cancelled" || item.status === "expired" ? (
							<p className="text-xs text-muted-foreground">{statusLabels[item.status]}</p>
						) : null}
						<details>
							<summary className="cursor-pointer text-muted-foreground">查看提醒详情</summary>
							<div className="space-y-1 pt-2">
								<p>{item.summary}</p>
								<p className="text-muted-foreground">{item.relevance}</p>
								{item.sources.filter((source) => source.url && /^https?:\/\//i.test(source.url)).map((source) => (
									<a key={source.url} className="block underline underline-offset-4" href={source.url}
										target="_blank" rel="noreferrer noopener">{source.label}</a>
								))}
							</div>
						</details>
					</li>
				))}
			</ul> : null}
		</article>
	);
}
