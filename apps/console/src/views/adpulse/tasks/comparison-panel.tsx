import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { type components, consoleClient } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import { formatReviewAmount, formatReviewCost, reportChoiceLabel, reviewReasonLabels } from "./review-display";
import { ReviewSection } from "./review-section";
import { formatBeijingPeriod, formatBeijingTime } from "./task-form";
import { placementLabels } from "./placement-display";

type EvidenceVersion = components["schemas"]["EvidenceVersion"];
type EvidenceRef = components["schemas"]["EvidenceRef"];
type ComparisonResult = components["schemas"]["ComparisonResult"];
type ComparisonFollowUp = components["schemas"]["ComparisonFollowUp"];
type TaskVersion = components["schemas"]["TaskVersion"];

const statusLabels: Record<ComparisonResult["status"], string> = {
	comparable: "两期表现对比",
	incomparable: "两份报表暂时无法对比",
	awaiting_supplementation: "有数据待补充",
	missing_baseline: "本期成本检查",
	temporarily_uncomputable: "本期成本暂时算不出来",
};
const thresholdLabels: Record<
	ComparisonResult["thresholdEvaluation"]["status"],
	string
> = {
	exceeded: "超过提醒线",
	not_exceeded: "未超过提醒线",
	not_evaluated: "暂时无法判断是否超出提醒线",
};
const actionLabels: Record<
	ComparisonFollowUp["remediation"]["action"],
	string
> = {
	provide_evidence: "请补充或更正报表",
	revise_task_rules: "请检查任务里的成本提醒设置",
	verify_source: "请回到投放平台核对数据",
	none: "请核对两份报表的统计方式",
};
const directionLabels = {
	increased: "上升",
	decreased: "下降",
	unchanged: "持平",
};

function useReportDetails(evidenceId: string | undefined) {
	return useQuery({
		queryKey: ["evidence", evidenceId],
		enabled: Boolean(evidenceId),
		queryFn: async () => {
			if (!evidenceId) throw new Error("请选择报表。");
			const result = await consoleClient.GET("/api/evidence/{evidenceId}", {
				params: { path: { evidenceId } },
			});
			if (!result.data) throw new Error("暂时无法读取这份报表。");
			return result.data;
		},
	});
}

function EvidenceSelector({
	label,
	items,
	evidenceId,
	version,
	createdAfter,
	disabled,
	onEvidenceChange,
	onVersionChange,
}: {
	label: string;
	items: EvidenceVersion[];
	evidenceId: string;
	version: string;
	createdAfter?: string;
	disabled?: boolean;
	onEvidenceChange: (item: EvidenceVersion | undefined) => void;
	onVersionChange: (value: string) => void;
}) {
	const detail = useReportDetails(evidenceId || undefined);
	const options = (detail.data?.versions ?? []).filter((item) => !createdAfter || item.createdAt > createdAfter);
	return (
		<div className="space-y-2">
			<label className="block space-y-1 text-sm">
				<span>{label}</span>
				<select
					className="w-full rounded-md border bg-background p-2"
					value={evidenceId}
					disabled={disabled}
					onChange={(event) => onEvidenceChange(items.find((item) => item.evidenceId === event.target.value))}
				>
					<option value="">请选择报表</option>
					{items.map((item) => (
						<option key={item.evidenceId} value={item.evidenceId}>
							{reportChoiceLabel(item)}
						</option>
					))}
				</select>
			</label>
			{options.length > 1 ? <label className="block space-y-1 text-sm">
				<span>使用哪版报表</span>
				<select
					className="w-full rounded-md border bg-background p-2"
					value={version}
					disabled={disabled}
					onChange={(event) => onVersionChange(event.target.value)}
				>
					{options.map((item) => (
						<option key={item.id} value={String(item.version)}>
							第 {item.version} 版 · {formatBeijingTime(item.createdAt)}{item.version === detail.data?.current.version ? " · 最新" : ""}
						</option>
					))}
				</select>
			</label> : null}
			{detail.error ? (
				<p className="text-xs text-muted-foreground">暂时无法查看这份报表的旧版本。</p>
			) : null}
		</div>
	);
}

export function ComparisonPanel({
	taskId,
	items,
	mode,
}: {
	taskId: string;
	items: EvidenceVersion[];
	mode: "cost" | "comparison";
}) {
	const comparing = mode === "comparison";
	const queryClient = useQueryClient();
	const [currentId, setCurrentId] = useState("");
	const [currentVersion, setCurrentVersion] = useState("");
	const [baselineId, setBaselineId] = useState("");
	const [baselineVersion, setBaselineVersion] = useState("");
	const [error, setError] = useState("");
	const operationKey = useRef<string | null>(null);
	const comparisons = useQuery({
		queryKey: ["task-comparisons", taskId],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/tasks/{taskId}/comparisons", {
				params: { path: { taskId } },
			});
			if (!result.data) throw new Error("检查结果暂时无法读取。");
			return result.data.items;
		},
	});
	const evaluate = useMutation({
		mutationFn: async () => {
			if (!currentId || !currentVersion) throw new Error("请选择本期报表。");
			if (comparing && (!baselineId || !baselineVersion))
				throw new Error("请选择要对比的报表。");
			const current: EvidenceRef = {
				evidenceId: currentId,
				version: Number(currentVersion),
			};
			const baseline: EvidenceRef | undefined =
				comparing
					? { evidenceId: baselineId, version: Number(baselineVersion) }
					: undefined;
			const key = operationKey.current ?? crypto.randomUUID();
			operationKey.current = key;
			const result = await consoleClient.POST("/api/comparisons/evaluate", {
				body: { current, ...(baseline ? { baseline } : {}) },
				params: { header: { "Idempotency-Key": key } },
			});
			if (!result.data) throw new Error("暂时无法读取结果，请确认所选报表后重试。");
			return result.data;
		},
		onSuccess: async () => {
			operationKey.current = null;
			setError("");
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["task-comparisons", taskId] }),
				queryClient.invalidateQueries({
					queryKey: ["task-comparison-follow-ups", taskId],
				}),
			]);
		},
		onError: (cause) => setError(cause.message),
	});
	const resetKey = () => {
		operationKey.current = null;
		setError("");
	};
	const results = comparisons.data?.filter((item) => Boolean(item.baseline) === comparing);
	const canSelectReports = !comparing || items.length > 1;
	// 章节说明按任务口径描述，不把达人 / 种草的互动量写成咨询。
	const sectionSpec = placementLabels(items[0]?.placementType);

	return (
		<ReviewSection
			title={comparing ? "对比两期表现" : "检查本期成本"}
			description={comparing
				? `查看两期的${sectionSpec.spend}、${sectionSpec.count}和${sectionSpec.derived}怎么变了。`
				: `查看一份报表的${sectionSpec.derived}是否超过提醒线。`}
		>
			<div className="space-y-4">
				{canSelectReports ? (
					<div className="space-y-3">
						<div className={comparing ? "grid gap-4 md:grid-cols-2" : "max-w-xl"}>
							<EvidenceSelector
								label="本期报表"
								items={items}
								evidenceId={currentId}
								version={currentVersion}
								disabled={evaluate.isPending}
								onEvidenceChange={(item) => {
									resetKey();
									setCurrentId(item?.evidenceId ?? "");
									setCurrentVersion(item ? String(item.version) : "");
									if (item?.evidenceId === baselineId) {
										setBaselineId("");
										setBaselineVersion("");
									}
								}}
								onVersionChange={(value) => {
									resetKey();
									setCurrentVersion(value);
								}}
							/>
							{comparing && (
								<EvidenceSelector
									label="对照报表"
									items={items.filter((item) => item.evidenceId !== currentId)}
									evidenceId={baselineId}
									version={baselineVersion}
									disabled={evaluate.isPending}
									onEvidenceChange={(item) => {
										resetKey();
										setBaselineId(item?.evidenceId ?? "");
										setBaselineVersion(item ? String(item.version) : "");
									}}
									onVersionChange={(value) => {
										resetKey();
										setBaselineVersion(value);
									}}
								/>
							)}
						</div>
						{comparing && <p className="text-xs text-muted-foreground">系统会先核对两期数据的统计方式是否一致。</p>}
						{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
						<Button
							type="button"
							disabled={
								evaluate.isPending ||
								!currentId ||
								!currentVersion ||
								(comparing && (!baselineId || !baselineVersion))
							}
							onClick={() => evaluate.mutate()}
						>
							{evaluate.isPending ? "正在计算…" : comparing ? "对比两期报表" : "检查成本"}
						</Button>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">再导入一份其他时段的报表，就可以对比两期表现。</p>
				)}

				<section className="space-y-3 border-t pt-4">
					<h3 className="text-sm font-semibold">{comparing ? "对比结果" : "成本检查结果"}</h3>
					{comparisons.isLoading ? <p className="text-sm">正在加载…</p> : null}
					{comparisons.error ? (
						<p role="alert" className="text-sm text-red-600">
							{comparisons.error.message}
						</p>
					) : null}
					{results?.length ? (
						<ol className="space-y-3">
							{results.map((item) => (
								<ComparisonHistoryItem key={item.id} item={item} reports={items} />
							))}
						</ol>
					) : !comparisons.isLoading && !comparisons.error && canSelectReports ? (
						<p className="text-sm text-muted-foreground">{comparing ? "对比完成后，结果会保存在这里。" : "检查完成后，结果会保存在这里。"}</p>
					) : null}
				</section>

			</div>
		</ReviewSection>
	);
}

export function ReviewFollowUps({ taskId, items, taskVersions }: {
	taskId: string;
	items: EvidenceVersion[];
	taskVersions: TaskVersion[];
}) {
	const followUps = useQuery({
		queryKey: ["task-comparison-follow-ups", taskId],
		queryFn: async () => {
			const result = await consoleClient.GET(
				"/api/tasks/{taskId}/comparison-follow-ups",
				{ params: { path: { taskId } } },
			);
			if (!result.data) throw new Error("跟进事项暂时无法读取。");
			return result.data.items;
		},
	});
	if (!followUps.data?.length && !followUps.error) return null;

	return (
		<ReviewSection title="复盘跟进" description="查看还可以补充哪些报表或提醒设置。">
			{followUps.error && <p role="alert" className="text-sm text-destructive">{followUps.error.message}</p>}
			<ul className="space-y-3">
				{followUps.data?.map((item) => (
					<FollowUpItem key={item.id} item={item} taskId={taskId} reports={items} taskVersions={taskVersions} />
				))}
			</ul>
		</ReviewSection>
	);
}

function useComparedReport(ref: EvidenceRef | undefined, reports: EvidenceVersion[]) {
	const report = reports.find((item) => item.evidenceId === ref?.evidenceId && item.version === ref.version);
	const details = useReportDetails(report ? undefined : ref?.evidenceId);
	return report ?? details.data?.versions.find((item) => item.version === ref?.version);
}

function ComparisonHistoryItem({ item, reports }: { item: ComparisonResult; reports: EvidenceVersion[] }) {
	const current = useComparedReport(item.current, reports);
	const baseline = useComparedReport(item.baseline, reports);
	const comparing = Boolean(item.baseline);
	const currency = current?.currency;
	const { spendMinor, consultations, costPerConsultation } = item.comparisons;
	const threshold = item.thresholdEvaluation;
	// 比较结果沿用通用投影字段名，展示标签必须按投放方式口径决定。
	const spec = placementLabels(item.placementType ?? current?.placementType);
	const reasons = [...new Set(item.reasons
		.filter((reason) => reason.axis === "both" || reason.axis === (comparing ? "period_comparison" : "current_threshold"))
		.map((reason) => reviewReasonLabels[reason.code]))];

	return (
		<li className="space-y-2 rounded border p-3 text-sm">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<strong>{statusLabels[item.status]}</strong>
				<span className="text-xs text-muted-foreground">{formatBeijingTime(item.createdAt)}</span>
			</div>
			{current && <p className="text-muted-foreground">本期报表 · {formatBeijingPeriod(current.period)}</p>}
			{baseline && <p className="text-muted-foreground">对照报表 · {formatBeijingPeriod(baseline.period)}</p>}
			<p className="text-xs text-muted-foreground">{spec.name} · {spec.attributionNote}</p>
			{!comparing && <p>
				{threshold.value && currency ? (
					<>{spec.derived} <strong>{formatReviewCost(threshold.value, currency)}</strong> · </>
				) : null}
				{thresholdLabels[threshold.status]}
				{threshold.thresholdMinor !== undefined && currency && threshold.currency === currency.code
					? `（提醒线 ${formatReviewAmount(threshold.thresholdMinor, currency, true)}）`
					: ""}
			</p>}
			{spendMinor && currency && (
				<p>{spec.spend} · {formatReviewAmount(spendMinor.baseline, currency)} → {formatReviewAmount(spendMinor.current, currency)}</p>
			)}
			{consultations && (
				<p>{spec.count} · {consultations.baseline} → {consultations.current}</p>
			)}
			{costPerConsultation && currency && (
				<p>
					{spec.derived}{directionLabels[costPerConsultation.direction]} · {formatReviewCost(costPerConsultation.baseline, currency)}
					{" → "}{formatReviewCost(costPerConsultation.current, currency)}
				</p>
			)}
			{reasons.length > 0 && (
				<ul className="list-disc space-y-1 border-t pt-2 pl-5 text-muted-foreground">
					{reasons.map((reason) => <li key={reason}>{reason}</li>)}
				</ul>
			)}
		</li>
	);
}

function FollowUpItem({
	item,
	taskId,
	reports,
	taskVersions,
}: {
	item: ComparisonFollowUp;
	taskId: string;
	reports: EvidenceVersion[];
	taskVersions: TaskVersion[];
}) {
	const queryClient = useQueryClient();
	const [evidenceId, setEvidenceId] = useState("");
	const [version, setVersion] = useState("");
	const [error, setError] = useState("");
	const operationKey = useRef<string | null>(null);
	const resolve = useMutation({
		mutationFn: async () => {
			if (!version) throw new Error("请先选择要提交的内容。");
			const material: components["schemas"]["FollowUpResolutionInput"]["material"] =
				item.resolutionKind === "evidence"
					? { kind: "evidence", evidenceId, version: Number(version) }
					: { kind: "task_version", taskId, version: Number(version) };
			const key = operationKey.current ?? crypto.randomUUID();
			operationKey.current = key;
			const result = await consoleClient.POST(
				"/api/comparison-follow-ups/{followUpId}/resolve",
				{
					params: {
						path: { followUpId: item.id },
						header: { "Idempotency-Key": key },
					},
					body: { material },
				},
			);
			if (!result.data) {
				if (result.response.status === 409) throw new Error("这项跟进已更新，请刷新页面后重试。");
				if (result.response.status === 400) {
					throw new Error(item.resolutionKind === "evidence"
						? "这份报表还不能完成跟进。请核对统计时间、投放账号和花费、咨询数据。"
						: "这次修改还不能完成跟进。请检查提醒线、统计天数和触发条件。");
				}
				throw new Error("暂时无法保存跟进，请重试。");
			}
			return result.data;
		},
		onSuccess: async () => {
			operationKey.current = null;
			setError("");
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["task-comparisons", taskId] }),
				queryClient.invalidateQueries({
					queryKey: ["task-comparison-follow-ups", taskId],
				}),
			]);
		},
		onError: (cause) => setError(cause.message),
	});
	const selectVersion = (value: string) => {
		operationKey.current = null;
		setError("");
		setVersion(value);
	};
	const eligibleReports = reports.filter((report) => report.createdAt > item.createdAt && (
		!item.period || (item.period.startsAt === report.period.startsAt &&
			item.period.endsAt === report.period.endsAt && item.period.timeZone === report.period.timeZone)
	));
	const eligibleVersions = taskVersions.filter((task) => task.version > item.taskVersion && task.createdAt > item.createdAt);
	const needsReport = item.resolutionKind === "evidence";
	const canSubmit = needsReport
		? Boolean(version && eligibleReports.some((report) => report.evidenceId === evidenceId))
		: eligibleVersions.some((task) => String(task.version) === version);

	return (
		<li className="space-y-2 rounded border p-3 text-sm">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<strong>{reviewReasonLabels[item.reasonCode]}</strong>
				<span className="text-xs text-muted-foreground">
					{item.status === "open" ? "待跟进" : "已完成"} · {formatBeijingTime(item.updatedAt)}
				</span>
			</div>
			{item.status === "open" && (
				<>
					<p>{item.reasonCode === "NO_BASELINE"
						? "如果想看前后变化，请补一份紧接本期、天数相同的上期报表。"
						: `${actionLabels[item.remediation.action]}。`}</p>
					{item.period && (
						<p className="text-muted-foreground">需要补充的统计时间 · {formatBeijingPeriod(item.period)}</p>
					)}
					{item.remediation.action !== "none" && (
						<div className="space-y-2">
							{needsReport ? (
								eligibleReports.length > 0 ? (
									<EvidenceSelector
										label="选择补充的报表"
										items={eligibleReports}
										evidenceId={eligibleReports.some((report) => report.evidenceId === evidenceId) ? evidenceId : ""}
										version={version}
										createdAfter={item.createdAt}
										disabled={resolve.isPending}
										onEvidenceChange={(report) => {
											setEvidenceId(report?.evidenceId ?? "");
											selectVersion(report ? String(report.version) : "");
										}}
										onVersionChange={selectVersion}
									/>
								) : <p className="text-muted-foreground">导入或更正报表后，可以在这里选择。</p>
							) : (
								<>
									<Link className="text-primary underline underline-offset-4" to={`/tasks/${taskId}`}>
										修改成本提醒设置
									</Link>
									{eligibleVersions.length > 0 && (
										<label className="block space-y-1">
											<span>选择保存后的设置</span>
											<select
												className="w-full rounded-md border bg-background p-2"
												value={version}
												disabled={resolve.isPending}
												onChange={(event) => selectVersion(event.target.value)}
											>
												<option value="">请选择</option>
												{eligibleVersions.map((task) => (
													<option key={task.id} value={String(task.version)}>
														第 {task.version} 次保存 · {formatBeijingTime(task.createdAt)}
													</option>
												))}
											</select>
										</label>
									)}
								</>
							)}
							{(needsReport ? eligibleReports.length > 0 : eligibleVersions.length > 0) && (
								<Button
									type="button"
									variant="outline"
									disabled={resolve.isPending || !canSubmit}
									onClick={() => {
										setError("");
										resolve.mutate();
									}}
								>
									{resolve.isPending ? "正在核对…" : "确认补充"}
								</Button>
							)}
						</div>
					)}
				</>
			)}
			{error && <p role="alert" className="text-destructive">{error}</p>}
		</li>
	);
}
