import type { ReactNode } from "react";

/**
 * 页面分区的统一外观：标题 + 可选说明 + 上分隔线。
 * 用于把一页里的多块内容明确分开（任务 / 事件 / 线索 / 回执），避免整页看起来是一坨。
 */
export function Section({
	title,
	hint,
	tone = "default",
	collapsible = false,
	defaultOpen = true,
	children,
}: {
	title: ReactNode;
	hint?: ReactNode;
	tone?: "default" | "muted";
	/** 次要区块可折叠：默认收起，标题上直接给出条数。 */
	collapsible?: boolean;
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	const heading = (withToggle: boolean) => (
		<div className="flex flex-wrap items-baseline gap-2">
			{withToggle ? <span aria-hidden="true" className="text-xs text-muted-foreground transition-transform group-open:rotate-90">▶</span> : null}
			<h2 className="text-lg font-semibold">{title}</h2>
			{hint ? <span className={`text-xs ${tone === "muted" ? "text-muted-foreground/80" : "text-muted-foreground"}`}>{hint}</span> : null}
		</div>
	);
	if (!collapsible) {
		return (
			<section className="space-y-3 border-t pt-6 first:border-t-0 first:pt-0">
				{heading(false)}
				{children}
			</section>
		);
	}
	return (
		<section className="border-t pt-6 first:border-t-0 first:pt-0">
			<details className="group" open={defaultOpen}>
				<summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">{heading(true)}</summary>
				<div className="space-y-3 pt-3">{children}</div>
			</details>
		</section>
	);
}
