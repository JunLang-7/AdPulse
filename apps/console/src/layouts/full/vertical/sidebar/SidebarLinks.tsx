import { BookOpen, LifeBuoy } from "lucide-react";

const links = [
	{
		title: "使用文档",
		href: "https://github.com/JunLang-7/AdPulse/wiki/development",
		icon: BookOpen,
	},
	{
		title: "问题反馈",
		href: "https://github.com/JunLang-7/AdPulse/issues",
		icon: LifeBuoy,
	},
];

export function SidebarLinks() {
	return (
		<div className="-mx-4 border-t border-border px-5 py-3">
			<div className="flex flex-col gap-1">
				{links.map(({ title, href, icon: Icon }) => (
					<a
						key={href}
						href={href}
						target="_blank"
						rel="noreferrer"
						className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-primary/5 hover:text-foreground"
					>
						<Icon className="size-4 shrink-0" />
						<span className="hide-menu">{title}</span>
					</a>
				))}
			</div>
		</div>
	);
}
