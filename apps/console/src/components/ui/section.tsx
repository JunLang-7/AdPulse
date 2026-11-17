import type { ReactNode } from "react";

/**
 * 页面分区的统一外观：标题 + 可选说明 + 上分隔线。
 * 用于把一页里的多块内容明确分开（任务 / 事件 / 线索 / 回执），避免整页看起来是一坨。
 */
export function Section({
	title,
	hint,
	tone = "default",
	children,
}: {
	title: ReactNode;
	hint?: ReactNode;
	tone?: "default" | "muted";
	children: ReactNode;
}) {
	return (
		<section className="space-y-3 border-t pt-6 first:border-t-0 first:pt-0">
			<div className="flex flex-wrap items-baseline gap-2">
				<h2 className="text-lg font-semibold">{title}</h2>
				{hint ? <span className={`text-xs ${tone === "muted" ? "text-muted-foreground/80" : "text-muted-foreground"}`}>{hint}</span> : null}
			</div>
			{children}
		</section>
	);
}
