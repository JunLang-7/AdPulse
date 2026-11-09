import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Icon } from "@iconify/react";
import { consoleClient } from "src/adpulse-client";
import { Avatar, AvatarFallback, AvatarImage } from "src/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "src/components/ui/dropdown-menu";
import { announceSessionIdentity } from "src/views/auth/session-sync";
import {
	describeIdentity,
	formatSessionExpiry,
} from "src/views/adpulse/account/account-display";
import { profileDD } from "./data";

const isExternal = (href: string) => href.startsWith("http");

export default function ProfileMenu() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [logoutError, setLogoutError] = useState(false);
	const [loggingOut, setLoggingOut] = useState(false);

	const { data: me } = useQuery({
		queryKey: ["me"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/me");
			if (!result.data) throw new Error("无法读取当前用户");
			return result.data;
		},
	});

	const identity = me?.identities?.[0];
	const summary = describeIdentity(identity);
	const expiry = formatSessionExpiry(me?.sessionExpiresAt);

	const logout = async () => {
		if (loggingOut) return;
		setLoggingOut(true);
		setLogoutError(false);
		try {
			const { error, response } = await consoleClient.POST("/api/logout");
			// 已过期会话等价于本地退出成功。
			if (error && response.status !== 401) {
				setLogoutError(true);
				setLoggingOut(false);
				return;
			}
			announceSessionIdentity(null);
			await queryClient.cancelQueries();
			queryClient.clear();
			navigate("/login", { replace: true });
		} catch {
			setLogoutError(true);
		} finally {
			setLoggingOut(false);
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger>
				<div className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-primary/5">
					<Avatar className="h-8 w-8">
						<AvatarImage src="" alt="账号" />
						<AvatarFallback>AD</AvatarFallback>
					</Avatar>
				</div>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-72 py-2">
				<div className="flex flex-col gap-1 px-3 py-2">
					<p className="text-sm font-semibold">{summary.title}</p>
					<p className="text-xs text-muted-foreground">{summary.scope}</p>
					{expiry ? (
						<p className="text-xs text-muted-foreground">本次会话 {expiry}</p>
					) : null}
				</div>
				<DropdownMenuSeparator />
				{profileDD.map((item) => {
					const content = (
						<span className="flex items-center gap-3 text-sm">
							<item.avatar width={18} height={18} />
							{item.title}
						</span>
					);
					return (
						<DropdownMenuItem key={item.title}>
							{isExternal(item.href) ? (
								<a
									href={item.href}
									target="_blank"
									rel="noreferrer"
									className="flex w-full items-center"
								>
									{content}
								</a>
							) : (
								<Link to={item.href} className="flex w-full items-center">
									{content}
								</Link>
							)}
						</DropdownMenuItem>
					);
				})}
				<DropdownMenuSeparator />
				{logoutError ? (
					<p role="alert" className="px-3 py-1 text-xs text-destructive">
						退出失败，请重试。
					</p>
				) : null}
				<DropdownMenuItem
					className="cursor-pointer text-destructive"
					onClick={() => void logout()}
				>
					<span className="flex items-center gap-3 text-sm">
						<Icon icon="tabler:logout" width={18} height={18} />
						{loggingOut ? "正在退出…" : "退出登录"}
					</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
