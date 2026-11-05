export type SessionStatus =
	| "planning"
	| "awaiting_input"
	| "completed"
	| "cancelled";

export type RoundStatus = "open" | "answered";

type Tone = {
	label: string;
	variant: "outline" | "secondary" | "destructive";
	className: string;
};

const tones = {
	pending: {
		label: "待选择",
		variant: "outline",
		className:
			"border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
	},
	done: {
		label: "已完成",
		variant: "outline",
		className:
			"border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	},
	idle: {
		label: "规划中",
		variant: "outline",
		className: "border-border bg-muted text-muted-foreground",
	},
	stop: {
		label: "已取消",
		variant: "outline",
		className: "border-destructive/40 bg-destructive/10 text-destructive",
	},
	answered: {
		label: "已处理",
		variant: "outline",
		className:
			"border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	},
	open: {
		label: "等待选择",
		variant: "outline",
		className:
			"border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
	},
} satisfies Record<string, Tone>;

const sessionTones: Record<SessionStatus, Tone> = {
	planning: { ...tones.idle, label: "规划中" },
	awaiting_input: { ...tones.pending },
	completed: { ...tones.done },
	cancelled: { ...tones.stop },
};

const roundTones: Record<RoundStatus, Tone> = {
	open: { ...tones.open },
	answered: { ...tones.answered },
};

export function sessionStatus(status: string): Tone {
	return (
		sessionTones[status as SessionStatus] ?? { ...tones.idle, label: status }
	);
}

export function roundStatus(status: string): Tone {
	return roundTones[status as RoundStatus] ?? { ...tones.idle, label: status };
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
