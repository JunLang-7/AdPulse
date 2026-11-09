import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FileUp } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { type components, consoleClient } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { ComparisonPanel } from "./comparison-panel";
import { readEvidenceCorrection, readEvidenceImport } from "./evidence-file";
import { InvestigationAlertsPanel } from "./investigation-alerts-panel";
import { formatBeijingPeriod } from "./task-form";

type EvidenceImportInput = components["schemas"]["EvidenceImportInput"];
type EvidenceRevision = components["schemas"]["EvidenceRevision"];
type EvidenceVersion = components["schemas"]["EvidenceVersion"];

type ReportOperation<Body> = { key: string; body: Body };

function reportError(status: number, conflict: string): Error {
	if (status === 401 || status === 403)
		return new Error("当前账号没有操作权限，请确认登录后重试。");
	if (status === 413) return new Error("报表文件过大，请分批导入。");
	if (status === 409) return new Error(conflict);
	return new Error("报表内容未通过校验，请核对任务、时间范围和报表口径。");
}

export function EvidencePanel({
	taskId,
	taskVersion,
}: {
	taskId: string;
	taskVersion: number;
}) {
	const queryClient = useQueryClient();
	const [reportFile, setReportFile] = useState<File | null>(null);
	const [error, setError] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const fileInput = useRef<HTMLInputElement>(null);
	const importOperation = useRef<ReportOperation<EvidenceImportInput> | null>(null);
	const evidence = useQuery({
		queryKey: ["task-evidence", taskId],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/tasks/{taskId}/evidence", {
				params: { path: { taskId } },
			});
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data.items;
		},
	});
	const importMutation = useMutation({
		mutationFn: async (file: File) => {
			const operation = importOperation.current ?? {
				key: crypto.randomUUID(),
				body: await readEvidenceImport(file, { taskId, taskVersion }),
			};
			importOperation.current = operation;
			const result = await consoleClient.POST("/api/evidence/imports", {
				body: operation.body,
				params: { header: { "Idempotency-Key": operation.key } },
			});
			if (!result.data) {
				const { status } = result.response;
				if (status >= 400 && status < 500) importOperation.current = null;
				throw reportError(
					status,
					"此区间已有不同内容。如需更正，请在该条报表的详情中上传更正文件。",
				);
			}
			return result.data;
		},
		onSuccess: async ({ items }) => {
			importOperation.current = null;
			setError("");
			setReportFile(null);
			if (fileInput.current) fileInput.current.value = "";
			const added = items.filter((item) => item.status === "created").length;
			const existing = items.length - added;
			const addedMessage = added ? `已导入 ${added} 个区间。` : "";
			const existingMessage = existing ? `${existing} 个区间已存在。` : "";
			setConfirmation(addedMessage + existingMessage);
			await queryClient.invalidateQueries({
				queryKey: ["task-evidence", taskId],
			});
		},
		onError: (cause) => setError(
			importOperation.current
				? "暂时无法确认导入结果，请重试同一份报表。"
				: cause.message,
		),
	});

	const reports = [...(evidence.data ?? [])].sort((a, b) =>
		b.period.endsAt.localeCompare(a.period.endsAt) ||
		b.period.startsAt.localeCompare(a.period.startsAt),
	);
	const [latestReport, ...earlierReports] = reports;
	const empty = evidence.isSuccess && !latestReport;

	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>{latestReport ? "最近一期投放" : "投放数据"}</CardTitle>
					<p className="text-sm text-muted-foreground">
						{empty ? "还没有投放数据。有了报表，就能在这里看到花了多少钱、收到了多少次咨询。" : "按报表的结束时间排列，时间均为北京时间。"}
					</p>
				</CardHeader>
				<CardContent className="space-y-4">
					{evidence.isLoading ? <p role="status" className="text-sm">正在读取报表…</p> : null}
					{evidence.error ? (
						<div className="space-y-2">
							<p role="alert" className="text-sm text-destructive">暂时无法读取报表。</p>
							<Button type="button" variant="outline" onClick={() => void evidence.refetch()}>重新读取</Button>
						</div>
					) : null}
					{latestReport ? <EvidenceItem key={latestReport.evidenceId} item={latestReport} /> : null}
					{earlierReports.length ? (
						<details className="rounded-lg border">
							<summary className="cursor-pointer px-4 py-3 text-sm font-medium">其他时段（{earlierReports.length}）</summary>
							<div className="space-y-3 border-t p-4">
								{earlierReports.map((item) => <EvidenceItem key={item.evidenceId} item={item} />)}
							</div>
						</details>
					) : null}
					<details className={empty ? "rounded-lg border border-dashed bg-muted/30" : "rounded-lg border"} open={empty || undefined}>
						<summary className="cursor-pointer px-4 py-3 text-sm font-medium">
							<FileUp aria-hidden="true" className="mr-2 inline size-4" />
							{latestReport ? "添加投放报表" : "导入投放报表"}
						</summary>
						<form
							className="space-y-3 border-t p-4"
							onSubmit={(event) => {
								event.preventDefault();
								if (!reportFile || importMutation.isPending) return;
								setError("");
								setConfirmation("");
								importMutation.mutate(reportFile);
							}}
						>
							<p className="text-sm text-muted-foreground">
								已有 AdPulse 报表？选择为当前任务准备的文件，每份可包含一到两个时段。
							</p>
							<label className="block space-y-1 text-sm">
								<span className="font-medium">选择 AdPulse 报表文件（.json）</span>
								<Input
									ref={fileInput}
									type="file"
									accept=".json,application/json"
									className="h-auto py-2"
									disabled={importMutation.isPending || importOperation.current !== null}
									onChange={(event) => {
										setReportFile(event.target.files?.[0] ?? null);
										setError("");
										setConfirmation("");
									}}
								/>
							</label>
							<p className="text-xs text-muted-foreground">广告平台导出的表格需要先转换为 AdPulse 报表。</p>
							<Button type="submit" disabled={importMutation.isPending || !reportFile}>
								{importMutation.isPending
									? "导入中…"
									: importOperation.current ? "重试导入" : "导入报表"}
							</Button>
						</form>
					</details>
					{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
					{confirmation ? <p role="status" className="text-sm">{confirmation}</p> : null}
				</CardContent>
			</Card>
			{latestReport ? (
				<>
					<ReviewSection title="对比表现或检查成本" description="选择要查看的报表，检查成本是否超标，或与另一时段对比。">
						<ComparisonPanel taskId={taskId} items={reports} />
					</ReviewSection>
					<ReviewSection title="成本提醒" description="查看需要跟进的成本异常和处理进度。">
						<InvestigationAlertsPanel taskId={taskId} />
					</ReviewSection>
				</>
			) : null}
		</>
	);
}

function ReviewSection({ title, description, children }: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<details className="group rounded-xl border bg-card">
			<summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden">
				<ChevronRight aria-hidden="true" className="size-4 shrink-0 group-open:rotate-90" />
				<span>
					<span className="block text-sm font-semibold">{title}</span>
					<span className="block text-xs text-muted-foreground">{description}</span>
				</span>
			</summary>
			<div className="px-3 pb-3">{children}</div>
		</details>
	);
}

function EvidenceItem({ item }: { item: EvidenceVersion }) {
	const [expanded, setExpanded] = useState(false);
	const [correctionFile, setCorrectionFile] = useState<File | null>(null);
	const [reason, setReason] = useState("");
	const [revisionError, setRevisionError] = useState("");
	const [revisionConfirmation, setRevisionConfirmation] = useState("");
	const queryClient = useQueryClient();
	const correctionInput = useRef<HTMLInputElement>(null);
	const revisionOperation = useRef<ReportOperation<EvidenceRevision> | null>(null);
	const detail = useQuery({
		queryKey: ["evidence", item.evidenceId],
		enabled: expanded,
		queryFn: async () => {
			const result = await consoleClient.GET("/api/evidence/{evidenceId}", {
				params: { path: { evidenceId: item.evidenceId } },
			});
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data;
		},
	});
	const revise = useMutation({
		mutationFn: async (file: File) => {
			const operation = revisionOperation.current ?? {
				key: crypto.randomUUID(),
				body: {
					expectedEvidenceVersion: detail.data?.current.version ?? item.version,
					reason: reason.trim(),
					record: await readEvidenceCorrection(file),
				},
			};
			revisionOperation.current = operation;
			const result = await consoleClient.POST(
				"/api/evidence/{evidenceId}/revisions",
				{
					params: {
						path: { evidenceId: item.evidenceId },
						header: { "Idempotency-Key": operation.key },
					},
					body: operation.body,
				},
			);
			if (!result.data) {
				const { status } = result.response;
				if (status >= 400 && status < 500) revisionOperation.current = null;
				throw reportError(status, "报表版本有更新，请刷新详情并核对后再更正。");
			}
			return result.data;
		},
		onSuccess: async ({ version }) => {
			revisionOperation.current = null;
			setRevisionError("");
			setRevisionConfirmation(`已保存更正，当前为 v${version}。`);
			setCorrectionFile(null);
			if (correctionInput.current) correctionInput.current.value = "";
			setReason("");
			await queryClient.invalidateQueries({
				queryKey: ["evidence", item.evidenceId],
			});
			await queryClient.invalidateQueries({
				queryKey: ["task-evidence", item.taskId],
			});
		},
		onError: (cause) => setRevisionError(
			revisionOperation.current
				? "暂时无法确认更正结果，请重试同一次更正。"
				: cause.message,
		),
	});

	return (
		<div className="rounded-lg border bg-muted/25 p-4 text-sm">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<p className="font-medium">
						{formatBeijingPeriod(item.period)}
					</p>
					<p className="text-muted-foreground">
						计划 {item.scope.planRef}
						{item.period.completeness === "partial" ? " · 部分时段" : ""}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? "收起详情" : "报表详情"}
				</Button>
			</div>
			<dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-3">
				<div>
					<dt className="text-muted-foreground">投放花费</dt>
					<dd className="break-words text-xl font-semibold tabular-nums">{formatSpend(item)}</dd>
				</div>
				<div className="border-l pl-3">
					<dt className="text-muted-foreground">咨询次数</dt>
					<dd className="break-words text-xl font-semibold tabular-nums">{formatValue(item.values.consultations, "次")}</dd>
				</div>
			</dl>
			{expanded ? (
				<div className="mt-3 space-y-3 border-t pt-3">
					{detail.isLoading ? <p>正在读取详情…</p> : null}
					{detail.error ? (
						<p role="alert" className="text-red-600">
							读取失败：{String(detail.error)}
						</p>
					) : null}
					{detail.data ? (
						<>
							<div>
								<h3 className="font-medium">来源与原始值</h3>
								{detail.data.sources.map((source) => (
									<div key={source.id} className="mt-2 rounded bg-muted/40 p-2">
										<p>
											证据 v{source.evidenceVersion} · {source.source.platform}{" "}
											· 账户 {source.source.accountRef} · 报表{" "}
											{source.source.reportRef}
										</p>
										{source.source.sourceUri ? (
											<a
												className="text-primary underline"
												href={source.source.sourceUri}
												target="_blank"
												rel="noreferrer"
											>
												打开来源引用
											</a>
										) : null}
										<details className="mt-1">
											<summary className="cursor-pointer text-xs">查看报表原始值</summary>
											<pre className="whitespace-pre-wrap text-xs">
												{JSON.stringify(source.rawValues, null, 2)}
											</pre>
										</details>
									</div>
								))}
							</div>
							<div className="rounded bg-muted/40 p-2">
								<h3 className="font-medium">口径与归因</h3>
								<p>任务第 {item.taskVersion} 版 · 报表第 {item.version} 版 · 来源时区 {item.period.timeZone}</p>
								<p>
									范围：{detail.data.current.scope.planRef} ·{" "}
									{detail.data.current.scope.campaignRefs.join(", ") ||
										"计划整体"}
								</p>
								<p>
									币种/最小单位：{detail.data.current.currency.code} /{" "}
									{detail.data.current.currency.minorUnit}（每主单位{" "}
									{detail.data.current.currency.minorUnitsPerMajor}）
								</p>
								<p>
									归因：{detail.data.current.attribution.model} · 窗口{" "}
									{detail.data.current.attribution.windowDays === undefined
										? "未知"
										: `${detail.data.current.attribution.windowDays} 天`}
								</p>
								<p>回传状态：{detail.data.current.callbackStatus}</p>
								<p>
									消耗定义/公式：
									{detail.data.current.metricsContract.spendMinor.definition} /{" "}
									{detail.data.current.metricsContract.spendMinor.formula}
								</p>
								<p>
									咨询定义/公式：
									{detail.data.current.metricsContract.consultations.definition}{" "}
									/ {detail.data.current.metricsContract.consultations.formula}
								</p>
							</div>
							<div>
								<h3 className="font-medium">报表更正记录</h3>
								<ol className="mt-1 list-decimal pl-5">
									{detail.data.versions.map((version) => (
										<li key={version.id}>
											v{version.version} · {version.createdAt}
											{version.reason ? ` · ${version.reason}` : " · 初次导入"}
										</li>
									))}
								</ol>
							</div>
							<details className="rounded border p-2">
								<summary className="cursor-pointer font-medium">
									更正报表
								</summary>
								<form
									className="mt-2 space-y-2"
									onSubmit={(event) => {
										event.preventDefault();
										if (!correctionFile || !reason.trim() || revise.isPending) return;
										setRevisionError("");
										setRevisionConfirmation("");
										revise.mutate(correctionFile);
									}}
								>
									<p className="text-muted-foreground">
										上传同一区间的更正文件，并说明更正原因。历史版本仍可查看。
									</p>
									<Input
										aria-label="修订原因"
										placeholder="更正原因（必填）"
										value={reason}
										required
										maxLength={1000}
										disabled={revise.isPending || revisionOperation.current !== null}
										onChange={(event) => setReason(event.target.value)}
									/>
									<label className="block space-y-1">
										<span>选择单区间更正文件（.json）</span>
										<Input
											ref={correctionInput}
											type="file"
											accept=".json,application/json"
											className="h-auto py-2"
											disabled={revise.isPending || revisionOperation.current !== null}
											onChange={(event) => {
												setCorrectionFile(event.target.files?.[0] ?? null);
												setRevisionError("");
												setRevisionConfirmation("");
											}}
										/>
									</label>
									{revisionError ? (
										<p role="alert" className="text-red-600">
											{revisionError}
										</p>
									) : null}
									{revisionConfirmation ? <p role="status">{revisionConfirmation}</p> : null}
									<Button
										type="submit"
										disabled={
											revise.isPending || !reason.trim() || !correctionFile
										}
									>
										{revise.isPending
											? "保存中…"
											: revisionOperation.current ? "重试更正" : "保存更正"}
									</Button>
								</form>
							</details>
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function formatValue(value: number | null | undefined, unit: string): string {
	if (value === undefined) return "未提供";
	if (value === null) return "报表留空";
	return `${value.toLocaleString("zh-CN")} ${unit}`;
}

function formatSpend({ values, currency }: EvidenceVersion): string {
	const { spendMinor } = values;
	const { code, minorUnit, minorUnitsPerMajor } = currency;
	if (spendMinor == null || minorUnitsPerMajor !== 100) {
		return formatValue(spendMinor, `${minorUnit} (${code})`);
	}
	const whole = Math.floor(spendMinor / 100).toLocaleString("zh-CN");
	const cents = String(spendMinor % 100).padStart(2, "0");
	return `${whole}.${cents} ${code === "CNY" ? "元" : code}`;
}
