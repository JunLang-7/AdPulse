import type { components } from "../../../generated/api.js";

export type TaskInput = components["schemas"]["TaskInput"];
type TaskVersion = components["schemas"]["TaskVersion"];
type TaskRules = components["schemas"]["TaskRules"];

export type ChannelForm = {
	name: string;
	budget: string;
	bidCpc: string;
	enabled: "unknown" | "active" | "paused";
};

export const emptyChannel: ChannelForm = {
	name: "", budget: "", bidCpc: "", enabled: "unknown",
};

const ruleCounts = {
	statWindowDays: "查看最近几天",
	minimumConsultations: "至少收到几次咨询",
	handlingDeadlineHours: "提醒后几小时内处理",
	maxPushRounds: "同一问题最多提醒几轮",
} as const;

export type FormState = {
	product: string;
	objective: string;
	audience: string;
	sellingPoints: string;
	channels: ChannelForm[];
	scope: string;
	startsAt: string;
	endsAt: string;
	metricDefinition: string;
	metricKey: "" | "cost_per_consultation";
	moneyMode: "" | "cny" | "report";
	currency: string;
	unit: string;
	alertThreshold: string;
	minimumSpend: string;
} & Record<keyof typeof ruleCounts, string>;

export const emptyForm: FormState = {
	product: "", objective: "", audience: "", sellingPoints: "", channels: [],
	scope: "", startsAt: "", endsAt: "", metricDefinition: "", metricKey: "",
	moneyMode: "", currency: "", unit: "", alertThreshold: "", minimumSpend: "",
	statWindowDays: "", minimumConsultations: "", handlingDeadlineHours: "", maxPushRounds: "",
};

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function toBeijingInput(value?: string): string {
	if (!value) return "";
	const epoch = Date.parse(value);
	if (!Number.isFinite(epoch)) return "";
	return new Date(epoch + BEIJING_OFFSET_MS).toISOString()
		.slice(0, -1).replace(/:00\.000$/, "").replace(/\.000$/, "");
}

export function formatBeijingTime(value: string): string {
	return toBeijingInput(value).replace("T", " ") + "（北京时间）";
}

export function formatBeijingPeriod({ startsAt, endsAt }: { startsAt: string; endsAt: string }): string {
	return `${toBeijingInput(startsAt).replace("T", " ")} 至 ${toBeijingInput(endsAt).replace("T", " ")}`;
}

function fromBeijingInput(value: string): string {
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
	if (!match) throw new Error("请选择有效的北京时间。");
	const normalized = `${match[1]}:${match[2] ?? "00"}.${(match[3] ?? "").padEnd(3, "0")}`;
	const epoch = Date.parse(`${normalized}+08:00`);
	if (!Number.isFinite(epoch) ||
		new Date(epoch + BEIJING_OFFSET_MS).toISOString().slice(0, -1) !== normalized)
		throw new Error("请选择有效的北京时间。");
	return new Date(epoch).toISOString();
}

export function displayMoney(amount: number | undefined, inYuan: boolean): string {
	if (amount === undefined) return "";
	if (!inYuan) return String(amount);
	const cents = String(amount).padStart(3, "0");
	return `${cents.slice(0, -2)}.${cents.slice(-2)}`.replace(/\.?0+$/, "");
}

export function fromVersion(task: TaskVersion): FormState {
	const rules = task.rules;
	const inYuan = rules.currency === "CNY" && rules.unit === "分";
	const hasMoney = rules.currency !== undefined || rules.unit !== undefined ||
		rules.alertThresholdMinor !== undefined || rules.minimumSpendMinor !== undefined;
	return {
		product: task.product,
		objective: task.strategy.objective,
		audience: task.strategy.audience.join("\n"),
		sellingPoints: task.strategy.sellingPoints.join("\n"),
		channels: Object.entries(task.strategy.channels).map(([name, channel]) => ({
			name,
			budget: channel.budget?.toString() ?? "",
			bidCpc: channel.bidCpc?.toString() ?? "",
			enabled: channel.enabled === undefined ? "unknown" : channel.enabled ? "active" : "paused",
		})),
		scope: task.observation.scope ?? "",
		startsAt: toBeijingInput(task.observation.startsAt),
		endsAt: toBeijingInput(task.observation.endsAt),
		metricDefinition: rules.metricDefinition ?? "",
		metricKey: rules.metricKey ?? "",
		moneyMode: inYuan ? "cny" : hasMoney ? "report" : "",
		currency: rules.currency ?? "",
		unit: rules.unit ?? "",
		alertThreshold: displayMoney(rules.alertThresholdMinor, inYuan),
		minimumSpend: displayMoney(rules.minimumSpendMinor, inYuan),
		statWindowDays: rules.statWindowDays?.toString() ?? "",
		minimumConsultations: rules.minimumConsultations?.toString() ?? "",
		handlingDeadlineHours: rules.handlingDeadlineHours?.toString() ?? "",
		maxPushRounds: rules.maxPushRounds?.toString() ?? "",
	};
}

function parseAmount(value: string, label: string): number | undefined {
	const text = value.trim();
	if (!text) return undefined;
	const amount = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ? Number(text) : NaN;
	if (!Number.isFinite(amount) || amount < 0) throw new Error(`${label}请填写大于或等于 0 的数字。`);
	return amount;
}

function parseCount(value: string, label: string, min = 0): number | undefined {
	const count = parseAmount(value, label);
	if (count === undefined) return undefined;
	const [mantissa, exponent = "0"] = value.trim().toLowerCase().split("e");
	const decimalPlaces = mantissa.split(".")[1]?.length ?? 0;
	const digits = mantissa.replace(".", "");
	const trailingZeros = digits.length - digits.replace(/0+$/, "").length;
	const exactInteger = trailingZeros === digits.length || Number(exponent) + trailingZeros >= decimalPlaces;
	if (!exactInteger || !Number.isSafeInteger(count) || count < min)
		throw new Error(`${label}请填写大于或等于 ${min} 的整数。`);
	return count;
}

export function parseYuan(value: string, label: string): number | undefined {
	const text = value.trim();
	if (!text) return undefined;
	const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
	const amount = match ? Number(match[1] + (match[2] ?? "").padEnd(2, "0")) : NaN;
	if (!Number.isSafeInteger(amount))
		throw new Error(`${label}请填写有效金额，最多保留两位小数。`);
	return amount;
}

function toChannels(rows: ChannelForm[]): TaskInput["strategy"]["channels"] {
	const channels = new Map<string, TaskInput["strategy"]["channels"][string]>();
	for (const row of rows) {
		if (!row.name && !row.budget && !row.bidCpc && row.enabled === "unknown") continue;
		if (!row.name.trim() || row.name.length > 128 ||
			["__proto__", "prototype", "constructor"].includes(row.name.trim()))
			throw new Error("请填写有效的投放渠道名称。");
		if (channels.has(row.name)) throw new Error(`投放渠道“${row.name}”重复了。`);
		const budget = parseAmount(row.budget, `${row.name}的预算`);
		const bidCpc = parseAmount(row.bidCpc, `${row.name}的每次点击出价`);
		channels.set(row.name, {
			...(budget === undefined ? {} : { budget }),
			...(bidCpc === undefined ? {} : { bidCpc }),
			...(row.enabled === "unknown" ? {} : { enabled: row.enabled === "active" }),
		});
	}
	return Object.fromEntries(channels);
}

export function toInput(form: FormState): TaskInput {
	const product = form.product.trim();
	if (!product || product.length > 200) throw new Error("请填写 200 字以内的产品或服务名称。");
	const startsAt = form.startsAt ? fromBeijingInput(form.startsAt) : undefined;
	const endsAt = form.endsAt ? fromBeijingInput(form.endsAt) : undefined;
	if (startsAt && endsAt && startsAt > endsAt)
		throw new Error("观察结束时间不能早于开始时间。");

	const rules: TaskRules = {};
	if (form.metricKey) rules.metricKey = form.metricKey;
	if (form.metricDefinition.trim()) rules.metricDefinition = form.metricDefinition.trim();
	for (const [key, label] of Object.entries(ruleCounts)) {
		const field = key as keyof typeof ruleCounts;
		const value = parseCount(form[field], label, field === "maxPushRounds" ? 1 : 0);
		if (value !== undefined) rules[field] = value;
	}
	if (form.moneyMode === "cny") {
		rules.currency = "CNY";
		rules.unit = "分";
	} else if (form.moneyMode === "report") {
		if (form.currency.trim()) rules.currency = form.currency.trim();
		if (form.unit.trim()) rules.unit = form.unit.trim();
	}
	const parseMoney = form.moneyMode === "cny" ? parseYuan : parseCount;
	const alertThreshold = parseMoney(form.alertThreshold, "提醒线");
	const minimumSpend = parseMoney(form.minimumSpend, "最低花费");
	if (alertThreshold !== undefined) rules.alertThresholdMinor = alertThreshold;
	if (minimumSpend !== undefined) rules.minimumSpendMinor = minimumSpend;

	const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
	return {
		product,
		strategy: {
			objective: form.objective,
			audience: lines(form.audience),
			sellingPoints: lines(form.sellingPoints),
			channels: toChannels(form.channels),
		},
		observation: {
			...(form.scope.trim() ? { scope: form.scope.trim() } : {}),
			...(startsAt ? { startsAt } : {}),
			...(endsAt ? { endsAt } : {}),
		},
		rules,
	};
}
