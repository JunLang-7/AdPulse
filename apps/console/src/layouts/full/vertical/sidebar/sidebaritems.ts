export interface ChildItem {
	id?: number | string;
	name: string;
	icon?: LucideIcon;
	items?: ChildItem[];
	item?: unknown;
	url?: string;
	color?: string;
	disabled?: boolean;
	subtitle?: string;
	badge?: boolean;
	badgeType?: string;
	badgeContent?: string;
	isActive?: boolean;
	external?: boolean;
	isPro?: boolean;
}

export interface MenuItem {
	heading?: string;
	name?: string;
	icon?: LucideIcon;
	id?: number;
	to?: string;
	item?: MenuItem[];
	items?: ChildItem[];
	url?: string;
	disabled?: boolean;
	subtitle?: string;
	badgeType?: string;
	badge?: boolean;
	badgeContent?: string;
	isActive?: boolean;
	isPro?: boolean;
}

import {
	BellRing,
	History,
	SlidersHorizontal,
	ClipboardList,
	House,
	type LucideIcon,
} from "lucide-react";

const SidebarContent: MenuItem[] = [
	{
		items: [
			{
				id: "sessions",
				name: "会话列表",
				icon: House,
				url: "/sessions",
			},
			{
				id: "tasks",
				name: "推广任务",
				icon: ClipboardList,
				url: "/tasks",
			},
			{
				id: "notification-settings",
				name: "通知设置",
				icon: BellRing,
				url: "/settings/notifications",
			},
			{
				id: "notification-records",
				name: "通知记录",
				icon: History,
				url: "/settings/notification-records",
			},
			{
				id: "subscription-settings",
				name: "订阅与关注",
				icon: SlidersHorizontal,
				url: "/settings/subscriptions",
			},
		],
	},
];

export default SidebarContent;
