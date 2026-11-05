import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { consoleClient } from "../../../adpulse-client";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";

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

	return (
		<div className="p-6 space-y-4">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">{data.session.signal.title}</h1>
				<Link className="text-sm underline" to="/sessions">
					返回列表
				</Link>
			</div>
			<p className="text-sm text-muted-foreground">
				{data.session.signal.summary}
			</p>

			<Card>
				<CardHeader>
					<CardTitle>状态</CardTitle>
				</CardHeader>
				<CardContent className="text-sm space-y-1">
					<p>会话状态：{data.session.status}</p>
					<p>当前轮次：{data.session.roundNo}</p>
					<p>交互版本：{data.session.version}</p>
					<p>到期时间：{data.session.expiresAt}</p>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>轮次</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					{data.rounds.length === 0 ? (
						<p className="text-sm">还没有生成轮次。</p>
					) : null}
					{data.rounds.map((round) => {
						const candidates = (round.candidates ?? []) as Array<{
							id: string;
							label: string;
						}>;
						const actions = (data.actions ?? []).filter(
							(a) => a.roundId === round.id,
						);
						return (
							<div key={round.id} className="border rounded p-3 space-y-2">
								<p className="font-medium">
									第 {round.roundNo} 轮 ·{" "}
									{round.status === "open" ? "等待选择" : "已处理"}
								</p>
								<p className="text-sm">{round.card?.title}</p>
								<p className="text-xs text-muted-foreground">
									{round.card?.summary}
								</p>
								<ul className="text-sm space-y-1">
									{candidates.map((candidate) => {
										const action = actions.find(
											(a) => a.optionId === candidate.id,
										);
										return (
											<li
												key={candidate.id}
												className="flex items-center justify-between gap-2"
											>
												<span>{candidate.label}</span>
												{round.status === "open" && action ? (
													<ChoiceButton actionRef={action.id} />
												) : (
													<span className="text-xs text-muted-foreground">
														{round.selectedOptionId === candidate.id
															? "已选择"
															: "—"}
													</span>
												)}
											</li>
										);
									})}
								</ul>
							</div>
						);
					})}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>投递</CardTitle>
				</CardHeader>
				<CardContent className="text-sm space-y-1">
					{data.deliveries.length === 0 ? <p>暂无投递记录。</p> : null}
					{data.deliveries.map((delivery) => (
						<p key={delivery.id}>
							{delivery.purpose} · {delivery.status}
							{delivery.externalMessageId
								? ` · ${delivery.externalMessageId}`
								: ""}
						</p>
					))}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>策略快照</CardTitle>
				</CardHeader>
				<CardContent className="text-sm space-y-2">
					{data.snapshots.map((snapshot) => (
						<p key={snapshot.id}>
							v{snapshot.version}：{snapshot.changes.length} 项变更
						</p>
					))}
				</CardContent>
			</Card>
		</div>
	);
}

function ChoiceButton({ actionRef }: { actionRef: string }) {
	const { mutate, isPending, error } = useChoice(actionRef);
	return (
		<div className="flex items-center gap-2">
			<button
				type="button"
				className="px-3 py-1 text-sm rounded border"
				disabled={isPending}
				onClick={() => mutate()}
			>
				{isPending ? "提交中…" : "在控制台选择"}
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
