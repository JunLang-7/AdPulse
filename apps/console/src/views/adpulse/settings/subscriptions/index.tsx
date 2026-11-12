import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { consoleClient } from "../../../../adpulse-client";
import { Badge } from "../../../../components/ui/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../../components/ui/card";
import {
	CATEGORY_OPTIONS,
	KIND_OPTIONS,
	SCOPE_OPTIONS,
	type NotificationStatusLike,
	type Readiness,
	type SubscriptionCategory,
	type SubscriptionKind,
	type SubscriptionScope,
	type SubscriptionTargetLike,
	type SubscriptionViewLike,
	activeTargets,
	confirmationSummary,
	describeReadiness,
	errorText,
	formatSchedule,
	kindLabel,
	savedNotice,
	describeSettingsFeedback,
	validateScheduleDraft,
	validateTargetDraft,
} from "./subscription-view";

type TaskOption = { taskId: string; product: string };

const statusOf = (error: unknown): number =>
	(error as { status?: number } | null)?.status ?? 0;

const failure = (error: unknown) =>
	error ? errorText(statusOf(error)) : null;

/** 新增/编辑关注对象的表单。 */
function TargetForm({
	tasks,
	disabled,
	onSubmit,
}: {
	tasks: TaskOption[];
	disabled: boolean;
	onSubmit: (draft: {
		kind: SubscriptionKind;
		taskId?: string;
		label?: string;
		sourceUrl?: string;
		categories: SubscriptionCategory[];
		scope: SubscriptionScope;
	}) => Promise<void>;
}) {
	const [kind, setKind] = useState<SubscriptionKind>("task");
	const [taskId, setTaskId] = useState("");
	const [label, setLabel] = useState("");
	const [sourceUrl, setSourceUrl] = useState("");
	const [categories, setCategories] = useState<SubscriptionCategory[]>([
		"effect",
		"event",
	]);
	const [scope, setScope] = useState<SubscriptionScope>("task_only");
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		const draft = { kind, taskId, label, sourceUrl, categories, scope };
		const invalid = validateTargetDraft(draft);
		if (invalid) {
			setError(invalid);
			return;
		}
		setError(null);
		try {
			await onSubmit(draft);
			setTaskId("");
			setLabel("");
			setSourceUrl("");
		} catch (thrown) {
			setError(failure(thrown) ?? "添加失败");
		}
	};

	return (
		<div className="space-y-3 rounded-md border border-dashed p-4">
			<p className="text-sm font-medium">添加关注对象</p>
			<div className="flex flex-wrap gap-2">
				{KIND_OPTIONS.map((option) => (
					<button
						key={option.value}
						type="button"
						onClick={() => setKind(option.value)}
						className={
							kind === option.value
								? "rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
								: "rounded-md border px-3 py-1.5 text-sm"
						}
					>
						{option.label}
					</button>
				))}
			</div>

			{kind === "task" ? (
				<label className="block text-sm">
					<span className="text-muted-foreground">选择任务</span>
					<select
						value={taskId}
						onChange={(event) => setTaskId(event.target.value)}
						className="mt-1 w-full rounded-md border px-3 py-2"
					>
						<option value="">请选择</option>
						{tasks.map((task) => (
							<option key={task.taskId} value={task.taskId}>
								{task.product}
							</option>
						))}
					</select>
					{tasks.length === 0 ? (
						<span className="mt-1 block text-xs text-muted-foreground">
							还没有任务。先创建任务，再回来添加关注。
						</span>
					) : null}
				</label>
			) : (
				<div className="grid gap-2 sm:grid-cols-2">
					<label className="block text-sm">
						<span className="text-muted-foreground">名称</span>
						<input
							value={label}
							onChange={(event) => setLabel(event.target.value)}
							maxLength={40}
							placeholder={kind === "brand" ? "例如：某某灯饰" : "例如：某竞品型号"}
							className="mt-1 w-full rounded-md border px-3 py-2"
						/>
					</label>
					<label className="block text-sm">
						<span className="text-muted-foreground">来源链接（可选）</span>
						<input
							value={sourceUrl}
							onChange={(event) => setSourceUrl(event.target.value)}
							placeholder="https://…"
							className="mt-1 w-full rounded-md border px-3 py-2"
						/>
					</label>
				</div>
			)}

			<fieldset className="space-y-1">
				<legend className="text-sm text-muted-foreground">接收类别</legend>
				{CATEGORY_OPTIONS.map((option) => (
					<label key={option.value} className="flex items-start gap-2 text-sm">
						<input
							type="checkbox"
							checked={categories.includes(option.value)}
							onChange={(event) =>
								setCategories((current) =>
									event.target.checked
										? [...current, option.value]
										: current.filter((item) => item !== option.value),
								)
							}
							className="mt-1"
						/>
						<span>
							{option.label}
							<span className="ml-1 text-xs text-muted-foreground">{option.hint}</span>
						</span>
					</label>
				))}
			</fieldset>

			<fieldset className="space-y-1">
				<legend className="text-sm text-muted-foreground">关联范围</legend>
				{SCOPE_OPTIONS.map((option) => (
					<label key={option.value} className="flex items-start gap-2 text-sm">
						<input
							type="radio"
							name="scope"
							checked={scope === option.value}
							onChange={() => setScope(option.value)}
							className="mt-1"
						/>
						<span>
							{option.label}
							<span className="ml-1 text-xs text-muted-foreground">{option.hint}</span>
						</span>
					</label>
				))}
			</fieldset>

			{error ? (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			) : null}

			<button
				type="button"
				disabled={disabled}
				onClick={() => void submit()}
				className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
			>
				添加
			</button>
		</div>
	);
}

/** 单个关注对象：类别与范围可就地修改，退订/恢复不丢配置。 */
function TargetRow({
	target,
	version,
	disabled,
	onPatch,
}: {
	target: SubscriptionTargetLike;
	version: number;
	disabled: boolean;
	onPatch: (patch: {
		categories?: SubscriptionCategory[];
		scope?: SubscriptionScope;
		status?: "active" | "muted";
	}) => Promise<void>;
}) {
	const [error, setError] = useState<string | null>(null);
	const muted = target.status === "muted";
	const patch = async (body: Parameters<typeof onPatch>[0]) => {
		setError(null);
		try {
			await onPatch(body);
		} catch (thrown) {
			setError(failure(thrown));
		}
	};

	return (
		<li className={`rounded-md border p-3 ${muted ? "opacity-70" : ""}`}>
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<p className="text-sm font-medium">
						{target.label}
						<span className="ml-2 text-xs text-muted-foreground">
							{kindLabel(target.kind, target.kindLabel)}
						</span>
					</p>
					{target.sourceUrl ? (
						<a
							href={target.sourceUrl}
							target="_blank"
							rel="noreferrer"
							className="text-xs text-blue-600 underline"
						>
							来源
						</a>
					) : null}
				</div>
				<Badge variant={muted ? "outline" : "secondary"}>
					{muted ? "已退订" : "接收中"}
				</Badge>
			</div>

			<div className="mt-2 flex flex-wrap gap-3 text-sm">
				{CATEGORY_OPTIONS.map((option) => {
					const checked = target.categories.includes(option.value);
					return (
						<label key={option.value} className="flex items-center gap-1">
							<input
								type="checkbox"
								checked={checked}
								disabled={disabled}
								onChange={() => {
									const next = checked
										? target.categories.filter((item) => item !== option.value)
										: [...target.categories, option.value];
									if (next.length === 0) {
										setError("至少保留一个类别；要停止接收请直接退订该对象。");
										return;
									}
									void patch({ categories: next });
								}}
							/>
							{option.label}
						</label>
					);
				})}
			</div>

			<div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
				<span className="text-muted-foreground">范围</span>
				<select
					value={target.scope}
					disabled={disabled}
					onChange={(event) =>
						void patch({ scope: event.target.value as SubscriptionScope })
					}
					className="rounded-md border px-2 py-1"
				>
					{SCOPE_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				<button
					type="button"
					disabled={disabled}
					onClick={() => void patch({ status: muted ? "active" : "muted" })}
					className="rounded-md border px-2 py-1 text-sm disabled:opacity-50"
				>
					{muted ? "恢复接收" : "退订这个对象"}
				</button>
				<span className="text-xs text-muted-foreground">v{version}</span>
			</div>

			{error ? (
				<p role="alert" className="mt-2 text-sm text-red-600">
					{error}
				</p>
			) : null}
		</li>
	);
}

export default function SubscriptionSettingsPage() {
	const queryClient = useQueryClient();
	const [notice, setNotice] = useState<string | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [decisionConfirmOpen, setDecisionConfirmOpen] = useState(false);
	const [scheduleDraft, setScheduleDraft] = useState<{
		digestAt: string;
		quietStart: string;
		quietEnd: string;
	} | null>(null);
	const [scheduleError, setScheduleError] = useState<string | null>(null);

	const subscription = useQuery({
		queryKey: ["subscription"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/me/subscription");
			if (!result.data) throw new Error("subscription unavailable");
			return result.data as unknown as SubscriptionViewLike;
		},
	});
	const notification = useQuery({
		queryKey: ["notification-status"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/me/notification-status");
			if (!result.data) throw new Error("notification unavailable");
			return result.data as unknown as NotificationStatusLike;
		},
	});
	const tasks = useQuery({
		queryKey: ["tasks"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/tasks");
			if (!result.data) return [];
			return result.data.items as unknown as TaskOption[];
		},
	});

	const invalidate = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["subscription"] }),
			queryClient.invalidateQueries({ queryKey: ["notification-status"] }),
		]);

	const currentVersion = subscription.data?.settings.version ?? 0;

	const updateSettings = useMutation({
		mutationFn: async (body: {
			proactiveEnabled?: boolean;
			decisionCardsEnabled?: boolean;
			schedule?: {
				timezone: "Asia/Shanghai";
				digestAt: string;
				quietStart: string;
				quietEnd: string;
			};
		}) => {
			const result = await consoleClient.PUT("/api/me/subscription/settings", {
				body: { expectedVersion: currentVersion, ...body },
			});
			if (result.error)
				throw Object.assign(new Error("settings failed"), {
					status: result.response.status,
				});
			return result.data as unknown as SubscriptionViewLike;
		},
		onMutate: () => {
			// 操作开始先清掉上一次的结果，避免旧成功提示与本次失败并存。
			setNotice(null);
		},
		onSuccess: (data, variables) => {
			setNotice(
				variables.decisionCardsEnabled !== undefined
					? variables.decisionCardsEnabled
						? "已记录决策卡确认；本版本尚未接通投递，不会补发历史候选。"
						: "已关闭决策卡偏好；日汇总设置不变。"
					: variables.proactiveEnabled === true
						? "已开启订阅推送。"
						: variables.proactiveEnabled === false
							? "已关闭订阅推送；不会生成新的通知。"
							: savedNotice(data),
			);
			setConfirmOpen(false);
			setDecisionConfirmOpen(false);
			return invalidate();
		},
	});

	const addTarget = useMutation({
		mutationFn: async (draft: {
			kind: SubscriptionKind;
			taskId?: string;
			label?: string;
			sourceUrl?: string;
			categories: SubscriptionCategory[];
			scope: SubscriptionScope;
		}) => {
			const result = await consoleClient.POST("/api/me/subscription/targets", {
				body: {
					expectedVersion: currentVersion,
					kind: draft.kind,
					...(draft.kind === "task" ? { refId: draft.taskId } : {}),
					...(draft.kind !== "task" && draft.label ? { label: draft.label.trim() } : {}),
					...(draft.sourceUrl?.trim() ? { sourceUrl: draft.sourceUrl.trim() } : {}),
					categories: draft.categories,
					scope: draft.scope,
				},
			});
			if (result.error)
				throw Object.assign(new Error("add failed"), {
					status: result.response.status,
				});
			return result.data;
		},
		onSuccess: () => {
			setNotice("已添加关注对象。");
			return invalidate();
		},
	});

	const patchTarget = useMutation({
		mutationFn: async ({
			id,
			body,
		}: {
			id: string;
			body: {
				categories?: SubscriptionCategory[];
				scope?: SubscriptionScope;
				status?: "active" | "muted";
			};
		}) => {
			const result = await consoleClient.PATCH(
				"/api/me/subscription/targets/{targetId}",
				{
					params: { path: { targetId: id } },
					body: { expectedVersion: currentVersion, ...body },
				},
			);
			if (result.error)
				throw Object.assign(new Error("patch failed"), {
					status: result.response.status,
				});
			return result.data;
		},
		onSuccess: async (_data, variables) => {
			setNotice(
				variables.body.status === "muted"
					? "已退订该关注对象；配置保留，可随时恢复。"
					: "已更新关注对象。",
			);
			await invalidate();
		},
	});

	if (subscription.isLoading || notification.isLoading)
		return <div className="p-6">正在读取订阅设置…</div>;
	if (subscription.error || !subscription.data || !notification.data)
		return (
			<div className="p-6 text-red-600">
				读取订阅设置失败：{String(subscription.error ?? notification.error)}
			</div>
		);

	const data = subscription.data;
	const readiness: Readiness = describeReadiness(data, notification.data);
	const schedule = formatSchedule(data.settings.schedule);
	const draft =
		scheduleDraft ?? {
			digestAt: data.settings.schedule.digestAt,
			quietStart: data.settings.schedule.quietStart,
			quietEnd: data.settings.schedule.quietEnd,
		};
	const summary = confirmationSummary(data);
	const settingsFeedback = describeSettingsFeedback({
		pending: updateSettings.isPending,
		errorStatus: updateSettings.error ? statusOf(updateSettings.error) : null,
		notice,
	});
	const busy =
		updateSettings.isPending || addTarget.isPending || patchTarget.isPending;

	return (
		<div className="p-6 space-y-4">
			<div>
				<h1 className="text-2xl font-bold">订阅与关注</h1>
				<p className="text-sm text-muted-foreground">
					决定关注哪些任务、品牌或竞品，以及接收哪几类信息。保存配置不会发送任何消息。
				</p>
			</div>

			<Card className="max-w-3xl">
				<CardHeader>
					<div className="flex items-start justify-between gap-3">
						<CardTitle>{readiness.title}</CardTitle>
						<Badge variant={readiness.canDeliver ? "secondary" : "outline"}>
							{readiness.canDeliver ? "会收到提醒" : "不会收到提醒"}
						</Badge>
					</div>
				</CardHeader>
				<CardContent className="space-y-3">
					<p className="text-sm text-muted-foreground">{readiness.detail}</p>
					{/* 四项状态分开显示：配置、地址、授权、推送开关互不冒充。 */}
					<dl className="grid gap-2 text-sm sm:grid-cols-2">
						<div className="flex items-baseline justify-between gap-3">
							<dt className="text-muted-foreground">订阅配置</dt>
							<dd>v{data.settings.version}（{data.targets.length} 个关注对象）</dd>
						</div>
						<div className="flex items-baseline justify-between gap-3">
							<dt className="text-muted-foreground">单聊地址</dt>
							<dd>
								{notification.data.destination
									? notification.data.destination.status === "verified"
										? "已确认"
										: "已失效"
									: "未确认"}
							</dd>
						</div>
						<div className="flex items-baseline justify-between gap-3">
							<dt className="text-muted-foreground">主动提醒授权</dt>
							<dd>
								{notification.data.consent?.status === "active"
									? "已授权"
									: notification.data.consent
										? "已撤销"
										: "未授权"}
							</dd>
						</div>
						<div className="flex items-baseline justify-between gap-3">
							<dt className="text-muted-foreground">订阅推送开关</dt>
							<dd>{data.settings.proactiveEnabled ? "已开启" : "未开启"}</dd>
						</div>
					</dl>

					{settingsFeedback.notice ? (
						<p role="status" className="text-sm text-emerald-700">
							{settingsFeedback.notice}
						</p>
					) : null}
					{settingsFeedback.failure ? (
						<p role="alert" className="text-sm text-red-600">
							{settingsFeedback.failure}
						</p>
					) : null}

					<div className="flex flex-wrap gap-2">
						{data.settings.proactiveEnabled ? (
							<button
								type="button"
								disabled={busy}
								onClick={() => updateSettings.mutate({ proactiveEnabled: false })}
								className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-600 disabled:opacity-50"
							>
								关闭全部主动推送
							</button>
						) : (
							<button
								type="button"
								disabled={busy}
								onClick={() => setConfirmOpen(true)}
								className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
							>
								配置并开启
							</button>
						)}
					</div>
				</CardContent>
			</Card>

			<Card className="max-w-3xl">
				<CardHeader>
					<CardTitle>决策卡单独确认</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<p className="text-sm">
						{data.settings.decisionCards?.enabled ? "已记录单独确认" : "尚未单独确认"}
					</p>
					<p className="text-sm text-muted-foreground">
						本版本仅保存偏好，尚未接通决策卡投递。日汇总授权不自动开启决策卡。
						后续投递仍须满足全部推送开关、本人授权、关注范围、免打扰与候选有效期。
						不会补发历史 Web 候选；关闭后重新确认只考虑重新确认之后的新候选。
					</p>
					{data.settings.decisionCards?.enabled ? (
						<button
							type="button"
							disabled={busy}
							onClick={() => updateSettings.mutate({ decisionCardsEnabled: false })}
							className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
						>
							关闭决策卡偏好
						</button>
					) : decisionConfirmOpen ? (
						<div className="space-y-2">
							<p className="text-sm">
								确认只记录本人决策卡偏好，不改变日汇总或通知授权，也不会立即发送消息。
							</p>
							<div className="flex flex-wrap gap-2">
								<button
									type="button"
									disabled={busy}
									onClick={() =>
										updateSettings.mutate({ decisionCardsEnabled: true })
									}
									className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
								>
									{updateSettings.isPending ? "正在记录…" : "确认记录决策卡偏好"}
								</button>
								<button
									type="button"
									disabled={busy}
									onClick={() => setDecisionConfirmOpen(false)}
									className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
								>
									暂不确认决策卡
								</button>
							</div>
						</div>
					) : (
						<button
							type="button"
							disabled={busy}
							onClick={() => setDecisionConfirmOpen(true)}
							className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
						>
							了解并单独确认决策卡
						</button>
					)}
				</CardContent>
			</Card>

			{confirmOpen ? (
				<Card className="max-w-3xl border-primary/40">
					<CardHeader>
						<CardTitle>开启前请确认</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<ul className="list-disc space-y-1 pl-5 text-sm">
							{summary.lines.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
						{summary.warning ? (
							<p role="alert" className="text-sm text-amber-600">
								{summary.warning}
							</p>
						) : null}
						<p className="text-xs text-muted-foreground">
							开启只影响主动推送；登录、地址与授权都不变，随时可以关闭。
						</p>
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								disabled={busy}
								onClick={() => updateSettings.mutate({ proactiveEnabled: true })}
								className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
							>
								{settingsFeedback.confirmLabel}
							</button>
							<button
								type="button"
								disabled={!settingsFeedback.dismissEnabled}
								title={
									settingsFeedback.dismissEnabled
										? undefined
										: "开启请求正在提交，请等待结果后再操作"
								}
								onClick={() => {
									setConfirmOpen(false);
									setNotice("已选择暂不开启；不会发送任何主动推送。");
								}}
								className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
							>
								{settingsFeedback.dismissEnabled ? "暂不开启" : "请稍候…"}
							</button>
						</div>
					</CardContent>
				</Card>
			) : null}

			<Card className="max-w-3xl">
				<CardHeader>
					<CardTitle>推送时间</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<p className="text-sm text-muted-foreground">
						{schedule.digest}，{schedule.quiet}；{schedule.timezoneNote}
					</p>
					<div className="grid gap-2 sm:grid-cols-3">
						{(
							[
								["digestAt", "汇总时间"],
								["quietStart", "免打扰开始"],
								["quietEnd", "免打扰结束"],
							] as const
						).map(([key, label]) => (
							<label key={key} className="block text-sm">
								<span className="text-muted-foreground">{label}</span>
								<input
									type="time"
									value={draft[key]}
									onChange={(event) =>
										setScheduleDraft({ ...draft, [key]: event.target.value })
									}
									className="mt-1 w-full rounded-md border px-3 py-2"
								/>
							</label>
						))}
					</div>
					{scheduleError ? (
						<p role="alert" className="text-sm text-red-600">
							{scheduleError}
						</p>
					) : null}
					<button
						type="button"
						disabled={busy}
						onClick={async () => {
							const invalid = validateScheduleDraft(draft);
							if (invalid) {
								setScheduleError(invalid);
								return;
							}
							setScheduleError(null);
							setNotice(null);
							try {
								await updateSettings.mutateAsync({
									schedule: {
										timezone: data.settings.schedule
											.timezone as "Asia/Shanghai",
										...draft,
									},
								});
								setScheduleDraft(null);
							} catch {
								/* 失败文案由 settingsFeedback.failure 统一展示，这里不再吞掉 */
							}
						}}
						className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
					>
						保存时间
					</button>
					<p className="text-xs text-muted-foreground">
						首期只支持北京时间，不支持跨时区；汇总时间不能落在免打扰时段内。
					</p>
				</CardContent>
			</Card>

			<Card className="max-w-3xl">
				<CardHeader>
					<CardTitle>
						关注对象（生效 {activeTargets(data.targets).length} / 共{" "}
						{data.targets.length}）
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					{data.targets.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							还没有关注对象。添加后才会收到对应类别的信息。
						</p>
					) : (
						<ul className="space-y-2">
							{data.targets.map((target) => (
								<TargetRow
									key={target.id}
									target={target}
									version={data.settings.version}
									disabled={busy}
									onPatch={async (body) => {
										await patchTarget.mutateAsync({ id: target.id, body });
									}}
								/>
							))}
						</ul>
					)}

					<TargetForm
						tasks={tasks.data ?? []}
						disabled={busy || addTarget.isPending}
						onSubmit={async (form) => {
							await addTarget.mutateAsync(form);
						}}
					/>

					<p className="text-xs text-muted-foreground">
						退订某个对象会保留它的配置，可随时恢复；关闭全部主动推送不会退出登录。
						推送内容的分拣与发送由后续版本实现，本页只保存你的偏好。
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
