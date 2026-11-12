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
import { formatTime } from "../status";

type InvestigationAlert = components["schemas"]["InvestigationAlert"];
type Session = components["schemas"]["Session"];

const statusLabels: Record<InvestigationAlert["status"], string> = {
	open: "待 Web 排查",
	awaiting_evidence: "等待新证据",
	handled: "已处理",
	cleared: "已解除",
	stale: "依据已失效",
	capped: "已达轮次上限",
};

const eventLabels: Record<InvestigationAlert["events"][number]["type"], string> = {
	opened: "创建提醒",
	observed: "记录评估结果",
	candidate_created: "创建 Web 排查候选",
	deferred: "等待更新证据",
	handled: "完成排查轮次",
	cleared: "更新结果未再越线",
	invalidated: "旧候选失效",
	capped: "达到排查轮次上限",
};

function displayValue(value: number | null | undefined, unit = ""): string {
	if (value === undefined) return "未知";
	if (value === null) return "来源为空";
	return `${value.toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

function formatCurrency(minor: number | null | undefined, currency: string, unit: string) {
	return `${displayValue(minor)} ${currency}/${unit}`;
}

function AlertItem({
	alert,
	session,
}: {
	alert: InvestigationAlert;
	session?: Session;
}) {
	const current = alert.current;
	return (
		<article className="space-y-3 rounded-md border p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant={alert.status === "open" ? "destructive" : "outline"}>
						{statusLabels[alert.status]}
					</Badge>
					<span className="text-sm font-medium">
						{current.period.startsAt} – {current.period.endsAt} ({current.period.timeZone})
					</span>
				</div>
				{session ? (
					<Link
						className="text-sm font-medium text-primary underline-offset-4 hover:underline"
						to={`/sessions/${encodeURIComponent(session.id)}`}
					>
						打开 Web 排查会话
					</Link>
				) : alert.status === "open" ? (
					<span className="text-sm text-muted-foreground">正在准备 Web 排查会话…</span>
				) : null}
			</div>

			<dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
				<div>
					<dt className="text-muted-foreground">账户 / 计划</dt>
					<dd>{current.source.platform} · {current.source.accountRef} / {current.scope.planRef}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">消耗 / 咨询数</dt>
					<dd>
						{formatCurrency(current.spendMinor, current.currency.code, current.currency.minorUnit)}
						{" / "}{displayValue(current.consultations, "次")}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">单次咨询成本规则</dt>
					<dd>{current.metricDefinition} · {current.metricFormula}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">已确认警戒线</dt>
					<dd>{formatCurrency(current.thresholdMinor, current.currency.code, current.currency.minorUnit)}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">业务处理时限</dt>
					<dd>{current.handlingDeadlineHours === undefined ? "待确认" : `${current.handlingDeadlineHours} 小时`}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">比较背景</dt>
					<dd>
						{current.comparisonStatus === "missing_baseline"
							? "未选择历史基线；不作跨期结论"
							: current.canComparePeriods
								? "期间可比较；不代表因果关系"
								: "期间不可比较；不作跨期结论"}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">证据 / 规则版本</dt>
					<dd>{current.evidence.evidenceId} v{current.evidence.version} / 任务 v{current.evidence.taskVersion}</dd>
				</div>
			</dl>

			{current.limitations.length ? (
				<p className="text-xs text-muted-foreground">
					比较限制：{current.limitations.join("、")}
				</p>
			) : null}
			{alert.statusReason ? (
				<p className="text-xs text-muted-foreground">
					状态说明：{alert.statusReason === "decision_deadline_elapsed" ? "可操作期限已过" : alert.statusReason}
				</p>
			) : null}

			<details className="text-sm">
				<summary className="cursor-pointer font-medium">提醒审计记录（{alert.events.length}）</summary>
				<ol className="mt-2 space-y-1 border-l pl-4 text-muted-foreground">
					{alert.events.map((event, index) => (
						<li key={`${event.type}-${event.at}-${index}`}>
							{formatTime(event.at)} · {eventLabels[event.type]}
							{event.reason ? ` · ${event.reason}` : ""}
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
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data.items;
		},
		refetchInterval: 3000,
	});
	const sessions = useQuery({
		queryKey: ["sessions"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/sessions");
			if (!result.data) throw new Error(JSON.stringify(result.error));
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
					检查结果超过任务中已确认的成本警戒线时，会在这里生成提醒。
				</p>
			</CardHeader>
			<CardContent className="space-y-3">
				{alerts.isLoading ? <p className="text-sm">正在加载提醒…</p> : null}
				{alerts.error ? (
					<p role="alert" className="text-sm text-red-600">读取提醒失败：{String(alerts.error)}</p>
				) : null}
				{sessions.error ? (
					<p className="text-sm text-muted-foreground">会话状态暂不可用：{String(sessions.error)}</p>
				) : null}
				{alerts.data?.length ? (
					alerts.data.map((alert) => (
						<AlertItem key={alert.id} alert={alert} session={sessionById.get(alert.sessionId)} />
					))
				) : alerts.isSuccess ? (
					<p className="text-sm text-muted-foreground">目前没有成本提醒。可在「对比表现或检查成本」里检查本期报表。</p>
				) : null}
			</CardContent>
		</Card>
	);
}
