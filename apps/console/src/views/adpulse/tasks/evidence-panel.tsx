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
import { readEvidenceCorrection, readEvidenceImport, type ReportSummary } from "./evidence-file";
import { InvestigationAlertsPanel } from "./investigation-alerts-panel";
import { QuickReviewPanel } from "./review-quick-panel";
import { formatBeijingPeriod, formatBeijingTime } from "./task-form";

type EvidenceImportInput = components["schemas"]["EvidenceImportInput"];
type EvidenceRevision = components["schemas"]["EvidenceRevision"];
type EvidenceVersion = components["schemas"]["EvidenceVersion"];

type ReportOperation<Body> = { key: string; body: Body };

function reportError(status: number, conflict: string): Error {
	if (status === 401 || status === 403)
		return new Error("当前账号没有操作权限，请确认登录后重试。");
	if (status === 413) return new Error("报表文件过大，请分批导入。");
	if (status === 409) return new Error(conflict);
	return new Error("这份报表无法保存，请检查是不是当前任务的报表，以及统计时间是否正确。");
}

export function EvidencePanel({
	taskId,
	taskVersion,
	rules,
}: {
	taskId: string;
	taskVersion: number;
	rules: components["schemas"]["TaskRules"];
}) {
	const queryClient = useQueryClient();
	const [error, setError] = useState("");
	const [confirmation, setConfirmation] = useState("");
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
		mutationFn: async (body: EvidenceImportInput) => {
			const operation = importOperation.current ?? {
				key: crypto.randomUUID(),
				body,
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
						{empty ? "还没有正式报表。手上有大概的数字，可以先试算。" : "正式报表按结束时间排列，时间均为北京时间。"}
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
					<QuickReviewPanel rules={rules} startOpen={empty} />
					<details className="rounded-lg border">
						<summary className="cursor-pointer px-4 py-3 text-sm font-medium">
							<FileUp aria-hidden="true" className="mr-2 inline size-4" />
							导入正式报表
						</summary>
						<ReportUpload
							key={taskVersion}
							fileLabel="选择任务报表"
							parse={(file) => readEvidenceImport(file, { taskId, taskVersion })}
							rows={(report) => report.records}
							pending={importMutation.isPending}
							retrying={importOperation.current !== null}
							saved={Boolean(confirmation)}
							confirmLabel="确认并保存报表"
							onReset={() => { setError(""); setConfirmation(""); }}
							onConfirm={(report) => importMutation.mutate(report)}
						/>
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

function ReportUpload<T>({
	fileLabel, parse, rows, pending, retrying, saved, confirmLabel, canConfirm = true,
	onReset, onConfirm, children,
}: {
	fileLabel: string;
	parse: (file: File) => Promise<T>;
	rows: (report: T) => ReportSummary[];
	pending: boolean;
	retrying: boolean;
	saved: boolean;
	confirmLabel: string;
	canConfirm?: boolean;
	onReset: () => void;
	onConfirm: (report: T) => void;
	children?: ReactNode;
}) {
	const [preview, setPreview] = useState<{ fileName: string; report: T }>();
	const [reading, setReading] = useState(false);
	const [readError, setReadError] = useState("");

	async function select(file: File) {
		setReading(true);
		setPreview(undefined);
		setReadError("");
		onReset();
		try {
			setPreview({ fileName: file.name, report: await parse(file) });
		} catch (cause) {
			setReadError(cause instanceof Error ? cause.message : "无法读取这份报表。");
		} finally {
			setReading(false);
		}
	}

	return (
		<form className="space-y-3 border-t p-4 text-sm" onSubmit={(event) => {
			event.preventDefault();
			if (preview && !pending && !saved && canConfirm) onConfirm(preview.report);
		}}>
			<label className="block space-y-1">
				<span className="font-medium">{fileLabel}</span>
				<Input type="file" accept=".json,application/json" disabled={pending || retrying || reading}
					className="h-auto py-2"
					onChange={(event) => {
						const file = event.currentTarget.files?.[0];
						event.currentTarget.value = "";
						if (file) void select(file);
					}} />
			</label>
			{reading ? <p role="status">正在读取报表…</p> : null}
			{readError ? <p role="alert" className="text-destructive">{readError}</p> : null}
			{preview ? (
				<>
					<div className="rounded-md border bg-muted/25 p-3">
						<p className="font-medium">{saved ? "已核对的报表" : "核对报表数据"}</p>
						<p className="break-all text-xs text-muted-foreground">{preview.fileName}</p>
						<ReportTable rows={rows(preview.report)} />
					</div>
					{saved ? null : (
						<>
							{children}
							<Button type="submit" disabled={pending || !canConfirm}>
								{pending ? "正在保存…" : retrying ? "重试保存" : confirmLabel}
							</Button>
						</>
					)}
				</>
			) : null}
		</form>
	);
}

function ReportTable({ rows }: { rows: ReportSummary[] }) {
	return (
		<div className="mt-2 overflow-x-auto">
			<table className="w-full text-left text-sm">
				<thead className="text-xs text-muted-foreground">
					<tr>
						<th scope="col" className="p-2 font-medium">统计时间（北京）</th>
						<th scope="col" className="p-2 font-medium">投放花费</th>
						<th scope="col" className="p-2 font-medium">咨询次数</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row, index) => (
						<tr key={index} className="border-t">
							<td className="p-2">{formatBeijingPeriod(row.period)}</td>
							<td className="p-2 tabular-nums">{formatSpend(row)}</td>
							<td className="p-2 tabular-nums">{formatValue(row.values.consultations, "次")}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function EvidenceItem({ item }: { item: EvidenceVersion }) {
	const [expanded, setExpanded] = useState(false);
	const [reason, setReason] = useState("");
	const [revisionError, setRevisionError] = useState("");
	const [revisionConfirmation, setRevisionConfirmation] = useState("");
	const queryClient = useQueryClient();
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
	const currentVersion = detail.data?.current.version ?? item.version;
	const revise = useMutation({
		mutationFn: async (correction: Pick<EvidenceRevision, "record" | "expectedEvidenceVersion">) => {
			const operation = revisionOperation.current ?? {
				key: crypto.randomUUID(),
				body: {
					...correction,
					reason: reason.trim(),
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
							<details className="rounded border p-2">
								<summary className="cursor-pointer font-medium">报表更正记录</summary>
								<ol className="mt-1 list-decimal pl-5">
									{detail.data.versions.map((version) => (
										<li key={version.id}>
											第 {version.version} 版 · {formatBeijingTime(version.createdAt)}
											{version.reason ? ` · ${version.reason}` : " · 初次导入"}
										</li>
									))}
								</ol>
							</details>
							<details className="rounded border p-2">
								<summary className="cursor-pointer font-medium">
									更正报表
								</summary>
								<ReportUpload
									fileLabel="选择更正后的报表"
									parse={async (file) => ({
										expectedEvidenceVersion: currentVersion,
										record: await readEvidenceCorrection(file),
									})}
									rows={({ record }) => [record]}
									pending={revise.isPending}
									retrying={revisionOperation.current !== null}
									saved={Boolean(revisionConfirmation)}
									confirmLabel="确认并保存更正"
									canConfirm={Boolean(reason.trim())}
									onReset={() => { setRevisionError(""); setRevisionConfirmation(""); }}
									onConfirm={(correction) => revise.mutate(correction)}
								>
									<label className="block space-y-1">
										<span>更正原因</span>
										<Input value={reason} placeholder="例如：漏计了一次咨询"
											maxLength={1000} disabled={revise.isPending || revisionOperation.current !== null}
											onChange={(event) => setReason(event.target.value)} />
									</label>
								</ReportUpload>
								{revisionError ? <p role="alert" className="text-destructive">{revisionError}</p> : null}
								{revisionConfirmation ? <p role="status">{revisionConfirmation}</p> : null}
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

function formatSpend({ values, currency }: ReportSummary): string {
	const { spendMinor } = values;
	const { code, minorUnit, minorUnitsPerMajor } = currency;
	if (spendMinor == null || minorUnitsPerMajor !== 100) {
		return formatValue(spendMinor, `${minorUnit} (${code})`);
	}
	const whole = Math.floor(spendMinor / 100).toLocaleString("zh-CN");
	const cents = String(spendMinor % 100).padStart(2, "0");
	return `${whole}.${cents} ${code === "CNY" ? "元" : code}`;
}
