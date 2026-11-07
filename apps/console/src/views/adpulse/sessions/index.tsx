import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { consoleClient } from "../../../adpulse-client";
import { Badge } from "../../../components/ui/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { formatTime, sessionStatus } from "../status";

export default function SessionsPage() {
	const { data, isLoading, error } = useQuery({
		queryKey: ["sessions"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/sessions");
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data.items;
		},
	});

	if (isLoading) return <div className="p-6">正在加载会话列表…</div>;
	if (error) {
		return (
			<div className="p-6 space-y-2">
				<p className="text-red-600">读取会话列表失败</p>
				<pre className="text-xs whitespace-pre-wrap">{String(error)}</pre>
				<p className="text-sm">
					请确认 API 已启动（<code>bun run start</code>），并完成飞书企业账号登录。
				</p>
			</div>
		);
	}

	return (
		<div className="p-6 space-y-4">
			<div className="flex items-baseline justify-between">
				<h1 className="text-2xl font-bold">决策会话</h1>
				<span className="text-sm text-muted-foreground">
					共 {data?.length ?? 0} 条
				</span>
			</div>

			{data && data.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					还没有会话。运行 <code>bun run demo</code> 生成一条演示数据。
				</p>
			) : null}

			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
				{data?.map((session) => {
					const status = sessionStatus(session.status);
					return (
						<Link
							key={session.id}
							to={`/sessions/${session.id}`}
							className="group/card block focus-visible:outline-none"
						>
							<Card className="h-full transition hover:ring-foreground/25">
								<CardHeader>
									<div className="flex items-start justify-between gap-2">
										<CardTitle className="line-clamp-2">
											{session.signal.title}
										</CardTitle>
										<Badge className={status.className}>{status.label}</Badge>
									</div>
								</CardHeader>
								<CardContent className="space-y-3">
									<p className="text-sm text-muted-foreground line-clamp-2">
										{session.signal.summary}
									</p>

									<div className="flex flex-wrap items-center gap-1.5">
										<Badge variant="outline">第 {session.roundNo} 轮</Badge>
										<Badge variant="outline">v{session.version} 策略</Badge>
										{(session.signal.evidence ?? []).length > 0 ? (
											<Badge variant="outline">
												{session.signal.evidence.length} 条依据
											</Badge>
										) : null}
									</div>

									<div className="flex items-center justify-between text-xs text-muted-foreground">
										<span>
											{session.recipient.kind === "group" ? "群聊" : "单聊"} ·{" "}
											{session.recipient.externalId}
										</span>
										<span className="flex items-center gap-1">
											{formatTime(session.createdAt)}
											<ChevronRight className="size-3.5 transition group-hover/card:translate-x-0.5" />
										</span>
									</div>
								</CardContent>
							</Card>
						</Link>
					);
				})}
			</div>
		</div>
	);
}
