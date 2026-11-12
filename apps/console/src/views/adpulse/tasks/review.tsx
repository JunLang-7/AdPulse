import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link, useParams } from "react-router";
import { consoleClient } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import { EvidencePanel } from "./evidence-panel";
import { formatBeijingTime } from "./task-form.js";

export default function TaskReviewPage() {
	const { taskId = "" } = useParams();
	const detail = useQuery({
		queryKey: ["task", taskId],
		enabled: Boolean(taskId),
		retry: false,
		queryFn: async ({ signal }) => {
			const result = await consoleClient.GET("/api/tasks/{taskId}", {
				params: { path: { taskId } },
				signal,
			});
			if (!result.data) throw new Error("无法读取推广任务");
			return result.data;
		},
	});

	if (!detail.data) {
		return (
			<div className="mx-auto max-w-5xl space-y-3 p-4 sm:p-6">
				<Link to="/tasks" className="text-sm text-muted-foreground hover:text-foreground">
					← 返回推广任务
				</Link>
				<h1 className="text-2xl font-bold tracking-tight">推广效果复盘</h1>
				{detail.isLoading ? (
					<p role="status" className="text-sm text-muted-foreground">正在读取推广任务…</p>
				) : (
					<>
						<p role="alert" className="text-sm text-destructive">无法读取推广任务，请核对任务链接后重试。</p>
						<Button type="button" variant="outline" onClick={() => void detail.refetch()}>重新读取</Button>
					</>
				)}
			</div>
		);
	}

	const { task, versions } = detail.data;
	return (
		<div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
			<header className="space-y-2">
				<Link to={`/tasks/${task.taskId}`} className="text-sm text-muted-foreground hover:text-foreground">
					← 返回编辑任务
				</Link>
				<h1 className="text-2xl font-bold tracking-tight">推广效果复盘</h1>
				<p className="font-medium">{task.product}</p>
			</header>

			<EvidencePanel key={task.taskId} taskId={task.taskId} taskVersion={task.version} />

			<details className="group rounded-xl border bg-card">
				<summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm marker:hidden">
					<ChevronRight aria-hidden="true" className="size-4 shrink-0 group-open:rotate-90" />
					<span className="font-medium">任务修改记录</span>
					<span className="ml-auto text-xs text-muted-foreground">{versions.length} 个版本</span>
				</summary>
				<ul className="space-y-1 px-4 pb-4 text-sm text-muted-foreground">
					{versions.map((version) => (
						<li key={version.id}>第 {version.version} 版 · {formatBeijingTime(version.createdAt)}</li>
					))}
				</ul>
			</details>
		</div>
	);
}
