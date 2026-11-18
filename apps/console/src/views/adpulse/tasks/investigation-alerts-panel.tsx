import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { type components, consoleClient } from "../../../adpulse-client";
import { Badge } from "../../../components/ui/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { formatReviewAmount, formatReviewCost, formatReviewCount } from "./review-display";
import { derivedLabel, placementLabels } from "./placement-display";
import { formatBeijingPeriod, formatBeijingTime } from "./task-form";

type InvestigationAlert = components["schemas"]["InvestigationAlert"];
type Session = components["schemas"]["Session"];

const statusLabels: Record<InvestigationAlert["status"], string> = {
	open: "待跟进",
	awaiting_evidence: "等待补充报表",
	handled: "已处理",
	cleared: "已解除",
	stale: "需要重新检查",
	capped: "提醒次数已达上限",
};

const eventLabels: Record<InvestigationAlert["events"][number]["type"], string> = {
	opened: "创建提醒",
	observed: "记录检查结果",
	candidate_created: "已生成排查建议",
	deferred: "等待补充报表",
	handled: "完成排查",
	cleared: "最新成本已回到提醒线以内",
	invalidated: "原提醒已失效",
	capped: "达到提醒次数上限",
};

const statusExplanations: Readonly<Partial<Record<string, string>>> = {
	decision_deadline_elapsed: "已超过处理期限，可重新检查最新报表。",
	evidence_revision_requires_re_evaluation: "报表已更正，请用最新报表重新检查。",
	task_rules_revised_requires_new_evidence: "成本提醒设置已更新，请导入新报表后检查。",
	baseline_or_evidence_is_no_longer_current: "报表已更新，请用最新报表重新检查。",
	current_threshold_unavailable: "最新报表暂时无法判断是否超出提醒线。",
};

function AlertItem({
	alert,
	session,
}: {
	alert: InvestigationAlert;
	session?: Session;
}) {
	const current = alert.current;
	const spec = placementLabels(current.placementType);
	const derived = derivedLabel(current.metric, current.placementType);
	const cost = current.spendMinor != null && current.consultations != null && current.consultations > 0
		? formatReviewCost({ numeratorMinor: current.spendMinor, denominatorConsultations: current.consultations }, current.currency)
		: "暂时无法计算";
	const explanation = alert.statusReason ? statusExplanations[alert.statusReason] : undefined;
	return (
		<article className="space-y-3 rounded-md border p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant={alert.status === "open" ? "destructive" : "outline"}>
						{statusLabels[alert.status]}
					</Badge>
					<span className="text-sm font-medium">
						{formatBeijingPeriod(current.period)}
					</span>
				</div>
				{session ? (
					<Link
						className="text-sm font-medium text-primary underline-offset-4 hover:underline"
						to={`/sessions/${encodeURIComponent(session.id)}`}
					>
						查看排查进度
					</Link>
				) : null}
			</div>

			<dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
				<div>
					<dt className="text-muted-foreground">{derived}</dt>
					<dd className="font-semibold tabular-nums">{cost}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">成本提醒线</dt>
					<dd>{formatReviewAmount(current.thresholdMinor, current.currency, true)}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">{spec.spend}</dt>
					<dd>{formatReviewAmount(current.spendMinor, current.currency)}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">{spec.count}</dt>
					<dd>{formatReviewCount(current.consultations)}</dd>
				</div>
				{current.handlingDeadlineHours !== undefined && (
					<div>
						<dt className="text-muted-foreground">处理时限</dt>
						<dd>{current.handlingDeadlineHours} 小时</dd>
					</div>
				)}
			</dl>

			<p className="text-xs text-muted-foreground">{spec.name} · {current.attributionNote ?? spec.attributionNote}</p>
			{explanation ? (
				<p className="text-xs text-muted-foreground">{explanation}</p>
			) : null}

			<details className="text-sm">
				<summary className="cursor-pointer font-medium">处理记录（{alert.events.length}）</summary>
				<ol className="mt-2 space-y-1 border-l pl-4 text-muted-foreground">
					{alert.events.map((event, index) => (
						<li key={`${event.type}-${event.at}-${index}`}>
							{formatBeijingTime(event.at)} · {eventLabels[event.type]}
						</li>
					))}
				</ol>
			</details>
		</article>
	);
}

export function InvestigationAlertsPanel({ taskId }: { taskId: string }) {
	const alerts = useQuery({
		queryKey: ["task-investigation-alerts", taskId],
		queryFn: async () => {
			const result = await consoleClient.GET(
				"/api/tasks/{taskId}/investigation-alerts",
				{ params: { path: { taskId } } },
			);
			if (!result.data) throw new Error("暂时无法读取成本提醒，请稍后重试。");
			return result.data.items;
		},
		refetchInterval: 3000,
	});
	const sessions = useQuery({
		queryKey: ["sessions"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/sessions");
			if (!result.data) throw new Error("暂时无法读取排查进度。");
			return result.data.items;
		},
		refetchInterval: 3000,
	});
	const sessionById = new Map((sessions.data ?? []).map((session) => [session.id, session]));

	return (
		<Card>
			<CardHeader>
				<CardTitle>提醒和处理进度</CardTitle>
				<p className="text-sm text-muted-foreground">
					按任务设置的效果口径检查报表；超过提醒线时，会在这里生成提醒。
				</p>
			</CardHeader>
			<CardContent className="space-y-3">
				{alerts.isLoading ? <p className="text-sm">正在加载提醒…</p> : null}
				{alerts.error ? (
					<p role="alert" className="text-sm text-red-600">{alerts.error.message}</p>
				) : null}
				{sessions.error ? (
					<p className="text-sm text-muted-foreground">{sessions.error.message}</p>
				) : null}
				{alerts.data?.length ? (
					alerts.data.map((alert) => (
						<AlertItem key={alert.id} alert={alert} session={sessionById.get(alert.sessionId)} />
					))
				) : alerts.isSuccess ? (
					<p className="text-sm text-muted-foreground">目前没有成本提醒。可在「检查本期成本」里检查报表。</p>
				) : null}
			</CardContent>
		</Card>
	);
}
