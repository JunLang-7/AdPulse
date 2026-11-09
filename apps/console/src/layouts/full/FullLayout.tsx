import type { FC } from "react";
import { Outlet } from "react-router";
import { cn } from "src/lib/utils";
import { SidebarInset, SidebarProvider } from "src/components/ui/sidebar";
import Header from "./vertical/header/Header";
import Sidebar from "./vertical/sidebar/Sidebar";

/** 账号相关动作（身份、会话到期、退出）统一在顶栏账号菜单里，内容区不再承载。 */
const FullLayout: FC = () => {
	return (
		<SidebarProvider
			defaultOpen={true}
			style={{ "--sidebar-width-icon": "52px" } as React.CSSProperties}
		>
			<Sidebar />

			<SidebarInset className="outline outline-border m-2 rounded-none! overflow-hidden">
				<Header />
				<div className="flex flex-1 flex-col gap-4 p-4">
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
