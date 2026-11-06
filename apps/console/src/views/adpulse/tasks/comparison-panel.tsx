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

type EvidenceVersion = components["schemas"]["EvidenceVersion"];
type EvidenceRef = components["schemas"]["EvidenceRef"];
type ComparisonResult = components["schemas"]["ComparisonResult"];
type ComparisonFollowUp = components["schemas"]["ComparisonFollowUp"];
type EvidenceDetail = components["schemas"]["EvidenceDetail"];

const statusLabels: Record<ComparisonResult["status"], string> = {
	comparable: "可比较",
	incomparable: "不可比较",
	awaiting_supplementation: "等待补充",
	missing_baseline: "未选择历史基线",
	temporarily_uncomputable: "暂不可计算",
};
const thresholdLabels: Record<
	ComparisonResult["thresholdEvaluation"]["status"],
	string
> = {
	exceeded: "超过阈值",
	not_exceeded: "未超过阈值",
	not_evaluated: "未评估",
};
const actionLabels: Record<
	ComparisonFollowUp["remediation"]["action"],
	string
> = {
	provide_evidence: "补充或修订证据",
	revise_task_rules: "创建完整的任务规则版本",
	verify_source: "核实来源数值",
	none: "需人工审查",
};
const completionLabels: Record<
	ComparisonFollowUp["remediation"]["completionCriteria"],
	string
> = {
	matching_complete_evidence_version: "关联满足口径与区间要求的完整证据版本",
	complete_task_rule_version: "关联在本事项创建后新建且规则完整的任务版本",
	source_confirms_zero: "关联来源确认的真实零值证据",
	manual_review: "人工审查后处理",
};

function versionLabel(version: EvidenceVersion) {
	return `v${version.version} · ${version.period.startsAt} – ${version.period.endsAt} (${version.period.timeZone})`;
}

function EvidenceSelector({
	label,
	items,
	evidenceId,
	version,
	onEvidenceChange,
	onVersionChange,
}: {
	label: string;
	items: EvidenceVersion[];
	evidenceId: string;
	version: string;
	onEvidenceChange: (value: string) => void;
	onVersionChange: (value: string) => void;
}) {
	const detail = useQuery({
		queryKey: ["evidence", evidenceId],
		enabled: Boolean(evidenceId),
		queryFn: async () => {
			const result = await consoleClient.GET("/api/evidence/{evidenceId}", {
				params: { path: { evidenceId } },
			});
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data as EvidenceDetail;
		},
	});
	const options = detail.data?.versions ?? [];
	return (
		<div className="space-y-2">
			<label className="block space-y-1 text-sm">
				<span>{label}证据</span>
				<select
					className="w-full rounded-md border bg-background p-2"
					value={evidenceId}
					onChange={(event) => onEvidenceChange(event.target.value)}
				>
					<option value="">请选择证据</option>
					{items.map((item) => (
						<option key={item.evidenceId} value={item.evidenceId}>
							{item.period.startsAt} – {item.period.endsAt} · {item.scope.planRef} ·
							当前 v{item.version}
						</option>
					))}
				</select>
			</label>
			<label className="block space-y-1 text-sm">
				<span>{label}版本（须显式选择）</span>
				<select
					className="w-full rounded-md border bg-background p-2"
					value={version}
					disabled={!evidenceId || detail.isLoading}
					onChange={(event) => onVersionChange(event.target.value)}
				>
					<option value="">请选择不可变版本</option>
					{options.map((item) => (
						<option key={item.id} value={String(item.version)}>
							{versionLabel(item)}
							{item.version === detail.data?.current.version ? " · 当前" : " · 历史"}
						</option>
					))}
				</select>
				{detail.error ? (
					<span role="alert" className="text-xs text-red-600">
						读取证据版本失败：{String(detail.error)}
					</span>
				) : null}
			</label>
		</div>
	);
}

export function ComparisonPanel({
	taskId,
	items,
}: {
	taskId: string;
	items: EvidenceVersion[];
}) {
	const queryClient = useQueryClient();
	const [currentId, setCurrentId] = useState("");
	const [currentVersion, setCurrentVersion] = useState("");
	const [baselineChoice, setBaselineChoice] = useState("");
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
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data.items;
		},
	});
	const followUps = useQuery({
		queryKey: ["task-comparison-follow-ups", taskId],
		queryFn: async () => {
			const result = await consoleClient.GET(
				"/api/tasks/{taskId}/comparison-follow-ups",
				{ params: { path: { taskId } } },
			);
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data.items;
		},
	});
	const evaluate = useMutation({
		mutationFn: async () => {
			if (!currentId || !currentVersion || !baselineChoice)
				throw new Error("请显式选择当前证据版本，并选择是否使用历史基线");
			if (baselineChoice === "selected" && (!baselineId || !baselineVersion))
				throw new Error("请显式选择历史证据及其不可变版本");
			const current: EvidenceRef = {
				evidenceId: currentId,
				version: Number(currentVersion),
			};
			const baseline: EvidenceRef | undefined =
				baselineChoice === "selected"
					? { evidenceId: baselineId, version: Number(baselineVersion) }
					: undefined;
			const key = operationKey.current ?? crypto.randomUUID();
			operationKey.current = key;
			const result = await consoleClient.POST("/api/comparisons/evaluate", {
				body: { current, ...(baseline ? { baseline } : {}) },
				params: { header: { "Idempotency-Key": key } },
			});
			if (!result.data) throw new Error(JSON.stringify(result.error));
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
		onError: (cause) => setError(String(cause)),
	});
	const resetKey = () => {
		operationKey.current = null;
		setError("");
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>显式证据比较</CardTitle>
				<p className="text-sm text-muted-foreground">
					不会自动选择历史基线。比较仅说明数据是否可比及数值变化，不代表因果关系，也不会执行广告操作。
				</p>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid gap-4 md:grid-cols-2">
					<EvidenceSelector
						label="当前"
						items={items}
						evidenceId={currentId}
						version={currentVersion}
						onEvidenceChange={(value) => {
							resetKey();
						setCurrentId(value);
						setCurrentVersion("");
						}}
						onVersionChange={(value) => {
							resetKey();
							setCurrentVersion(value);
						}}
					/>
					<div className="space-y-2">
						<label className="block space-y-1 text-sm">
							<span>历史基线</span>
							<select
								className="w-full rounded-md border bg-background p-2"
								value={baselineChoice}
								onChange={(event) => {
									resetKey();
									setBaselineChoice(event.target.value);
									setBaselineId("");
									setBaselineVersion("");
								}}
							>
								<option value="">请选择比较方式</option>
								<option value="none">不使用历史基线（只评估当前阈值）</option>
								<option value="selected">显式选择历史基线</option>
							</select>
						</label>
						{baselineChoice === "selected" ? (
							<EvidenceSelector
								label="历史"
								items={items}
								evidenceId={baselineId}
								version={baselineVersion}
								onEvidenceChange={(value) => {
									resetKey();
									setBaselineId(value);
									setBaselineVersion("");
								}}
								onVersionChange={(value) => {
									resetKey();
									setBaselineVersion(value);
								}}
							/>
						) : null}
					</div>
				</div>
				{error ? (
					<p role="alert" className="text-sm text-red-600">
						比较失败：{error}
					</p>
				) : null}
				<Button
					type="button"
					disabled={
						evaluate.isPending ||
						!currentId ||
						!currentVersion ||
						!baselineChoice ||
						(baselineChoice === "selected" &&
							(!baselineId || !baselineVersion))
					}
					onClick={() => evaluate.mutate()}
				>
					{evaluate.isPending ? "评估中…" : "保存不可变评估"}
				</Button>

				<section className="space-y-3 border-t pt-4">
					<h3 className="font-semibold">比较历史</h3>
					{comparisons.isLoading ? <p className="text-sm">正在加载…</p> : null}
					{comparisons.error ? (
						<p role="alert" className="text-sm text-red-600">
							读取失败：{String(comparisons.error)}
						</p>
					) : null}
					{comparisons.data?.length ? (
						<ol className="space-y-3">
							{comparisons.data.map((item) => (
								<ComparisonHistoryItem key={item.id} item={item} />
							))}
						</ol>
					) : !comparisons.isLoading ? (
						<p className="text-sm text-muted-foreground">尚无评估历史。</p>
					) : null}
				</section>

				<section className="space-y-3 border-t pt-4">
					<h3 className="font-semibold">待跟进事项</h3>
					{followUps.isLoading ? <p className="text-sm">正在加载…</p> : null}
					{followUps.error ? (
						<p role="alert" className="text-sm text-red-600">
							读取失败：{String(followUps.error)}
						</p>
					) : null}
					{followUps.data?.length ? (
						<ul className="space-y-3">
							{followUps.data.map((item) => (
								<FollowUpItem key={item.id} item={item} taskId={taskId} />
							))}
						</ul>
					) : !followUps.isLoading ? (
						<p className="text-sm text-muted-foreground">尚无跟进事项。</p>
					) : null}
				</section>
			</CardContent>
		</Card>
	);
}

function ComparisonHistoryItem({ item }: { item: ComparisonResult }) {
	return (
		<li className="rounded border p-3 text-sm">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<strong>{statusLabels[item.status]}</strong>
				<span className="text-xs text-muted-foreground">
					{new Date(item.createdAt).toLocaleString()} · 规则 v{item.rulesRef.version} ·
					评估器 v{item.evaluatorVersion}
				</span>
			</div>
			<p className="mt-1 text-muted-foreground">
				当前 {item.current.evidenceId} v{item.current.version}
				{item.baseline
					? ` · 历史 ${item.baseline.evidenceId} v${item.baseline.version}`
					: " · 未选择历史基线"}
			</p>
			<p>
				区间比较：{item.canComparePeriods ? "可比较" : "未形成可比较结论"} · 当前阈值：
				{thresholdLabels[item.thresholdEvaluation.status]}
			</p>
			{item.comparisons.spendMinor ? (
				<p>
					消耗：{item.comparisons.spendMinor.baseline} → {item.comparisons.spendMinor.current}（变化 {item.comparisons.spendMinor.delta}）
				</p>
			) : null}
			{item.comparisons.consultations ? (
				<p>
					咨询：{item.comparisons.consultations.baseline} → {item.comparisons.consultations.current}（变化 {item.comparisons.consultations.delta}）
				</p>
			) : null}
			{item.comparisons.costPerConsultation ? (
				<p>
					每次咨询成本方向：{item.comparisons.costPerConsultation.direction}（精确比值使用分子/分母保存）
				</p>
			) : null}
			{item.thresholdEvaluation.value ? (
				<p>
					当前每次咨询成本：{item.thresholdEvaluation.value.numeratorMinor} / {item.thresholdEvaluation.value.denominatorConsultations} 最小货币单位
					{item.thresholdEvaluation.thresholdMinor !== undefined
						? ` · 阈值 ${item.thresholdEvaluation.thresholdMinor}`
						: ""}
					{item.thresholdEvaluation.currency
						? ` ${item.thresholdEvaluation.currency}`
						: ""}
				</p>
			) : null}
			{item.reasons.length ? (
				<div className="mt-2 border-t pt-2">
					<p className="font-medium">原因与处理建议</p>
					<ul className="mt-1 list-disc space-y-1 pl-5">
						{item.reasons.map((reason, index) => (
							<li key={`${reason.code}-${reason.axis}-${index}`}>
								<code>{reason.code}</code>（{reason.axis}）：
								{actionLabels[reason.remediation.action]}；
								{completionLabels[reason.remediation.completionCriteria]}
								{reason.evidenceRef
									? ` · 证据 ${reason.evidenceRef.evidenceId} v${reason.evidenceRef.version}`
									: ""}
							</li>
						))}
					</ul>
				</div>
			) : null}
		</li>
	);
}

function FollowUpItem({
	item,
	taskId,
}: {
	item: ComparisonFollowUp;
	taskId: string;
}) {
	const queryClient = useQueryClient();
	const [evidenceId, setEvidenceId] = useState("");
	const [version, setVersion] = useState("");
	const [error, setError] = useState("");
	const operationKey = useRef<string | null>(null);
	const resolve = useMutation({
		mutationFn: async () => {
			if (!version || !Number.isSafeInteger(Number(version)) || Number(version) < 1)
				throw new Error("请输入有效的版本号");
			const material =
				item.resolutionKind === "evidence"
					? evidenceId
						? {
								kind: "evidence" as const,
								evidenceId,
								version: Number(version),
							}
						: null
					: { kind: "task_version" as const, taskId, version: Number(version) };
			if (!material) throw new Error("请输入要关联的证据 ID");
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
			if (!result.data) throw new Error(JSON.stringify(result.error));
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
		onError: (cause) => setError(String(cause)),
	});

	return (
		<li className="rounded border p-3 text-sm">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<strong>
					{item.status === "open" ? "待处理" : "已完成"} · {item.reasonCode}
				</strong>
				<span className="text-xs text-muted-foreground">
					任务 v{item.taskVersion} · {item.axis}
				</span>
			</div>
			<p className="mt-1">
				建议：{actionLabels[item.remediation.action]}。完成标准：
				{completionLabels[item.remediation.completionCriteria]}。
			</p>
			{item.source ? (
				<p className="text-muted-foreground">
					来源需匹配：{item.source.platform} · 账户 {item.source.accountRef}
				</p>
			) : null}
			{item.scope ? (
				<p className="text-muted-foreground">
					范围：{item.scope.planRef} · {item.scope.campaignRefs.join(", ") || "计划整体"}
				</p>
			) : null}
			{item.period ? (
				<p className="text-muted-foreground">
					区间：{item.period.startsAt} – {item.period.endsAt}（{item.period.timeZone}）
				</p>
			) : null}
			{item.status === "open" && item.remediation.action !== "none" ? (
				<div className="mt-3 flex flex-wrap items-end gap-2">
					{item.resolutionKind === "evidence" ? (
						<Input
							aria-label="用于完成跟进的证据 ID"
							placeholder="证据 ID"
							value={evidenceId}
							onChange={(event) => {
								operationKey.current = null;
								setEvidenceId(event.target.value);
							}}
						/>
					) : null}
					<Input
						aria-label={item.resolutionKind === "evidence" ? "证据版本" : "新任务版本"}
						placeholder={item.resolutionKind === "evidence" ? "证据版本" : "新任务版本"}
						inputMode="numeric"
						value={version}
						onChange={(event) => {
							operationKey.current = null;
							setVersion(event.target.value);
						}}
					/>
					<Button
						type="button"
						variant="outline"
						disabled={resolve.isPending}
						onClick={() => {
							setError("");
							resolve.mutate();
						}}
					>
						{resolve.isPending ? "校验中…" : "校验并关联完成材料"}
					</Button>
				</div>
			) : null}
			{error ? (
				<p role="alert" className="mt-2 text-red-600">
					无法完成：{error}
				</p>
			) : null}
			{item.events.length ? (
				<p className="mt-2 text-xs text-muted-foreground">
					历史：{item.events.map((event) => `${event.type} ${event.at}`).join(" · ")}
				</p>
			) : null}
		</li>
	);
}
