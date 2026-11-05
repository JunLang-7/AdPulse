import type { LucideIcon } from "lucide-react";
import { HelpCircle, Home } from "lucide-react";

interface profileType {
	avatar: LucideIcon;
	title: string;
	href: string;
	badge: boolean;
}

const profileDD: profileType[] = [
	{
		avatar: Home,
		title: "会话列表",
		href: "/sessions",
		badge: false,
	},
	{
		avatar: HelpCircle,
		title: "项目 Wiki",
		href: "https://github.com/JunLang-7/AdPulse/wiki",
		badge: false,
	},
];

export { profileDD };
