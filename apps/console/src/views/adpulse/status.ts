export type SessionStatus =
	| "planning"
	| "awaiting_input"
	| "completed"
	| "cancelled";

export type RoundStatus = "open" | "answered";

const sessionLabels: Record<
	SessionStatus,
	{ label: string; className: string }
> = {
	planning: {
		label: "规划中",
		className: "bg-muted text-muted-foreground",
	},
	awaiting_input: {
		label: "待选择",
		className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
	},
	completed: {
		label: "已完成",
		className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
	},
	cancelled: {
		label: "已取消",
		className: "bg-destructive/10 text-destructive",
	},
};

const roundLabels: Record<RoundStatus, { label: string; className: string }> = {
	open: {
		label: "等待选择",
		className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
	},
	answered: {
		label: "已处理",
		className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
	},
};

export function sessionStatus(status: string) {
	return (
		sessionLabels[status as SessionStatus] ?? {
			label: status,
			className: "bg-muted text-muted-foreground",
		}
	);
}

export function roundStatus(status: string) {
	return (
		roundLabels[status as RoundStatus] ?? {
			label: status,
			className: "bg-muted text-muted-foreground",
		}
	);
}

export function formatTime(value?: string): string {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

export function isExpired(value?: string): boolean {
	if (!value) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && time <= Date.now();
}
