import { useQueryClient } from "@tanstack/react-query";
import { useState, type FC } from "react";
import { Outlet, useNavigate } from "react-router";
import { consoleClient } from "src/adpulse-client";
import { SidebarInset, SidebarProvider } from "src/components/ui/sidebar";
import { cn } from "src/lib/utils";
import Header from "./vertical/header/Header";
import Sidebar from "./vertical/sidebar/Sidebar";

const FullLayout: FC = () => {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [logoutError, setLogoutError] = useState(false);
	const logout = async () => {
		try {
			const { error, response } = await consoleClient.POST("/api/logout");
			// An already expired session is still a successful local logout.
			if (error && response.status !== 401) {
				setLogoutError(true);
				return;
			}
			queryClient.clear();
			navigate("/login", { replace: true });
		} catch {
			setLogoutError(true);
		}
	};
	return (
		<SidebarProvider
			defaultOpen={true}
			style={{ "--sidebar-width-icon": "52px" } as React.CSSProperties}
		>
			<Sidebar />

			<SidebarInset className="outline outline-border m-2 rounded-none! overflow-hidden">
				<Header />
				<div className="flex flex-1 flex-col gap-4 p-4">
					<div className="flex justify-end">
						{logoutError && (
							<span role="alert" className="mr-3 text-xs text-destructive">
								退出失败，请重试。
							</span>
						)}
						<button className="text-sm underline" onClick={() => void logout()}>
							退出登录
						</button>
					</div>
					<div className={cn("w-full mx-auto", "container")}>
						<div className=" min-h-[calc(100vh-140px)]">
							<Outlet />
						</div>
					</div>
				</div>
			</SidebarInset>
		</SidebarProvider>
	);
};

export default FullLayout;
