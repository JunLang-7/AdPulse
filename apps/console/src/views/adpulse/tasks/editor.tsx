import { ChevronRight } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { consoleClient } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { TaskSetupGuide } from "./task-setup-guide";
import {
	operationAfterSaveError,
	reduceTaskEditorState,
	reuseOperation,
	SaveResponseError,
} from "./editor-state.js";
import {
	emptyChannel,
	emptyForm,
	fromVersion,
	toInput,
	type ChannelForm,
	type FormState,
	type TaskInput,
} from "./task-form.js";

type SaveOperation =
	| {
			kind: "create";
			key: string;
			body: TaskInput;
			formSnapshot: FormState;
	  }
	| {
			kind: "revise";
			key: string;
			taskId: string;
			body: { expectedTaskVersion: number; task: TaskInput };
			formSnapshot: FormState;
	  };

export default function TaskEditorPage() {
	const { taskId } = useParams();
	const creating = taskId === "new";
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [editorState, dispatch] = useReducer(reduceTaskEditorState<FormState>, {
		form: emptyForm,
		version: null,
		dirty: false,
		remoteVersion: null,
	});
	const { form, version, dirty, remoteVersion } = editorState;
	const [formError, setFormError] = useState("");
	const [entryMode, setEntryMode] = useState<"guide" | "form">("guide");
	const guided = creating && entryMode === "guide";
	const [guideBusy, setGuideBusy] = useState(false);
	const operation = useRef<SaveOperation | null>(null);
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
		if (!creating && detail.data) {
			dispatch({
				type: "remote",
				version: detail.data.task.version,
				form: fromVersion(detail.data.task),
			});
		}
	}, [creating, detail.data]);

	const save = useMutation({
		mutationFn: async (request: SaveOperation) => {
			if (request.kind === "create") {
				const result = await consoleClient.POST("/api/tasks", {
					body: request.body,
					params: { header: { "Idempotency-Key": request.key } },
				});
				if (!result.data)
					throw new SaveResponseError(result.response.status, result.error);
				return result.data;
			}
			const result = await consoleClient.PATCH("/api/tasks/{taskId}", {
				params: {
					path: { taskId: request.taskId },
					header: { "Idempotency-Key": request.key },
				},
				body: request.body,
			});
			if (!result.data)
				throw new SaveResponseError(result.response.status, result.error);
			return result.data;
		},
		onSuccess: async (saved, request) => {
			if (operation.current?.key === request.key) operation.current = null;
			setFormError("");
			dispatch({
				type: "saved",
				version: saved.version,
				form: fromVersion(saved),
				submittedForm: request.formSnapshot,
			});
			await queryClient.invalidateQueries({ queryKey: ["tasks"] });
			await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
			if (creating) navigate(`/tasks/${saved.taskId}`);
		},
		onError: (error, request) => {
			operation.current = operationAfterSaveError(
				operation.current,
				request,
				error,
			);
			setFormError(String(error));
		},
	});

	function submitTask() {
		setFormError("");
		try {
			const request = reuseOperation(operation.current, () => {
				const formSnapshot = { ...form };
				const input = toInput(formSnapshot);
				if (creating) {
					return {
						kind: "create" as const,
						key: crypto.randomUUID(),
						body: input,
						formSnapshot,
					};
				}
				if (!taskId || version === null) throw new Error("任务尚未加载");
				return {
					kind: "revise" as const,
					key: crypto.randomUUID(),
					taskId,
					body: { expectedTaskVersion: version, task: input },
					formSnapshot,
				};
			});
			operation.current = request;
			save.mutate(request);
		} catch (error) {
			setFormError(String(error));
		}
	}

	function set<K extends keyof FormState>(key: K, value: FormState[K]) {
		dispatch({ type: "edit", form: { ...form, [key]: value } });
	}

	function editChannel(index: number, edit: Partial<ChannelForm>) {
		set("channels", form.channels.map((channel, position) =>
			position === index ? { ...channel, ...edit } : channel));
	}

	function changeMoneyMode(value: string) {
		const moneyMode = value === "cny" || value === "report" ? value : "";
		if (moneyMode === form.moneyMode) return;
		if ((form.alertThreshold || form.minimumSpend || (form.moneyMode === "report" && (form.currency || form.unit))) &&
			!window.confirm("切换金额填写方式会清空当前金额和币种设置。继续切换？")) return;
		dispatch({
			type: "edit",
			form: { ...form, moneyMode, currency: "", unit: "", alertThreshold: "", minimumSpend: "" },
		});
	}

	const rulesEntered = Boolean(form.metricKey || form.metricDefinition || form.moneyMode ||
		form.statWindowDays || form.minimumConsultations || form.handlingDeadlineHours || form.maxPushRounds);

	if (!creating && (detail.isLoading || !detail.data) && !detail.error)
		return <div className="p-6">正在加载任务…</div>;
	if (!creating && detail.error)
		return <div className="p-6 text-red-600">读取任务失败：{String(detail.error)}</div>;

	return (
		<div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
			<header className="space-y-2">
				<Link to="/tasks" className="text-sm text-muted-foreground hover:text-foreground">
					← 返回任务列表
				</Link>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h1 className="text-2xl font-bold tracking-tight">{creating ? "新建推广任务" : form.product || "推广任务"}</h1>
					{detail.data && !creating ? (
						<Link to={`/tasks/${detail.data.task.taskId}/review`} className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
							onClick={(event) => { if (dirty && !window.confirm("当前任务有未保存的修改，仍要前往查看推广效果吗？")) event.preventDefault(); }}>
							查看推广效果
						</Link>
					) : null}
				</div>
				<p className="text-sm text-muted-foreground">
					{creating ? "两种方式都只需填写产品或服务名称。目标、人群、卖点和渠道，知道多少就填多少。" : "记录当前推广计划。查看报表或对比成效时，打开推广效果。"}
				</p>
			</header>

			<form onSubmit={(event) => {
				event.preventDefault();
				if (!guided) submitTask();
			}} noValidate className="space-y-4">
				{creating ? (
					<div role="group" aria-label="任务填写方式" className="flex flex-wrap gap-2">
						<Button type="button" variant={guided ? "secondary" : "ghost"} aria-pressed={guided} disabled={guideBusy || save.isPending} onClick={() => setEntryMode("guide")}>分阶段填写</Button>
						<Button type="button" variant={!guided ? "secondary" : "ghost"} aria-pressed={!guided} disabled={guideBusy || save.isPending} onClick={() => setEntryMode("form")}>直接填表</Button>
					</div>
				) : null}
				{creating ? (
					<div hidden={!guided}>
						<TaskSetupGuide form={form} onChange={(nextForm) => dispatch({ type: "edit", form: nextForm })}
							onEdit={() => setEntryMode("form")} onSave={submitTask} onBusyChange={setGuideBusy} saving={save.isPending} />
					</div>
				) : null}
				<div hidden={guided} className="space-y-4">
					<Card>
						<CardContent className="grid gap-4 sm:grid-cols-2">
							<Field label="产品或服务名称" hint="必填">
								<Input required maxLength={200} placeholder="例如：新品试用装" value={form.product} onChange={(e) => set("product", e.target.value)} />
							</Field>
							<Field label="推广目标" hint="多个目标可换行">
								<textarea className={textAreaClass} rows={2} maxLength={2000} placeholder="例如：让更多客户来咨询" value={form.objective} onChange={(e) => set("objective", e.target.value)} />
							</Field>
						</CardContent>
					</Card>

					<div className="divide-y rounded-xl border bg-card">
						<OptionalSection title="人群与卖点" expanded={creating} summary={form.audience || form.sellingPoints ? "已填写" : ""}>
							<div className="grid gap-4 sm:grid-cols-2">
								<Field label="目标人群" hint="每行一项">
									<textarea className={textAreaClass} placeholder="例如：准备装修的新房业主" value={form.audience} onChange={(e) => set("audience", e.target.value)} />
								</Field>
								<Field label="主要卖点" hint="每行一项">
									<textarea className={textAreaClass} placeholder="例如：可以先领取免费样品" value={form.sellingPoints} onChange={(e) => set("sellingPoints", e.target.value)} />
								</Field>
							</div>
						</OptionalSection>

						<OptionalSection title="投放渠道" expanded={creating} summary={form.channels.length ? `${form.channels.length} 个渠道` : ""}>
							<div className="space-y-3">
								<p className="text-sm text-muted-foreground">{creating ? "已经确定在哪个平台推广时，可以添加渠道，例如小红书。" : "知道投放平台时，填渠道名称就够了。预算和出价请按后台已确认的数字填写。"}</p>
								{form.channels.map((channel, index) => (
									<div key={index} className="space-y-3 rounded-lg border p-3">
										<div className="flex items-center justify-between gap-2">
											<p className="text-sm font-medium">渠道 {index + 1}</p>
											<Button type="button" variant="ghost" size="sm" aria-label={`移除渠道 ${index + 1}`} onClick={() => set("channels", form.channels.filter((_, position) => position !== index))}>移除</Button>
										</div>
										<div className={creating ? "max-w-sm" : "grid gap-3 sm:grid-cols-2 lg:grid-cols-4"}>
											<Field label="渠道名称">
												<Input maxLength={128} placeholder="例如：小红书" value={channel.name} onChange={(e) => editChannel(index, { name: e.target.value })} />
											</Field>
											{creating ? null : <>
											<OptionalField label="预算金额" inputMode="decimal" value={channel.budget} onChange={(value) => editChannel(index, { budget: value })} />
											<OptionalField label="每次点击出价" inputMode="decimal" value={channel.bidCpc} onChange={(value) => editChannel(index, { bidCpc: value })} />
											<Field label="投放状态">
												<select className={selectClass} value={channel.enabled} onChange={(e) => editChannel(index, {
													enabled: e.target.value === "active" ? "active" : e.target.value === "paused" ? "paused" : "unknown",
												})}>
													<option value="unknown">暂不记录</option>
													<option value="active">投放中</option>
													<option value="paused">已暂停</option>
												</select>
											</Field>
											</>}
										</div>
									</div>
								))}
								<Button type="button" variant="outline" onClick={() => set("channels", [...form.channels, emptyChannel])}>添加渠道</Button>
							</div>
						</OptionalSection>

						{creating ? null : <>
						<OptionalSection title="观察范围与时间" summary={form.startsAt || form.endsAt || form.scope ? "已填写 · 北京时间" : "选填 · 北京时间"}>
							<div className="grid gap-4 sm:grid-cols-2">
								<p className="text-sm text-muted-foreground sm:col-span-2">想限定看哪次活动或哪段时间时再填。活动日期还没定，可以先创建任务。</p>
								<div className="sm:col-span-2">
									<Field label="想观察哪些投放？" hint="也可以先留空">
										<Input maxLength={1000} placeholder="例如：只看小红书的新品试用活动" value={form.scope} onChange={(e) => set("scope", e.target.value)} />
									</Field>
								</div>
								<Field label="开始时间（北京时间）"><Input type="datetime-local" step="any" value={form.startsAt} onChange={(e) => set("startsAt", e.target.value)} /></Field>
								<Field label="结束时间（北京时间）"><Input type="datetime-local" step="any" value={form.endsAt} onChange={(e) => set("endsAt", e.target.value)} /></Field>
							</div>
						</OptionalSection>

						<OptionalSection title="成本提醒条件" summary={rulesEntered ? "已填写部分或全部条件" : "选填 · 有明确标准再设"}>
							<div className="space-y-4">
								<p className="text-sm text-muted-foreground">先记任务也可以。等拿到第一份效果报表、确定每次咨询能花多少，再回来设置提醒。</p>
								<div className="grid gap-4 sm:grid-cols-2">
									<Field label="想关注什么成本？">
										<select className={selectClass} value={form.metricKey} onChange={(e) => set("metricKey", e.target.value === "cost_per_consultation" ? "cost_per_consultation" : "")}>
											<option value="">暂不设置</option>
											<option value="cost_per_consultation">单次咨询成本</option>
										</select>
									</Field>
									<Field label="金额填写方式">
										<select className={selectClass} value={form.moneyMode} onChange={(e) => changeMoneyMode(e.target.value)}>
											<option value="">暂不填写金额</option>
											<option value="cny">人民币（元）</option>
											<option value="report">其他金额口径（按报表）</option>
										</select>
									</Field>
									{form.moneyMode === "report" ? (
										<>
											<Field label="报表上的币种代码"><Input maxLength={16} value={form.currency} onChange={(e) => set("currency", e.target.value)} /></Field>
											<Field label="报表最小单位"><Input maxLength={32} value={form.unit} onChange={(e) => set("unit", e.target.value)} /></Field>
										</>
									) : null}
									{form.moneyMode ? (
										<>
											<OptionalField label={form.moneyMode === "cny" ? "超过多少元提醒？" : "提醒线（按报表最小单位）"} placeholder={form.moneyMode === "cny" ? "例如：70" : undefined} inputMode={form.moneyMode === "cny" ? "decimal" : "numeric"} value={form.alertThreshold} onChange={(value) => set("alertThreshold", value)} />
											<OptionalField label={form.moneyMode === "cny" ? "至少花到多少元才判断？" : "最低花费（按报表最小单位）"} placeholder={form.moneyMode === "cny" ? "填你认可的最低花费" : undefined} inputMode={form.moneyMode === "cny" ? "decimal" : "numeric"} value={form.minimumSpend} onChange={(value) => set("minimumSpend", value)} />
										</>
									) : null}
								</div>
								<details className="rounded-md border px-3 py-2">
									<summary className="cursor-pointer text-sm font-medium">更多提醒设置 · 按报表补齐</summary>
									<p className="my-2 text-sm text-muted-foreground">窗口和咨询口径请照报表填写。成本线、币种、统计窗口和样本条件都确定后，系统才能判断是否超出成本线。</p>
									<div className="grid gap-4 pb-1 sm:grid-cols-2">
										<Field label="按报表怎样统计咨询？"><Input maxLength={500} placeholder="例如：同一个客户只计一次" value={form.metricDefinition} onChange={(e) => set("metricDefinition", e.target.value)} /></Field>
										<OptionalField label="看几天的报表？" placeholder="例如：7 天的报表填 7" inputMode="numeric" value={form.statWindowDays} onChange={(value) => set("statWindowDays", value)} />
										<OptionalField label="至少收到几次咨询才判断？" placeholder="填你认可的最少次数" inputMode="numeric" value={form.minimumConsultations} onChange={(value) => set("minimumConsultations", value)} />
										<OptionalField label="通常希望多久处理？（小时）" placeholder="例如：12" inputMode="numeric" value={form.handlingDeadlineHours} onChange={(value) => set("handlingDeadlineHours", value)} />
										<OptionalField label="同一问题最多提醒几轮" placeholder="例如：1" inputMode="numeric" value={form.maxPushRounds} onChange={(value) => set("maxPushRounds", value)} />
									</div>
								</details>
							</div>
						</OptionalSection>
						</>}
					</div>
					{creating ? <p className="text-xs text-muted-foreground">预算、观察时间和成本提醒可在创建后设置。</p> : null}

				</div>

				{remoteVersion !== null ? (
					<p role="status" className="text-sm text-amber-700">
						这个任务在别处已经改到第 {remoteVersion} 版，你手上的是第 {version} 版。请先复制你的修改，再重新打开任务核对。
					</p>
				) : null}
				{operation.current && !save.isPending ? (
					<p role="status" className="text-sm text-muted-foreground">
						上次保存结果待确认。重试会先确认上次提交，之后的编辑留到下次保存。
					</p>
				) : null}
				{formError ? <p role="alert" className="text-sm text-red-600">保存失败：{formError}</p> : null}
				<div className="flex flex-wrap items-center gap-3">
					{guided ? null : (
						<Button type="submit" disabled={save.isPending}>
							{save.isPending ? "保存中…" : creating ? "创建任务" : "保存新版本"}
						</Button>
					)}
					<Link to="/tasks" className="rounded-md border px-3 py-2 text-sm">取消</Link>
					{dirty && !creating ? <span className="text-sm text-muted-foreground">有未保存的更改</span> : null}
				</div>
			</form>
			{!creating && taskId ? <DangerZone taskId={taskId} /> : null}

		</div>
	);
}

/**
 * 危险操作区（#40 S2）：显示保留期状态，并要求显式确认后才删除。
 * 删除后任务与其历史立即不可访问，因此成功后离开详情页。
 */
function DangerZone({ taskId }: { taskId: string }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const lifecycle = useQuery({
		queryKey: ["task-lifecycle", taskId],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/tasks/{taskId}/lifecycle", { params: { path: { taskId } } });
			if (!result.data) throw new Error(result.response.status === 404 ? "任务不可访问" : "无法读取保留期状态");
			return result.data;
		},
	});
	const remove = useMutation({
		mutationFn: async () => {
			const result = await consoleClient.DELETE("/api/tasks/{taskId}", { params: { path: { taskId } } });
			if (!result.data)
				throw Object.assign(new Error(
					result.response.status === 409
						? "删除请求正在处理，请稍后重试。"
						: result.response.status === 404 ? "任务不存在或已无权访问。" : "删除失败，请重试。",
				), { status: result.response.status });
			return result.data;
		},
		onSuccess: async (result) => {
			await queryClient.invalidateQueries({ queryKey: ["tasks"] });
			navigate("/tasks", {
				state: {
					taskNotice: result.created
						? "任务已删除，旧任务与其历史立即不可访问；相关待发提醒已取消。"
						: "该任务此前已删除，未重复处理。",
				},
			});
		},
	});
	const remainingDays = lifecycle.data
		? Math.max(0, Math.ceil((Date.parse(lifecycle.data.expiresAt) - Date.now()) / 86_400_000))
		: null;
	return (
		<Card className="mt-6 border-destructive/40">
			<CardContent className="space-y-3 p-4 text-sm">
				<div>
					<p className="font-medium">保留期与删除</p>
					<p className="text-xs text-muted-foreground">
						{lifecycle.isLoading ? "正在读取保留期…" : lifecycle.error ? "无法读取保留期状态；删除前请核对任务。" : (
							<>
								保留至 {lifecycle.data?.expiresAt.slice(0, 10)}（剩余 {remainingDays} 天）。
								到期后任务与证据自动不可访问；普通查看不会延长保留期。
							</>
						)}
					</p>
				</div>
				{confirming ? (
					<div className="space-y-2 rounded-md border border-destructive/40 p-3">
						<p className="text-destructive">删除后不可恢复：任务、证据、比较、告警与通知记录将立即不可访问，尚未发送的提醒会被取消。</p>
						<label className="flex items-start gap-2 text-sm">
							<input
								type="checkbox"
								className="mt-1"
								checked={acknowledged}
								onChange={(event) => setAcknowledged(event.target.checked)}
							/>
							<span>我了解删除后不可恢复，旧任务与其历史不能再访问。</span>
						</label>
						{remove.error ? <p role="alert" className="text-red-600">{(remove.error as Error).message}</p> : null}
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="destructive"
								disabled={!acknowledged || remove.isPending}
								onClick={() => remove.mutate()}
							>
								{remove.isPending ? "正在删除…" : "确认删除任务"}
							</Button>
							<Button type="button" variant="outline" onClick={() => { setConfirming(false); setAcknowledged(false); }}>
								取消
							</Button>
						</div>
					</div>
				) : (
					<Button type="button" variant="outline" onClick={() => setConfirming(true)}>删除任务…</Button>
				)}
			</CardContent>
		</Card>
	);
}

const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const textAreaClass = "min-h-20 w-full rounded-md border bg-background p-2 text-sm";

function OptionalSection({ title, summary, expanded = false, children }: {
	title: string; summary: string; expanded?: boolean; children: React.ReactNode;
}) {
	return (
		<details className="group" open={expanded || undefined}>
			<summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm marker:hidden">
				<ChevronRight aria-hidden="true" className="size-4 shrink-0 group-open:rotate-90" />
				<span className="font-medium">{title}</span>
				{summary ? <span className="ml-auto text-right text-xs text-muted-foreground">{summary}</span> : null}
			</summary>
			<div className="px-4 pb-4">{children}</div>
		</details>
	);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<label className="block space-y-1 text-sm">
			<span className="flex items-baseline gap-2 font-medium">
				{label}{hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
			</span>
			{children}
		</label>
	);
}

function OptionalField({ label, value, onChange, inputMode, placeholder }: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	inputMode: "numeric" | "decimal";
	placeholder?: string | undefined;
}) {
	return (
		<Field label={label}>
			<Input inputMode={inputMode} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
		</Field>
	);
}
