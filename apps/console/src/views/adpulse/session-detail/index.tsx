import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, CircleDot } from "lucide-react";
import { useEffect, useReducer } from "react";
import { Link, useParams } from "react-router";
import { consoleClient } from "../../../adpulse-client";
import { Badge } from "../../../components/ui/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { cn } from "../../../lib/utils";
import { formatTime, isExpired, roundStatus, sessionStatus } from "../status";

export default function SessionDetailPage() {
	const { sessionId = "" } = useParams();

	const { data, isLoading, error } = useQuery({
		queryKey: ["session", sessionId],
		enabled: sessionId.length > 0,
		queryFn: async () => {
			const result = await consoleClient.GET("/api/sessions/{sessionId}", {
				params: { path: { sessionId } },
			});
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data;
		},
	});

	const activeWebRound = data?.session.deliveryMode === "web" &&
		data.session.status === "awaiting_input"
		? data.rounds.find((round) => round.roundNo === data.session.roundNo)
		: undefined;
	const expiresAt = activeWebRound?.expiresAt;
	const [, refreshExpiry] = useReducer((revision: number) => revision + 1, 0);
	useEffect(() => {
		const remaining = Date.parse(expiresAt ?? "") - Date.now();
		if (!(remaining > 0)) return;
		const timer = window.setTimeout(refreshExpiry, remaining);
		return () => window.clearTimeout(timer);
	}, [expiresAt]);

	if (isLoading) return <div className="p-6">正在加载会话详情…</div>;
	if (error) return <div className="p-6 text-red-600">{String(error)}</div>;
	if (!data) return <div className="p-6">没有找到该会话。</div>;

	const session = data.session;
	const status = sessionStatus(session.status);
	const expired = isExpired(session.expiresAt) || isExpired(expiresAt);
	const baselineSnapshot = [...data.snapshots].sort(
		(a, b) => a.version - b.version,
	)[0];
	const baselineStrategy = baselineSnapshot?.strategy as
		| StrategyView
		| undefined;
	const diffs = baselineStrategy
		? describeStrategyDiff(
				baselineStrategy,
				session.strategy as StrategyView,
			)
		: [];

	return (
		<div className="p-6 space-y-4">
			<Link
				to="/sessions"
				className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
			>
				<ArrowLeft className="size-4" />
				返回会话列表
			</Link>

			<div className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<h1 className="text-2xl font-bold">{session.signal.title}</h1>
					<Badge variant={status.variant} className={status.className}>
						{status.label}
					</Badge>
					{expired ? <Badge variant="destructive">已过期</Badge> : null}
				</div>
				<p className="text-sm text-muted-foreground">
					{session.signal.summary}
				</p>
				<div className="flex flex-wrap items-center gap-1.5">
					<Badge variant="outline">第 {session.roundNo} 轮</Badge>
					<Badge variant="outline">策略第 {session.version} 版</Badge>
					<Badge variant="outline">
						{session.deliveryMode === "web"
							? "网页待处理"
							: session.recipient?.kind === "group"
								? "群聊"
								: "单聊"}
					</Badge>
					{session.expiresAt ? (
						<Badge variant="outline">到期 {formatTime(session.expiresAt)}</Badge>
					) : null}
					{session.taskRef ? (
						<Link to={`/tasks/${session.taskRef.taskId}`}>
							<Badge variant="outline">基于任务第 {session.taskRef.taskVersion} 版</Badge>
						</Link>
					) : null}
				</div>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>当前方案</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2">
					<p className="text-sm">
						推广目标：{session.strategy.objective || "未填写"}
					</p>
					<StrategyValues label="人群" values={session.strategy.audience} />
					<StrategyValues
						label="卖点"
						values={session.strategy.sellingPoints}
					/>
					<StrategyValues
						label="内容方向"
						values={session.strategy.contentDirections}
					/>
					<StrategyValues
						label="合作对象"
						values={session.strategy.partners}
					/>
					<div className="space-y-1">
						<p className="text-sm text-muted-foreground">渠道：</p>
						{Object.keys(session.strategy.channels ?? {}).length === 0 ? (
							<p className="text-sm text-muted-foreground">未填写</p>
						) : (
							Object.entries(session.strategy.channels ?? {}).map(
								([name, channel]) => (
									<p
										key={name}
										className="break-all text-xs text-muted-foreground"
									>
										{name}：预算 {channel.budget ?? "未设置"} · 出价{" "}
										{channel.bidCpc ?? "未设置"} ·{" "}
										{channel.enabled === undefined
											? "启停未设置"
											: channel.enabled
												? "启用"
												: "暂停"}
									</p>
								),
							)
						)}
					</div>
				</CardContent>
			</Card>

			{baselineStrategy ? (
				<Card>
					<CardHeader>
						<CardTitle>与最早快照相比</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2">
						{diffs.length ? (
							diffs.map((row) => (
								<p
									key={row}
									className="break-all text-xs text-muted-foreground"
								>
									{row}
								</p>
							))
						) : (
							<p className="text-sm text-muted-foreground">方案无变化</p>
						)}
					</CardContent>
				</Card>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>轮次时间线</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					{data.rounds.length === 0 ? (
						<p className="text-sm text-muted-foreground">还没有生成轮次。</p>
					) : null}
					{data.rounds.map((round) => {
						const candidates = (round.candidates ?? []) as Array<{
							id: string;
							label: string;
							hypothesis?: string;
							validationPlan?: string;
						}>;
						const actions = (data.actions ?? []).filter(
							(a) => a.roundId === round.id,
						);
						const state = roundStatus(round.status);
						const isCurrent =
							round.roundNo === session.roundNo &&
							session.status === "awaiting_input";
						return (
							<div
								key={round.id}
								className="rounded-lg border border-border p-4 space-y-3"
							>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div className="flex items-center gap-2">
										<CircleDot className="size-4 text-muted-foreground" />
										<span className="font-medium">第 {round.roundNo} 轮</span>
										<Badge variant={state.variant} className={state.className}>
											{state.label}
										</Badge>
										{isCurrent ? <Badge variant="secondary">当前</Badge> : null}
									</div>
									<span className="text-xs text-muted-foreground">
										{round.respondedAt
											? `已响应 ${formatTime(round.respondedAt)}`
											: round.status === "invalidated"
												? `已失效${round.invalidationReason ? ` · ${round.invalidationReason}` : ""}`
												: round.expiresAt
													? session.deliveryMode === "web"
														? `按钮可操作至 ${formatTime(round.expiresAt, "Asia/Shanghai")}（北京时间）`
														: `到期 ${formatTime(round.expiresAt)}`
													: session.deliveryMode === "web"
														? "由系统核验按钮有效期"
														: "无到期时间"}
									</span>
								</div>

								<div className="space-y-1">
									<p className="text-sm font-medium">{round.card?.title}</p>
									<p className="text-sm text-muted-foreground">
										{round.card?.summary}
									</p>
									{(round.card?.evidence ?? []).length > 0 ? (
										<div className="flex flex-wrap gap-1.5 pt-1">
											{(round.card?.evidence ?? []).map((item) => (
												<Badge key={item.label} variant="outline">
													{item.label}：{item.value}
												</Badge>
											))}
										</div>
									) : null}
								</div>

								<div className="flex flex-wrap gap-2">
									{candidates.map((candidate) => {
										const action = actions.find(
											(a) => a.optionId === candidate.id,
										);
										return (
											<OptionChip
												key={candidate.id}
												label={candidate.label}
												selected={round.selectedOptionId === candidate.id}
												actionRef={
													round.status === "open" && isCurrent && !expired
														? action?.id
														: undefined
												}
											/>
										);
									})}
								</div>

								{candidates.map((candidate) => {
									const detail = [
										candidate.hypothesis ? `假设：${candidate.hypothesis}` : "",
										candidate.validationPlan ? `验证：${candidate.validationPlan}` : "",
									]
										.filter(Boolean)
										.join("；");
									return detail ? (
										<p
											key={`${candidate.id}:detail`}
											className="text-xs text-muted-foreground"
										>
											{candidate.label}：{detail}
										</p>
									) : null;
								})}
							</div>
						);
					})}
				</CardContent>
			</Card>

			<div className="grid gap-4 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>投递</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm">
						{data.deliveries.length === 0 ? (
							<p className="text-muted-foreground">暂无投递记录。</p>
						) : null}
						{data.deliveries.map((delivery) => (
							<div
								key={delivery.id}
								className="flex items-center justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0"
							>
								<span className="flex items-center gap-2">
									<Badge variant="outline">
										{delivery.purpose === "confirmation" ? "确认卡" : "决策卡"}
									</Badge>
									<Badge variant={deliveryVariant(delivery.status)}>
										{deliveryLabel(delivery.status)}
									</Badge>
								</span>
								<span className="text-xs text-muted-foreground truncate">
									{delivery.sentAt
										? formatTime(delivery.sentAt)
										: delivery.lastError || "—"}
								</span>
							</div>
						))}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>策略变更记录</CardTitle>
						<p className="text-xs text-muted-foreground">
							当前可记录：渠道预算/出价/开关，以及人群、卖点、内容方向、合作对象的增删；不记录合作阶段与效果指标。
						</p>
					</CardHeader>
					<CardContent className="space-y-3 text-sm">
						{data.snapshots.map((snapshot) => (
							<div
								key={snapshot.id}
								className="space-y-1 border-b border-border pb-2 last:border-0 last:pb-0"
							>
								<div className="flex items-center justify-between gap-2">
									<span>第 {snapshot.version} 版</span>
									<span className="text-xs text-muted-foreground">
										{snapshot.changes.length === 0
											? "无变更"
											: `${snapshot.changes.length} 项变更`}
										{" · "}
										{formatTime(snapshot.createdAt)}
									</span>
								</div>
								{snapshot.changes.map((change, index) => (
									<p
										key={`${snapshot.id}:${index}`}
										// 渠道名可达 128 字符且多为无空格 token：强制断词，避免被卡片的 overflow-hidden 裁掉。
										className="break-all text-xs text-muted-foreground"
									>
										{changeLabel(change)}
									</p>
								))}
								{snapshot.hypothesis || snapshot.validationPlan ? (
									<p className="text-xs text-muted-foreground">
										{[
											snapshot.hypothesis
												? `假设：${snapshot.hypothesis}`
												: "",
											snapshot.validationPlan
												? `验证：${snapshot.validationPlan}`
												: "",
										]
											.filter(Boolean)
											.join("；")}
									</p>
								) : null}
							</div>
						))}
					</CardContent>
				</Card>
			</div>
		</div>
	);
}

/** 策略变更的人话描述：渠道数值用「原值 → 新值」，列表字段用增删。 */
type StrategyView = {
	objective?: string;
	audience?: string[];
	sellingPoints?: string[];
	contentDirections?: string[];
	partners?: string[];
	channels?: Record<
		string,
		{ budget?: number; bidCpc?: number; enabled?: boolean }
	>;
};

/** 只列变化项：列表看增删，渠道看数值/开关，不把未变字段铺满界面。 */
function describeStrategyDiff(
	before: StrategyView,
	after: StrategyView,
): string[] {
	const rows: string[] = [];
	if ((before.objective ?? "") !== (after.objective ?? ""))
		rows.push(
			`推广目标：${before.objective ?? "未填写"} → ${after.objective ?? "未填写"}`,
		);
	const lists: Array<[string[] | undefined, string[] | undefined, string]> = [
		[before.audience, after.audience, "人群"],
		[before.sellingPoints, after.sellingPoints, "卖点"],
		[before.contentDirections, after.contentDirections, "内容方向"],
		[before.partners, after.partners, "合作对象"],
	];
	for (const [oldValues, newValues, label] of lists) {
		const oldList = oldValues ?? [];
		const newList = newValues ?? [];
		const added = newList.filter((value) => !oldList.includes(value));
		const removed = oldList.filter((value) => !newList.includes(value));
		if (!added.length && !removed.length) continue;
		rows.push(
			`${label}：${[
				added.length ? `新增 ${added.join("、")}` : "",
				removed.length ? `移除 ${removed.join("、")}` : "",
			]
				.filter(Boolean)
				.join("；")}`,
		);
	}
	const channelIds = new Set([
		...Object.keys(before.channels ?? {}),
		...Object.keys(after.channels ?? {}),
	]);
	for (const channelId of channelIds) {
		const oldChannel = before.channels?.[channelId] ?? {};
		const newChannel = after.channels?.[channelId] ?? {};
		const changes: string[] = [];
		if (oldChannel.budget !== newChannel.budget)
			changes.push(
				`预算 ${oldChannel.budget ?? "未设置"} → ${newChannel.budget ?? "未设置"}`,
			);
		if (oldChannel.bidCpc !== newChannel.bidCpc)
			changes.push(
				`出价 ${oldChannel.bidCpc ?? "未设置"} → ${newChannel.bidCpc ?? "未设置"}`,
			);
		if (oldChannel.enabled !== newChannel.enabled)
			changes.push(
				`启停 ${enabledLabel(oldChannel.enabled)} → ${enabledLabel(newChannel.enabled)}`,
			);
		if (changes.length) rows.push(`渠道 ${channelId}：${changes.join("；")}`);
	}
	return rows;
}

function enabledLabel(value: boolean | undefined): string {
	return value === undefined ? "未设置" : value ? "启用" : "暂停";
}

function StrategyValues({
	label,
	values,
}: {
	label: string;
	values?: string[];
}) {
	return (
		<div className="flex flex-wrap items-center gap-1.5 text-sm">
			<span className="text-muted-foreground">{label}：</span>
			{values?.length ? (
				values.map((value, index) => (
					<Badge key={`${value}:${index}`} variant="outline">
						{value}
					</Badge>
				))
			) : (
				<span className="text-muted-foreground">未填写</span>
			)}
		</div>
	);
}

const LIST_LABELS = {
	audience: "人群",
	sellingPoint: "卖点",
	contentDirection: "内容方向",
	partner: "合作对象",
} as const;

function changeLabel(change: {
	kind:
		| "budget"
		| "bidCpc"
		| "enabled"
		| "audience"
		| "sellingPoint"
		| "contentDirection"
		| "partner";
	channelId?: string;
	from?: number | boolean;
	to?: number | boolean;
	op?: "add" | "remove";
	item?: string;
}): string {
	switch (change.kind) {
		case "budget":
			return `预算（${change.channelId}）：${String(change.from)} → ${String(change.to)}`;
		case "bidCpc":
			return `出价（${change.channelId}）：${String(change.from)} → ${String(change.to)}`;
		case "enabled":
			return `启用状态（${change.channelId}）：${String(change.from)} → ${String(change.to)}`;
		case "audience":
		case "sellingPoint":
		case "contentDirection":
		case "partner":
			return `${LIST_LABELS[change.kind]}${change.op === "remove" ? "移除" : "新增"}：${change.item}`;
	}
	// 服务端先上线新 kind 时，旧控制台也要显示一行而不是空白。
	return `未知变更：${(change as { kind: string }).kind}`;
}

function deliveryLabel(status: string): string {
	const labels: Record<string, string> = {
		pending: "待发送",
		sent: "已送达",
		failed: "发送失败",
		cancelled: "已取消",
	};
	return labels[status] ?? status;
}

function deliveryVariant(
	status: string,
): "outline" | "secondary" | "destructive" {
	if (status === "failed") return "destructive";
	if (status === "sent") return "secondary";
	return "outline";
}

function OptionChip({
	label,
	selected,
	actionRef,
}: {
	label: string;
	selected: boolean;
	actionRef?: string;
}) {
	const { mutate, isPending, error } = useChoice(actionRef ?? "");
	const clickable = Boolean(actionRef) && !isPending;

	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				disabled={!clickable}
				onClick={() => actionRef && mutate()}
				className={cn(
					"inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition",
					selected
						? "border-emerald-500/60 bg-emerald-500/15 font-medium text-emerald-700 dark:text-emerald-400"
						: "border-border bg-background",
					clickable
						? "cursor-pointer hover:border-emerald-500/40 hover:bg-emerald-500/5"
						: "cursor-default",
					!selected && !clickable && "text-muted-foreground",
				)}
			>
				{selected ? <Check className="size-3.5 shrink-0" /> : null}
				{isPending ? "提交中…" : label}
			</button>
			{error ? (
				<span className="text-xs text-red-600">{String(error)}</span>
			) : null}
		</div>
	);
}

function useChoice(actionRef: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			const result = await consoleClient.POST("/api/choices", {
				body: { actionRef },
				params: { header: { "Idempotency-Key": crypto.randomUUID() } },
			});
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data;
		},
		onSuccess: () => queryClient.invalidateQueries(),
	});
}
