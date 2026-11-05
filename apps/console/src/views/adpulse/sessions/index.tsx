import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { consoleClient } from "../../../adpulse-client";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";

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
					请确认 API 已启动（<code>bun run start</code>），并且 .env 中的
					CONSOLE_TOKEN 非空。
				</p>
			</div>
		);
	}

	return (
		<div className="p-6 space-y-4">
			<h1 className="text-2xl font-bold">决策会话</h1>
			{data && data.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					还没有会话。运行 <code>bun run demo</code> 生成一条演示数据。
				</p>
			) : null}
			<div className="grid gap-4 md:grid-cols-2">
				{data?.map((session) => (
					<Link key={session.id} to={`/sessions/${session.id}`}>
						<Card>
							<CardHeader>
								<CardTitle>{session.signal.title}</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="text-sm text-muted-foreground">
									{session.signal.summary}
								</p>
								<p className="text-xs mt-2">
									状态：{session.status} · 轮次：{session.roundNo}
								</p>
							</CardContent>
						</Card>
					</Link>
				))}
			</div>
		</div>
	);
}
