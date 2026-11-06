import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
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

type EvidenceImportInput = components["schemas"]["EvidenceImportInput"];
type EvidenceRevision = components["schemas"]["EvidenceRevision"];
type EvidenceVersion = components["schemas"]["EvidenceVersion"];

export function EvidencePanel({
	taskId,
	taskVersion,
}: {
	taskId: string;
	taskVersion: number;
}) {
	const queryClient = useQueryClient();
	const [json, setJson] = useState("");
	const [error, setError] = useState("");
	const importKey = useRef<string | null>(null);
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
		mutationFn: async () => {
			let input: EvidenceImportInput;
			try {
				input = JSON.parse(json) as EvidenceImportInput;
			} catch {
				throw new Error("请检查 JSON 格式");
			}
			if (
				input.schemaVersion !== 1 ||
				input.taskRef?.taskId !== taskId ||
				input.taskRef?.taskVersion !== taskVersion
			)
				throw new Error(`taskRef 必须是当前任务版本 ${taskId} v${taskVersion}`);
			const key = importKey.current ?? crypto.randomUUID();
			importKey.current = key;
			const result = await consoleClient.POST("/api/evidence/imports", {
				body: input,
				params: { header: { "Idempotency-Key": key } },
			});
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data;
		},
		onSuccess: async () => {
			importKey.current = null;
			setError("");
			setJson("");
			await queryClient.invalidateQueries({
				queryKey: ["task-evidence", taskId],
			});
		},
		onError: (cause) => setError(String(cause)),
	});

	return (
		<Card>
			<CardHeader>
				<CardTitle>效果证据</CardTitle>
				<p className="text-sm text-muted-foreground">
					导入固定 JSON；每批 1–2 个区间，必须引用当前任务版本。缺失、来源 null
					与真实 0 保持区分。
				</p>
			</CardHeader>
			<CardContent className="space-y-4">
				<details className="rounded border p-3 text-sm">
					<summary className="cursor-pointer font-medium">
						字段与去重规则
					</summary>
					<ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
						<li>
							必填来源、账户/计划范围、时间区间/时区、指标定义/公式、币种最小单位、归因和回传状态。
						</li>
						<li>
							values 中省略为未知，null 为来源明确为空，0 为真实零；rawValues
							原样保留。
						</li>
						<li>同业务范围与内容复用证据；内容变更需提交带原因的新版本。</li>
					</ul>
				</details>
				<form
					className="space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						setError("");
						importMutation.mutate();
					}}
				>
					<label className="block space-y-1 text-sm">
						<span>固定 JSON 导入内容</span>
						<textarea
							className="min-h-56 w-full rounded-md border bg-background p-3 font-mono text-xs"
							value={json}
							placeholder={`{
  "schemaVersion": 1,
  "taskRef": { "taskId": "${taskId}", "taskVersion": ${taskVersion} },
  "records": []
}`}
							onChange={(event) => setJson(event.target.value)}
						/>
					</label>
					{error ? (
						<p role="alert" className="text-sm text-red-600">
							导入失败：{error}
						</p>
					) : null}
					<Button
						type="submit"
						disabled={importMutation.isPending || !json.trim()}
					>
						{importMutation.isPending ? "导入中…" : "校验并导入"}
					</Button>
				</form>
				{evidence.isLoading ? <p className="text-sm">正在加载证据…</p> : null}
				{evidence.error ? (
					<p role="alert" className="text-sm text-red-600">
						读取证据失败：{String(evidence.error)}
					</p>
				) : null}
				{evidence.data?.length ? (
					<div className="space-y-3">
						{evidence.data.map((item) => (
							<EvidenceItem key={item.evidenceId} item={item} />
						))}
					</div>
				) : !evidence.isLoading ? (
					<p className="text-sm text-muted-foreground">尚无效果证据。</p>
				) : null}
			</CardContent>
			<div className="px-6 pb-6">
				<ComparisonPanel taskId={taskId} items={evidence.data ?? []} />
			</div>
		</Card>
	);
}

function EvidenceItem({ item }: { item: EvidenceVersion }) {
	const [expanded, setExpanded] = useState(false);
	const [revisionText, setRevisionText] = useState("");
	const [reason, setReason] = useState("");
	const [revisionError, setRevisionError] = useState("");
	const queryClient = useQueryClient();
	const revisionKey = useRef<string | null>(null);
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
		mutationFn: async () => {
			let record: EvidenceRevision["record"];
			try {
				record = JSON.parse(revisionText) as EvidenceRevision["record"];
			} catch {
				throw new Error("修订记录不是有效 JSON");
			}
			const key = revisionKey.current ?? crypto.randomUUID();
			revisionKey.current = key;
			const result = await consoleClient.POST(
				"/api/evidence/{evidenceId}/revisions",
				{
					params: {
						path: { evidenceId: item.evidenceId },
						header: { "Idempotency-Key": key },
					},
					body: {
						expectedEvidenceVersion:
							detail.data?.current.version ?? item.version,
						reason,
						record,
					},
				},
			);
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data;
		},
		onSuccess: async () => {
			revisionKey.current = null;
			setRevisionError("");
			setRevisionText("");
			setReason("");
			await queryClient.invalidateQueries({
				queryKey: ["evidence", item.evidenceId],
			});
			await queryClient.invalidateQueries({
				queryKey: ["task-evidence", item.taskId],
			});
		},
		onError: (cause) => setRevisionError(String(cause)),
	});

	return (
		<div className="rounded border p-3 text-sm">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<p className="font-medium">
						{item.period.startsAt} – {item.period.endsAt} (
						{item.period.timeZone})
					</p>
					<p className="text-muted-foreground">
						计划 {item.scope.planRef} · 任务 v{item.taskVersion} / 证据 v
						{item.version} ·{" "}
						{item.period.completeness === "complete" ? "完整区间" : "部分区间"}
					</p>
					<p className="text-muted-foreground">
						消耗：{formatValue(item.values.spendMinor, item.currency.minorUnit)}{" "}
						· 咨询：{formatValue(item.values.consultations, "次")}
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? "收起详情" : "来源与修订记录"}
				</Button>
			</div>
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
										<pre className="mt-1 whitespace-pre-wrap text-xs">
											{JSON.stringify(source.rawValues, null, 2)}
										</pre>
									</div>
								))}
							</div>
							<div className="rounded bg-muted/40 p-2">
								<h3 className="font-medium">口径与归因</h3>
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
								<h3 className="font-medium">不可变版本历史</h3>
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
									提交显式修订
								</summary>
								<div className="mt-2 space-y-2">
									<Input
										aria-label="修订原因"
										placeholder="修订原因（必填）"
										value={reason}
										onChange={(event) => setReason(event.target.value)}
									/>
									<textarea
										className="min-h-40 w-full rounded-md border bg-background p-2 font-mono text-xs"
										placeholder="粘贴一条完整的 EvidenceRecordInput JSON（不含 taskRef）"
										value={revisionText}
										onChange={(event) => setRevisionText(event.target.value)}
									/>
									{revisionError ? (
										<p role="alert" className="text-red-600">
											修订失败：{revisionError}
										</p>
									) : null}
									<Button
										type="button"
										disabled={
											revise.isPending || !reason.trim() || !revisionText.trim()
										}
										onClick={() => revise.mutate()}
									>
										{revise.isPending
											? "保存中…"
											: `保存为 v${(detail.data.current.version ?? item.version) + 1}`}
									</Button>
								</div>
							</details>
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function formatValue(value: number | null | undefined, unit: string): string {
	if (value === undefined) return "未知";
	if (value === null) return "来源为空";
	return `${value} ${unit}`;
}
