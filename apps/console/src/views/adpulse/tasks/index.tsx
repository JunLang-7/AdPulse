import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { consoleClient } from "../../../adpulse-client";
import { Badge } from "../../../components/ui/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";

import { formatBeijingTime } from "./task-form.js";

/** 「11月17日 19:38」这种最短可读写法；毫秒对用户没有意义。 */
function formatShort(value: string): string {
	const [date, time] = formatBeijingTime(value).replace("（北京时间）", "").split(" ");
	if (!date || !time) return date ?? value;
	const [, month, day] = date.split("-");
	return `${Number(month)}月${Number(day)}日 ${time.slice(0, 5)}`;
}

/** 删除清单（#40）：任务内容已删除，这里只留「请求已受理、什么时候清完」的回执。 */
function DeletionStatus() {
	const deletions = useQuery({
		queryKey: ["lifecycle-deletions"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/me/lifecycle-deletions");
			if (!result.data) throw new Error("无法读取删除状态");
			return result.data.items;
		},
	});
	if (deletions.isError) return <p role="alert" className="text-sm text-red-600">读取删除状态失败，请刷新重试。</p>;
	if (!deletions.data || deletions.data.length === 0) return null;
	const pending = deletions.data.filter((row) => row.status !== "cleaned").length;
	return (
		<Card>
			<CardHeader><CardTitle>删除进度</CardTitle></CardHeader>
			<CardContent className="space-y-2 text-sm">
				<p className="text-xs text-muted-foreground">
					{pending > 0
						? `已收到 ${deletions.data.length} 个删除请求，最迟 7 天内清理完成（剩下 ${pending} 个在排队）。清理后任务内容不再保留，这里只留一条记录。`
						: `${deletions.data.length} 个删除请求都已清理完成，任务内容不再保留。`}
				</p>
				<ul className="space-y-2">
					{deletions.data.map((row, index) => (
						<li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border p-2">
							<span className="text-muted-foreground">已删除的任务{deletions.data.length > 1 ? ` ${index + 1}` : ""}</span>
							<span className={row.status === "cleaned" ? "text-muted-foreground" : "text-amber-700"}>
								{row.status === "cleaned" ? "已清理" : "等待清理"}
							</span>
							<span className="text-xs text-muted-foreground">
								{row.cleanedAt
									? `${formatShort(row.cleanedAt)} 清理完成`
									: `请求于 ${formatShort(row.requestedAt)} · 最迟 ${formatShort(row.deadlineAt)} 清理完成`}
							</span>
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}

export default function TasksPage() {
	const locationState: unknown = useLocation().state;
	const notice = locationState && typeof locationState === "object" && "taskNotice" in locationState && typeof locationState.taskNotice === "string" ? locationState.taskNotice : null;
	const { data, isLoading, error } = useQuery({
		queryKey: ["tasks"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/tasks");
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data.items;
		},
	});

	if (isLoading) return <div className="p-6">正在加载推广任务…</div>;
	if (error)
		return <div className="p-6 text-red-600">读取任务失败：{String(error)}</div>;

	return (
		<div className="p-6 space-y-4">
			<div className="flex items-baseline justify-between gap-3">
				<div>
					<h1 className="text-2xl font-bold">推广任务</h1>
					<p className="text-sm text-muted-foreground">
						保存推广目标与已确认配置；未填写的预算、阈值等保持未知。
					</p>
				</div>
				<Link
					to="/tasks/new"
					className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
				>
					新建任务
				</Link>
			</div>

			{notice ? <p role="status" className="rounded-md border p-3 text-sm">{notice}</p> : null}

			{data?.length === 0 ? (
				<p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
					还没有推广任务。创建任务时可以先留空未确认的预算、出价和规则。
				</p>
			) : null}

			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
				{data?.map((task) => (
					<Link key={task.taskId} to={`/tasks/${task.taskId}`}>
						<Card className="h-full transition hover:ring-foreground/25">
							<CardHeader>
								<div className="flex items-start justify-between gap-2">
									<CardTitle className="line-clamp-2">{task.product}</CardTitle>
									<Badge variant="outline">第 {task.version} 版</Badge>
								</div>
							</CardHeader>
							<CardContent className="space-y-2">
								<p className="whitespace-pre-line text-sm">{task.strategy.objective || "目标待补充"}</p>
								<p className="text-sm text-muted-foreground line-clamp-2">
									{task.strategy.audience.length
									? task.strategy.audience.join("、")
									: "受众待补充"}
								</p>
								<p className="text-xs text-muted-foreground">
									更新于 {formatBeijingTime(task.createdAt)}
								</p>
							</CardContent>
						</Card>
					</Link>
				))}
			</div>

			<DeletionStatus />
		</div>
	);
}
