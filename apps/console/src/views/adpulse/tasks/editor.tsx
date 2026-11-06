import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { consoleClient, type components } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";

type TaskInput = components["schemas"]["TaskInput"];
type TaskRules = components["schemas"]["TaskRules"];
type TaskVersion = components["schemas"]["TaskVersion"];
type FormState = {
	product: string;
	objective: string;
	audience: string;
	channels: string;
	sellingPoints: string;
	scope: string;
	startsAt: string;
	endsAt: string;
	metricDefinition: string;
	currency: string;
	unit: string;
	statWindowDays: string;
	alertThresholdMinor: string;
	minimumSpendMinor: string;
	minimumConsultations: string;
	handlingDeadlineHours: string;
	maxPushRounds: string;
};

const emptyForm: FormState = {
	product: "",
	objective: "",
	audience: "",
	channels: "{}",
	sellingPoints: "",
	scope: "",
	startsAt: "",
	endsAt: "",
	metricDefinition: "",
	currency: "",
	unit: "",
	statWindowDays: "",
	alertThresholdMinor: "",
	minimumSpendMinor: "",
	minimumConsultations: "",
	handlingDeadlineHours: "",
	maxPushRounds: "",
};

const localDateTime = (value?: string): string =>
	value ? new Date(value).toISOString().slice(0, 16) : "";
const optionalInteger = (value: string): number | undefined =>
	value.trim() === "" ? undefined : Number(value);
const optionalString = (value: string): string | undefined =>
	value.trim() === "" ? undefined : value.trim();
const optionalRuleNumbers = [
	"statWindowDays",
	"alertThresholdMinor",
	"minimumSpendMinor",
	"minimumConsultations",
	"handlingDeadlineHours",
	"maxPushRounds",
] as const;

function fromVersion(task: TaskVersion): FormState {
	const rules = task.rules;
	return {
		product: task.product,
		objective: task.strategy.objective,
		audience: task.strategy.audience.join("\n"),
		channels: JSON.stringify(task.strategy.channels, null, 2),
		sellingPoints: task.strategy.sellingPoints.join("\n"),
		scope: task.observation.scope ?? "",
		startsAt: localDateTime(task.observation.startsAt),
		endsAt: localDateTime(task.observation.endsAt),
		metricDefinition: rules.metricDefinition ?? "",
		currency: rules.currency ?? "",
		unit: rules.unit ?? "",
		statWindowDays: rules.statWindowDays?.toString() ?? "",
		alertThresholdMinor: rules.alertThresholdMinor?.toString() ?? "",
		minimumSpendMinor: rules.minimumSpendMinor?.toString() ?? "",
		minimumConsultations: rules.minimumConsultations?.toString() ?? "",
		handlingDeadlineHours: rules.handlingDeadlineHours?.toString() ?? "",
		maxPushRounds: rules.maxPushRounds?.toString() ?? "",
	};
}

function toInput(form: FormState): TaskInput {
	const channels: unknown = JSON.parse(form.channels);
	if (!channels || typeof channels !== "object" || Array.isArray(channels))
		throw new Error("渠道配置必须是 JSON 对象");
	const rules: TaskRules = {
		...(optionalString(form.metricDefinition)
			? { metricDefinition: optionalString(form.metricDefinition) }
			: {}),
		...(optionalString(form.currency)
			? { currency: optionalString(form.currency) }
			: {}),
		...(optionalString(form.unit) ? { unit: optionalString(form.unit) } : {}),
	};
	for (const key of optionalRuleNumbers) {
		const value = optionalInteger(form[key]);
		if (value !== undefined) rules[key] = value;
	}
	const date = (value: string): string | undefined =>
		value ? new Date(`${value}:00.000Z`).toISOString() : undefined;
	return {
		product: form.product.trim(),
		strategy: {
			objective: form.objective,
			audience: form.audience
				.split("\n")
				.map((value) => value.trim())
				.filter(Boolean),
			channels: channels as TaskInput["strategy"]["channels"],
			sellingPoints: form.sellingPoints
				.split("\n")
				.map((value) => value.trim())
				.filter(Boolean),
		},
		observation: {
			...(optionalString(form.scope) ? { scope: optionalString(form.scope) } : {}),
			...(form.startsAt ? { startsAt: date(form.startsAt) } : {}),
			...(form.endsAt ? { endsAt: date(form.endsAt) } : {}),
		},
		rules,
	};
}

export default function TaskEditorPage() {
	const { taskId } = useParams();
	const creating = taskId === "new";
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [form, setForm] = useState<FormState>(emptyForm);
	const [formError, setFormError] = useState("");
	const operationKey = useRef<string | null>(null);
	const detail = useQuery({
		queryKey: ["task", taskId],
		enabled: Boolean(taskId && !creating),
		queryFn: async () => {
			const result = await consoleClient.GET("/api/tasks/{taskId}", {
				params: { path: { taskId: taskId ?? "" } },
			});
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data;
		},
	});

	useEffect(() => {
		if (!creating && detail.data) setForm(fromVersion(detail.data.task));
	}, [creating, detail.data]);

	const save = useMutation({
		mutationFn: async (input: TaskInput) => {
			const key = (operationKey.current ??= crypto.randomUUID());
			if (creating) {
				const result = await consoleClient.POST("/api/tasks", {
					body: input,
					params: { header: { "Idempotency-Key": key } },
				});
				if (!result.data) throw new Error(JSON.stringify(result.error));
				return result.data;
			}
			const current = detail.data?.task;
			if (!taskId || !current) throw new Error("任务尚未加载");
			const result = await consoleClient.PATCH("/api/tasks/{taskId}", {
				params: {
					path: { taskId },
					header: { "Idempotency-Key": key },
				},
				body: { expectedTaskVersion: current.version, task: input },
			});
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data;
		},
		onSuccess: async (saved) => {
			operationKey.current = null;
			setFormError("");
			await queryClient.invalidateQueries({ queryKey: ["tasks"] });
			await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
			if (creating) navigate(`/tasks/${saved.taskId}`);
		},
		onError: (error) => setFormError(String(error)),
	});

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setFormError("");
		try {
			save.mutate(toInput(form));
		} catch (error) {
			setFormError(String(error));
		}
	}

	function set<K extends keyof FormState>(key: K, value: FormState[K]) {
		setForm((current) => ({ ...current, [key]: value }));
	}

	if (!creating && (detail.isLoading || !detail.data) && !detail.error)
		return <div className="p-6">正在加载任务…</div>;
	if (!creating && detail.error)
		return <div className="p-6 text-red-600">读取任务失败：{String(detail.error)}</div>;

	return (
		<div className="p-6 space-y-4">
			<Link to="/tasks" className="text-sm text-muted-foreground hover:text-foreground">
				← 返回任务列表
			</Link>
			<h1 className="text-2xl font-bold">{creating ? "新建推广任务" : "推广任务基线"}</h1>
			<p className="text-sm text-muted-foreground">
				留空表示未知或未确认；不要把未知预算、出价或阈值填成 0。确认的真实 0 可以明确填写。
			</p>

			{detail.data && !creating ? (
				<Card>
					<CardHeader><CardTitle>历史版本</CardTitle></CardHeader>
					<CardContent className="flex flex-wrap gap-2">
						{detail.data.versions.map((version) => (
							<span key={version.id} className="rounded border px-2 py-1 text-xs">
								v{version.version} · {new Date(version.createdAt).toLocaleString()}
							</span>
						))}
					</CardContent>
				</Card>
			) : null}

			<form onSubmit={submit} className="space-y-4">
				<Card>
					<CardHeader><CardTitle>任务与当前策略</CardTitle></CardHeader>
					<CardContent className="grid gap-4 md:grid-cols-2">
						<Field label="产品 / 服务 *">
							<Input required maxLength={200} value={form.product} onChange={(e) => set("product", e.target.value)} />
						</Field>
						<Field label="推广目标">
							<Input value={form.objective} onChange={(e) => set("objective", e.target.value)} />
						</Field>
						<Field label="目标受众（每行一项）">
							<textarea className="min-h-20 w-full rounded-md border bg-background p-2 text-sm" value={form.audience} onChange={(e) => set("audience", e.target.value)} />
						</Field>
						<Field label="卖点（每行一项）">
							<textarea className="min-h-20 w-full rounded-md border bg-background p-2 text-sm" value={form.sellingPoints} onChange={(e) => set("sellingPoints", e.target.value)} />
						</Field>
						<div className="md:col-span-2">
							<Field label="渠道策略 JSON">
								<textarea className="min-h-32 w-full rounded-md border bg-background p-2 font-mono text-xs" value={form.channels} onChange={(e) => set("channels", e.target.value)} />
							</Field>
							<p className="mt-1 text-xs text-muted-foreground">未提供的 budget、bidCpc、enabled 字段请省略；例如真实预算为 0 时填写 "budget": 0。</p>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader><CardTitle>观察范围与期限</CardTitle></CardHeader>
					<CardContent className="grid gap-4 md:grid-cols-2">
						<Field label="范围 / 说明"><Input value={form.scope} onChange={(e) => set("scope", e.target.value)} /></Field>
						<Field label="开始时间（按 UTC 录入）"><Input type="datetime-local" value={form.startsAt} onChange={(e) => set("startsAt", e.target.value)} /></Field>
						<Field label="结束时间（按 UTC 录入）"><Input type="datetime-local" value={form.endsAt} onChange={(e) => set("endsAt", e.target.value)} /></Field>
					</CardContent>
				</Card>

				<Card>
					<CardHeader><CardTitle>已确认的核查规则（可暂不填写）</CardTitle></CardHeader>
					<CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						<OptionalField label="指标定义" value={form.metricDefinition} onChange={(v) => set("metricDefinition", v)} />
						<OptionalField label="币种" value={form.currency} onChange={(v) => set("currency", v)} />
						<OptionalField label="金额单位" value={form.unit} onChange={(v) => set("unit", v)} />
						<OptionalField label="统计窗口（天）" type="number" min="0" value={form.statWindowDays} onChange={(v) => set("statWindowDays", v)} />
						<OptionalField label="警戒线（最小货币单位）" type="number" min="0" value={form.alertThresholdMinor} onChange={(v) => set("alertThresholdMinor", v)} />
						<OptionalField label="最小消耗（最小货币单位）" type="number" min="0" value={form.minimumSpendMinor} onChange={(v) => set("minimumSpendMinor", v)} />
						<OptionalField label="最小咨询数" type="number" min="0" value={form.minimumConsultations} onChange={(v) => set("minimumConsultations", v)} />
						<OptionalField label="处理期限（小时）" type="number" min="0" value={form.handlingDeadlineHours} onChange={(v) => set("handlingDeadlineHours", v)} />
						<OptionalField label="最多提醒轮数" type="number" min="1" value={form.maxPushRounds} onChange={(v) => set("maxPushRounds", v)} />
					</CardContent>
				</Card>

				{formError ? <p role="alert" className="text-sm text-red-600">保存失败：{formError}</p> : null}
				<div className="flex gap-2">
					<Button type="submit" disabled={save.isPending}>{save.isPending ? "保存中…" : creating ? "保存任务" : "保存新版本"}</Button>
					<Link to="/tasks" className="rounded-md border px-3 py-2 text-sm">取消</Link>
				</div>
			</form>
		</div>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return <label className="block space-y-1 text-sm"><span>{label}</span>{children}</label>;
}
function OptionalField({
	label,
	value,
	onChange,
	type = "text",
	min,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	type?: string;
	min?: string;
}) {
	return <Field label={label}><Input type={type} min={min} step={type === "number" ? 1 : undefined} value={value} onChange={(event) => onChange(event.target.value)} /></Field>;
}
