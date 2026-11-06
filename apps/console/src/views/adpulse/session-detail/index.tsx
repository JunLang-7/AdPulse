import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, CircleDot } from "lucide-react";
import { Link, useParams } from "react-router";
import { consoleClient } from "../../../adpulse-client";
import { Badge } from "../../../components/ui/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { cn } from "../../../lib/utils";
import { formatTime, isExpired, roundStatus, sessionStatus } from "../status";

export default function SessionDetailPage() {
	const { sessionId = "" } = useParams();

	const { data, isLoading, error } = useQuery({
		queryKey: ["session", sessionId],
		enabled: sessionId.length > 0,
		queryFn: async () => {
			const result = await consoleClient.GET("/api/sessions/{sessionId}", {
				params: { path: { sessionId } },
			});
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data;
		},
	});

	if (isLoading) return <div className="p-6">正在加载会话详情…</div>;
	if (error) return <div className="p-6 text-red-600">{String(error)}</div>;
	if (!data) return <div className="p-6">没有找到该会话。</div>;

	const session = data.session;
	const status = sessionStatus(session.status);
	const expired = isExpired(session.expiresAt);

	return (
		<div className="p-6 space-y-4">
			<Link
				to="/sessions"
				className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
			>
				<ArrowLeft className="size-4" />
				返回会话列表
			</Link>

			<div className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<h1 className="text-2xl font-bold">{session.signal.title}</h1>
					<Badge variant={status.variant} className={status.className}>
						{status.label}
					</Badge>
					{expired ? <Badge variant="destructive">已过期</Badge> : null}
				</div>
				<p className="text-sm text-muted-foreground">
					{session.signal.summary}
				</p>
				<div className="flex flex-wrap items-center gap-1.5">
					<Badge variant="outline">第 {session.roundNo} 轮</Badge>
					<Badge variant="outline">v{session.version} 策略</Badge>
					<Badge variant="outline">
						{session.recipient.kind === "group" ? "群聊" : "单聊"}
					</Badge>
					<Badge variant="outline">到期 {formatTime(session.expiresAt)}</Badge>
					{session.taskRef ? (
						<Link to={`/tasks/${session.taskRef.taskId}`}>
							<Badge variant="outline">任务基线 v{session.taskRef.taskVersion}</Badge>
						</Link>
					) : null}
				</div>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>轮次时间线</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					{data.rounds.length === 0 ? (
						<p className="text-sm text-muted-foreground">还没有生成轮次。</p>
					) : null}
					{data.rounds.map((round) => {
						const candidates = (round.candidates ?? []) as Array<{
							id: string;
							label: string;
						}>;
						const actions = (data.actions ?? []).filter(
							(a) => a.roundId === round.id,
						);
						const state = roundStatus(round.status);
						const isCurrent = round.roundNo === session.roundNo;
						return (
							<div
								key={round.id}
								className="rounded-lg border border-border p-4 space-y-3"
							>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div className="flex items-center gap-2">
										<CircleDot className="size-4 text-muted-foreground" />
										<span className="font-medium">第 {round.roundNo} 轮</span>
										<Badge variant={state.variant} className={state.className}>
											{state.label}
										</Badge>
										{isCurrent ? <Badge variant="secondary">当前</Badge> : null}
									</div>
									<span className="text-xs text-muted-foreground">
										{round.respondedAt
											? `已响应 ${formatTime(round.respondedAt)}`
											: `到期 ${formatTime(round.expiresAt)}`}
									</span>
								</div>

								<div className="space-y-1">
									<p className="text-sm font-medium">{round.card?.title}</p>
									<p className="text-sm text-muted-foreground">
										{round.card?.summary}
									</p>
									{(round.card?.evidence ?? []).length > 0 ? (
										<div className="flex flex-wrap gap-1.5 pt-1">
											{(round.card?.evidence ?? []).map((item) => (
												<Badge key={item.label} variant="outline">
													{item.label}：{item.value}
												</Badge>
											))}
										</div>
									) : null}
								</div>

								<div className="flex flex-wrap gap-2">
									{candidates.map((candidate) => {
										const action = actions.find(
											(a) => a.optionId === candidate.id,
										);
										return (
											<OptionChip
												key={candidate.id}
												label={candidate.label}
												selected={round.selectedOptionId === candidate.id}
												actionRef={
													round.status === "open" && !expired
														? action?.id
														: undefined
												}
											/>
										);
									})}
								</div>
							</div>
						);
					})}
				</CardContent>
			</Card>

			<div className="grid gap-4 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>投递</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm">
						{data.deliveries.length === 0 ? (
							<p className="text-muted-foreground">暂无投递记录。</p>
						) : null}
						{data.deliveries.map((delivery) => (
							<div
								key={delivery.id}
								className="flex items-center justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0"
							>
								<span className="flex items-center gap-2">
									<Badge variant="outline">
										{delivery.purpose === "confirmation" ? "确认卡" : "决策卡"}
									</Badge>
									<Badge variant={deliveryVariant(delivery.status)}>
										{deliveryLabel(delivery.status)}
									</Badge>
								</span>
								<span className="text-xs text-muted-foreground truncate">
									{delivery.sentAt
										? formatTime(delivery.sentAt)
										: delivery.lastError || "—"}
								</span>
							</div>
						))}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>策略快照</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm">
						{data.snapshots.map((snapshot) => (
							<div
								key={snapshot.id}
								className="flex items-center justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0"
							>
								<span>v{snapshot.version}</span>
								<span className="text-xs text-muted-foreground">
									{snapshot.changes.length === 0
										? "无变更"
										: `${snapshot.changes.length} 项变更`}
									{" · "}
									{formatTime(snapshot.createdAt)}
								</span>
							</div>
						))}
					</CardContent>
				</Card>
			</div>
		</div>
	);
}

function deliveryLabel(status: string): string {
	const labels: Record<string, string> = {
		pending: "待发送",
		sent: "已送达",
		failed: "发送失败",
		cancelled: "已取消",
	};
	return labels[status] ?? status;
}

function deliveryVariant(
	status: string,
): "outline" | "secondary" | "destructive" {
	if (status === "failed") return "destructive";
	if (status === "sent") return "secondary";
	return "outline";
}

function OptionChip({
	label,
	selected,
	actionRef,
}: {
	label: string;
	selected: boolean;
	actionRef?: string;
}) {
	const { mutate, isPending, error } = useChoice(actionRef ?? "");
	const clickable = Boolean(actionRef) && !isPending;

	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				disabled={!clickable}
				onClick={() => actionRef && mutate()}
				className={cn(
					"inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition",
					selected
						? "border-emerald-500/60 bg-emerald-500/15 font-medium text-emerald-700 dark:text-emerald-400"
						: "border-border bg-background",
					clickable
						? "cursor-pointer hover:border-emerald-500/40 hover:bg-emerald-500/5"
						: "cursor-default",
					!selected && !clickable && "text-muted-foreground",
				)}
			>
				{selected ? <Check className="size-3.5 shrink-0" /> : null}
				{isPending ? "提交中…" : label}
			</button>
			{error ? (
				<span className="text-xs text-red-600">{String(error)}</span>
			) : null}
		</div>
	);
}

function useChoice(actionRef: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			const result = await consoleClient.POST("/api/choices", {
				body: { actionRef },
				params: { header: { "Idempotency-Key": crypto.randomUUID() } },
			});
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data;
		},
		onSuccess: () => queryClient.invalidateQueries(),
	});
}
