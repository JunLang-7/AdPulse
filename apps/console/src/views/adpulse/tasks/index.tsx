import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { consoleClient } from "../../../adpulse-client";
import { Badge } from "../../../components/ui/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";

import { formatBeijingTime } from "./task-form.js";

export default function TasksPage() {
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
