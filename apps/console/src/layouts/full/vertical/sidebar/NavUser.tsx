import { BookOpen, LifeBuoy } from "lucide-react";
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar";

const navItems = [
	{
		title: "开发文档",
		url: "https://github.com/JunLang-7/AdPulse/wiki/development",
		icon: LifeBuoy,
	},
	{
		title: "架构说明",
		url: "https://github.com/JunLang-7/AdPulse/wiki/architecture",
		icon: BookOpen,
	},
];

export function NavUser() {
	return (
		<SidebarGroup className="mt-auto p-0">
			<SidebarGroupContent>
				<SidebarMenu>
					{navItems.map((item) => (
						<SidebarMenuItem key={item.title}>
							<SidebarMenuButton size="lg" className="h-full cursor-pointer">
								<a href={item.url} target="_blank" rel="noreferrer">
									<div className="flex items-center gap-3 w-full">
										<item.icon className="shadow-none size-5 shrink-0" />
										<div className="flex flex-col flex-1 text-left text-sm leading-tight hide-menu whitespace-nowrap">
											<span className="truncate font-medium">{item.title}</span>
										</div>
									</div>
								</a>
							</SidebarMenuButton>
						</SidebarMenuItem>
					))}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	);
}
