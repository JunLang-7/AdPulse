import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Link } from "react-router";
import SimpleBar from "simplebar-react";
import "simplebar-react/dist/simplebar.min.css";
import { consoleClient } from "src/adpulse-client";
import { Badge } from "src/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "src/components/ui/dropdown-menu";
import { cn } from "src/lib/utils";

/** Real data only: sessions that are currently waiting for a human choice. */
export default function Notifications({ className }: { className?: string }) {
	const { data } = useQuery({
		queryKey: ["sessions"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/sessions");
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data.items;
		},
	});

	const pending = (data ?? []).filter(
		(session) => session.status === "awaiting_input",
	);

	return (
		<div className={cn("", className)}>
			<DropdownMenu>
				<DropdownMenuTrigger>
					<div className="relative cursor-pointer">
						{pending.length > 0 ? (
							<span className="h-2.5 w-2.5 bg-destructive rounded-full absolute top-1 end-2 z-1" />
						) : null}
						<div className="flex justify-center items-center hover:bg-primary/5 w-10 h-10 rounded-full">
							<Bell className="size-5" />
						</div>
					</div>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					className="w-screen sm:w-[360px] py-6 px-0"
				>
					<div className="flex items-center px-6 justify-between">
						<h3 className="text-lg font-semibold">待处理</h3>
						{pending.length > 0 ? (
							<Badge className="px-3 bg-primary hover:bg-primary">
								{pending.length} 项
							</Badge>
						) : null}
					</div>

					<SimpleBar className="max-h-80 mt-3">
						{pending.length === 0 ? (
							<p className="px-6 py-4 text-sm text-muted-foreground">
								没有等待处理的会话。
							</p>
						) : (
							<div className="flex flex-col">
								{pending.map((session) => (
									<Link
										key={session.id}
										to={`/sessions/${session.id}`}
										className="flex flex-col gap-1 px-6 py-3 hover:bg-primary/5"
									>
										<span className="text-sm font-medium">
											{session.signal.title}
										</span>
										<span className="text-xs text-muted-foreground">
											第 {session.roundNo} 轮 · 等待选择
										</span>
									</Link>
								))}
							</div>
						)}
					</SimpleBar>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
