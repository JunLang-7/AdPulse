import { BookOpen, LifeBuoy } from "lucide-react";

const links = [
	{
		href: "https://github.com/JunLang-7/AdPulse/blob/main/docs/development.md",
		label: "使用文档",
		icon: BookOpen,
	},
	{
		href: "https://github.com/JunLang-7/AdPulse/issues",
		label: "问题反馈",
		icon: LifeBuoy,
	},
];

export function NavSecondary() {
	return (
		<div className="-mx-4 border-t border-b border-border px-5 py-5">
			<div className="flex flex-col gap-1">
				{links.map(({ href, label, icon: Icon }) => (
					<a
						key={href}
						href={href}
						target="_blank"
						rel="noreferrer"
						className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent"
					>
						<Icon className="size-4 shrink-0" />
						{label}
					</a>
				))}
			</div>
		</div>
	);
}
