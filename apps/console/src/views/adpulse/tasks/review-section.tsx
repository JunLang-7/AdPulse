import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export function ReviewSection({ title, description, children }: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<details className="group rounded-xl border bg-card">
			<summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden">
				<ChevronRight aria-hidden="true" className="size-4 shrink-0 group-open:rotate-90" />
				<span>
					<span className="block text-sm font-semibold">{title}</span>
					<span className="block text-xs text-muted-foreground">{description}</span>
				</span>
			</summary>
			<div className="px-4 pb-4">{children}</div>
		</details>
	);
}
