import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { consoleClient } from "../../../adpulse-client";
import type { components } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import { formatBeijingTime } from "./task-form.js";

export type TaskDeletion = components["schemas"]["TaskDeletion"];

/**
 * 本人确认删除的任务入口（#40 PR2）。
 * 只提交一次确认；服务端在同一事务内限访并抑制待发，界面不把 200 当作清理完成。
 */
export function TaskDeletionAction({
	taskId,
	onDeleted,
}: {
	taskId: string;
	onDeleted: (view: TaskDeletion) => void;
}) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState("");
	const remove = useMutation({
		mutationFn: async () => {
			const result = await consoleClient.POST("/api/tasks/{taskId}/deletion", {
				params: { path: { taskId } },
			});
			if (!result.data)
				throw new Error(
					result.response.status === 404
						? "任务不存在或已不属于你"
						: "确认删除失败，请稍后重试",
				);
			return result.data;
		},
		onSuccess: async (view) => {
			setError("");
			await queryClient.invalidateQueries({ queryKey: ["tasks"] });
			onDeleted(view);
		},
		onError: (cause) => setError(String(cause)),
	});

	if (!confirming) {
		return (
			<Button
				type="button"
				variant="ghost"
				className="text-destructive hover:text-destructive"
				onClick={() => {
					setError("");
					setConfirming(true);
				}}
			>
				删除任务
			</Button>
		);
	}

	return (
		<div role="group" aria-label="确认删除任务" className="w-full space-y-2 rounded-lg border border-destructive/40 p-3">
			<p className="text-sm">
				确认删除后任务立即不可访问，相关提醒不再发送；在线资料最迟 7 天完成清理，期间无法自行恢复。
			</p>
			{error ? (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="destructive"
					disabled={remove.isPending}
					onClick={() => remove.mutate()}
				>
					{remove.isPending ? "正在确认…" : "确认删除"}
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={remove.isPending}
					onClick={() => setConfirming(false)}
				>
					取消
				</Button>
			</div>
		</div>
	);
}

/** 删除确认后的可见状态：只声明已限访与清理上限，不声称已完成清理。 */
export function TaskDeletionNotice({ view }: { view: TaskDeletion }) {
	return (
		<div role="status" className="space-y-2 rounded-xl border bg-card p-4 text-sm">
			<p className="font-medium">已确认删除，任务现在不可访问</p>
			<p className="text-muted-foreground">
				确认时间：{formatBeijingTime(view.requestedAt)}（北京时间）；在线资料最迟{" "}
				{formatBeijingTime(view.cleanupDueAt)} 完成清理，旧备份最迟在确认后 37 天淘汰。
			</p>
			<p className="text-muted-foreground">
				已抑制：待发信息 {view.suppressed.items} 条、批次 {view.suppressed.batches} 个、
				投递 {view.suppressed.deliveries} 个、任务 {view.suppressed.jobs} 个。
			</p>
		</div>
	);
}
