import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Icon } from "@iconify/react";
import { UserRound } from "lucide-react";
import { consoleClient } from "src/adpulse-client";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "src/components/ui/dropdown-menu";
import { announceSessionIdentity } from "src/views/auth/session-sync";
import { platformLabel } from "src/views/auth/platform-label";
import { profileDD } from "./data";

const isExternal = (href: string) => href.startsWith("http");

/**
 * 账号菜单只放可操作项：外部标识、租户、应用、会话到期属于运维/验收信息，
 * 不呈现给使用者。
 */
export default function ProfileMenu() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [logoutError, setLogoutError] = useState(false);
	const [loggingOut, setLoggingOut] = useState(false);

	// 只展示平台返回的显示名；取不到时用中性占位，不编造称呼。
	const { data: me } = useQuery({
		queryKey: ["me"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/me");
			if (!result.data) throw new Error("无法读取当前用户");
			return result.data;
		},
	});
	const displayName = me?.displayName?.trim() || "已登录";
	// 平台标签来自真实绑定，不在界面里硬编码平台名。
	const platform = platformLabel(me?.identities?.[0]?.platform);

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
					<div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
						<UserRound className="size-4" />
					</div>
				</div>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48 py-2">
				<div className="px-3 py-2">
					<p className="truncate text-sm font-medium">{displayName}</p>
					{platform ? (
						<p className="text-xs text-muted-foreground">{platform}</p>
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
