const links = [
	{
		title: "文档",
		href: "https://github.com/JunLang-7/AdPulse/wiki/development",
	},
	{ title: "Wiki", href: "https://github.com/JunLang-7/AdPulse/wiki" },
];

export default function Footer() {
	return (
		<div className="flex md:flex-row flex-col items-center justify-between gap-3 text-center">
			<p className="text-sm text-muted-foreground">
				AdPulse · 主动发现市场信号，辅助投放决策
			</p>
			<div className="flex gap-4">
				{links.map((item) => (
					<a
						key={item.href}
						href={item.href}
						target="_blank"
						rel="noreferrer"
						className="text-sm hover:text-primary text-muted-foreground"
					>
						{item.title}
					</a>
				))}
			</div>
		</div>
	);
}
