import { ChevronRight } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { consoleClient } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { EvidencePanel } from "./evidence-panel";
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
	formatBeijingTime,
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
				<h1 className="text-2xl font-bold tracking-tight">{creating ? "新建推广任务" : form.product || "推广任务"}</h1>
				<p className="text-sm text-muted-foreground">
					{creating ? "填一个产品或服务名称就能创建任务。投放细节可以随时补充。" : "在这里记录当前推广计划，下方可以查看效果数据。"}
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
							<Field label="推广什么？" hint="必填">
								<Input required maxLength={200} placeholder="例如：新品试用装" value={form.product} onChange={(e) => set("product", e.target.value)} />
							</Field>
							<Field label="想达成什么？" hint="选填">
								<Input maxLength={2000} placeholder="例如：让更多客户来咨询" value={form.objective} onChange={(e) => set("objective", e.target.value)} />
							</Field>
						</CardContent>
					</Card>

					<div className="divide-y rounded-xl border bg-card">
						<OptionalSection title="目标人群和卖点" summary={form.audience || form.sellingPoints ? "已填写" : "选填"}>
							<div className="grid gap-4 sm:grid-cols-2">
								<Field label="想触达谁？" hint="每行一项">
									<textarea className={textAreaClass} placeholder="例如：准备装修的新房业主" value={form.audience} onChange={(e) => set("audience", e.target.value)} />
								</Field>
								<Field label="客户为什么会感兴趣？" hint="每行一项">
									<textarea className={textAreaClass} placeholder="例如：可以先领取免费样品" value={form.sellingPoints} onChange={(e) => set("sellingPoints", e.target.value)} />
								</Field>
							</div>
						</OptionalSection>

						<OptionalSection title="投放渠道" summary={form.channels.length ? `${form.channels.length} 个渠道` : "选填"}>
							<div className="space-y-3">
								<p className="text-sm text-muted-foreground">知道投放平台时，填渠道名称就够了，例如小红书。预算和出价请按后台已确认的数字填写。</p>
								{form.channels.map((channel, index) => (
									<div key={index} className="space-y-3 rounded-lg border p-3">
										<div className="flex items-center justify-between gap-2">
											<p className="text-sm font-medium">渠道 {index + 1}</p>
											<Button type="button" variant="ghost" size="sm" aria-label={`移除渠道 ${index + 1}`} onClick={() => set("channels", form.channels.filter((_, position) => position !== index))}>移除</Button>
										</div>
										<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
											<Field label="渠道名称">
												<Input maxLength={128} placeholder="例如：小红书" value={channel.name} onChange={(e) => editChannel(index, { name: e.target.value })} />
											</Field>
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
										</div>
									</div>
								))}
								<Button type="button" variant="outline" onClick={() => set("channels", [...form.channels, emptyChannel])}>添加渠道</Button>
							</div>
						</OptionalSection>

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
					</div>

				</div>

				{remoteVersion !== null ? (
					<p role="status" className="text-sm text-amber-700">
						任务在别处更新到了 v{remoteVersion}。当前编辑仍基于 v{version}，请保留修改内容并重新打开任务核对。
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

			{detail.data && !creating ? (
				<>
					<EvidencePanel taskId={detail.data.task.taskId} taskVersion={detail.data.task.version} />
					<OptionalSection title="历史版本" summary={`${detail.data.versions.length} 个版本`}>
						<ul className="flex flex-wrap gap-2">
							{detail.data.versions.map((version) => (
								<li key={version.id} className="rounded border px-2 py-1 text-xs">
									v{version.version} · {formatBeijingTime(version.createdAt)}
								</li>
							))}
						</ul>
					</OptionalSection>
				</>
			) : null}
		</div>
	);
}

const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const textAreaClass = "min-h-20 w-full rounded-md border bg-background p-2 text-sm";

function OptionalSection({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
	return (
		<details className="group">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm marker:hidden">
				<ChevronRight aria-hidden="true" className="size-4 shrink-0 group-open:rotate-90" />
				<span className="font-medium">{title}</span>
				<span className="ml-auto text-right text-xs text-muted-foreground">{summary}</span>
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
