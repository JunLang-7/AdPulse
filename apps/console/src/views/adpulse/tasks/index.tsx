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

/** 删除清单的清理进度（#40）：只展示状态与时间，不展示业务正文。 */
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
	return (
		<Card>
			<CardHeader><CardTitle>删除与清理状态</CardTitle></CardHeader>
			<CardContent className="space-y-2 text-sm">
				<p className="text-xs text-muted-foreground">
					删除请求起 7 天内完成在线清理；清理完成后这条记录保留为状态，不含任务内容。
				</p>
				<ul className="space-y-2">
					{deletions.data.map((row) => (
						<li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border p-2">
							<span className="break-all">任务 {row.taskId.slice(0, 8)}…</span>
							<span className={(row.status === "cleaned" ? "text-muted-foreground" : "text-amber-700")}>
								{row.status === "cleaned" ? "已清理" : "等待清理"}
							</span>
							<span className="text-xs text-muted-foreground">
								请求 {formatBeijingTime(row.requestedAt)} · 截止 {formatBeijingTime(row.deadlineAt)}
								{row.cleanedAt ? ` · 完成 ${formatBeijingTime(row.cleanedAt)}` : ""}
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

			<DeletionStatus />

			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
				{data?.map((task) => (
					<Link key={task.taskId} to={`/tasks/${task.taskId}`}>
						<Card className="h-full transition hover:ring-foreground/25">
							<CardHeader>
								<div className="flex items-start justify-between gap-2">
									<CardTitle className="line-clamp-2">{task.product}</CardTitle>
									<Badge variant="outline">v{task.version}</Badge>
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
		</div>
	);
}
