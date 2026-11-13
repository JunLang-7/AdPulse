import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { consoleClient } from "../../../../adpulse-client";
import { Badge } from "../../../../components/ui/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../../components/ui/card";
import {
	describeReadiness,
	type NotificationStatusLike,
	type SubscriptionViewLike,
} from "../subscriptions/subscription-view";
import {
	describeRecord,
	formatBeijing,
	type RecordLike,
} from "./record-view";

const errorText = (status: number, error: unknown): string => {
	switch (status) {
		case 400:
			return "查询参数不合法，请刷新页面后重试。";
		case 401:
			return "登录已过期，请重新登录。";
		default:
			return `读取通知记录失败：${String(error)}`;
	}
};

export default function NotificationRecordsPage() {
	// 记录只读：页面不提供发送、重试、删除入口，也不创建会话。
	const records = useInfiniteQuery({
		queryKey: ["notification-records"],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const result = await consoleClient.GET("/api/me/notifications", {
				params: { query: pageParam ? { before: pageParam } : {} },
			});
			if (!result.data)
				throw Object.assign(new Error("records failed"), {
					status: result.response.status,
					detail: result.error,
				});
			return result.data;
		},
		getNextPageParam: (last) => last.nextBefore ?? undefined,
	});

	const subscription = useQuery({
		queryKey: ["subscription"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/me/subscription");
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data as unknown as SubscriptionViewLike;
		},
	});

	const notification = useQuery({
		queryKey: ["notification-status"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/me/notification-status");
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data as unknown as NotificationStatusLike;
		},
	});

	const failure = records.error as (Error & { status?: number }) | null;

	if (records.isLoading)
		return <div className="p-6">正在读取通知记录…</div>;
	if (failure)
		return (
			<div className="p-6 text-red-600">
				{errorText(
					failure.status ?? 0,
					(failure as Error & { detail?: unknown }).detail ?? failure,
				)}
			</div>
		);

	const all = (records.data?.pages ?? []).flatMap((page) =>
		((page.records ?? []) as unknown as RecordLike[]).map((record) => ({
			record,
			view: describeRecord(record),
		})),
	);
	// 就绪状态复用订阅页的判定，避免两套「会不会收到」的说法。
	const readiness =
		subscription.data && notification.data
			? describeReadiness(subscription.data, notification.data)
			: null;

	return (
		<div className="p-6 space-y-4">
			<div>
				<h1 className="text-2xl font-bold">通知记录</h1>
				<p className="text-sm text-muted-foreground">
					这里只展示已经发生的汇总与发送结果，说明为什么收到或没收到；
					「平台已接收」不等于你已读。
				</p>
			</div>

			{readiness ? (
				<Card className="max-w-3xl">
					<CardHeader>
						<div className="flex items-start justify-between gap-3">
							<CardTitle>{readiness.title}</CardTitle>
							<Badge variant={readiness.canDeliver ? "secondary" : "outline"}>
								{readiness.canDeliver ? "会收到提醒" : "不会收到提醒"}
							</Badge>
						</div>
					</CardHeader>
					<CardContent>
						<p className="text-sm text-muted-foreground">{readiness.detail}</p>
					</CardContent>
				</Card>
			) : null}

			{all.length === 0 ? (
				<Card className="max-w-3xl">
					<CardHeader>
						<CardTitle>暂无通知记录</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm text-muted-foreground">
						<p>
							有匹配的新内容才会生成记录；没有新内容时不发空汇总，也不会留下「空日报」。
						</p>
						<p>
							如果一直没有任何记录，请先确认订阅开关、单聊地址与通知授权是否都已就绪。
						</p>
					</CardContent>
				</Card>
			) : (
				<div className="max-w-3xl space-y-3">
					{all.map(({ record, view }) => (
						<Card key={record.id} data-testid="notification-record">
							<CardHeader>
								<div className="flex items-start justify-between gap-3">
									<CardTitle>{view.title}</CardTitle>
									<Badge
										variant={
											view.tone === "ok"
												? "secondary"
												: view.tone === "error"
													? "destructive"
													: "outline"
										}
									>
										{view.statusLabel}
									</Badge>
								</div>
								<p className="text-xs text-muted-foreground">
									计划 {view.times.planned}
									{view.times.sent ? ` · 已发送 ${view.times.sent}` : ""}
									{` · 条目 ${record.items.length} 条`}
								</p>
							</CardHeader>
							<CardContent className="space-y-3 text-sm">
								{view.reason ? (
									<div
										className="rounded-md border border-border bg-muted/40 p-3"
										data-testid="notification-record-reason"
									>
										<p className="font-medium">{view.reason.label}</p>
										<p className="text-muted-foreground">
											{view.reason.detail}
										</p>
									</div>
								) : null}
								{view.itemsNote ? (
									<p
										className="text-xs text-muted-foreground"
										data-testid="notification-record-items-note"
									>
										{view.itemsNote}
									</p>
								) : null}
								{view.items.map((item) => (
									<div key={item.id} className="space-y-1">
										<div className="flex items-baseline justify-between gap-3">
											<p className="font-medium">{item.title}</p>
											<span className="text-xs text-muted-foreground">
												{item.statusLabel}
											</span>
										</div>
										<p>{item.summary}</p>
										<p className="text-muted-foreground">
											为什么相关：{item.relevance}
										</p>
										{item.sources.length > 0 ? (
											<ul className="space-y-1 text-xs text-muted-foreground">
												{item.sources.map((source) => (
													<li key={source.url ?? source.label}>
														来源：
														{source.url ? (
															<a
																className="underline"
																href={source.url}
																rel="noreferrer noopener"
																target="_blank"
															>
																{source.label}
															</a>
														) : (
															source.label
														)}
														{source.publishedAt
															? ` · 发布 ${formatBeijing(source.publishedAt)}`
															: " · 发布时间未知"}
													</li>
												))}
											</ul>
										) : null}
									</div>
								))}
								{view.deliveryNote ? (
									<p
										className="text-xs text-muted-foreground"
										data-testid="notification-record-delivery"
									>
										{view.deliveryNote}
									</p>
								) : null}
							</CardContent>
						</Card>
					))}
					{records.hasNextPage ? (
						<button
							className="text-sm underline disabled:opacity-50"
							disabled={records.isFetchingNextPage}
							onClick={() => void records.fetchNextPage()}
							type="button"
						>
							{records.isFetchingNextPage ? "正在加载…" : "加载更早的记录"}
						</button>
					) : null}
				</div>
			)}
		</div>
	);
}
