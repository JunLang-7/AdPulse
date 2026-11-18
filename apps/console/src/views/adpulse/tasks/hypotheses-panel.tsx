import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { consoleClient } from "../../../adpulse-client";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";

type HypothesisSummary = {
	head: { id: string; status: string; currentVersion: number };
	current: { statement: string; rationale: string; testable?: string; origin: string };
};
type Draft = { statement: string; rationale: string; testable?: string; evidenceHint?: string };
type Verdict = {
	id: string;
	hypothesisId: string;
	hypothesisVersion: number;
	subject: { kind: string; eventId?: string; version?: number; sourceItemId?: string; comparisonResultId?: string };
	judgment: string;
	explanation: string;
	quote?: string;
	stage: string;
	preliminary?: { modelRef: string; generatedAt: string };
	confirmedAt?: string;
};

const statusLabels: Record<string, { label: string; variant: "outline" | "default" | "destructive" }> = {
	open: { label: "观察中", variant: "outline" },
	supported: { label: "获支持", variant: "default" },
	challenged: { label: "被挑战", variant: "destructive" },
	retired: { label: "已停用", variant: "outline" },
};

function describeSubject(subject: Verdict["subject"]): string {
	if (subject.kind === "market_event") return `市场事件 ${subject.eventId ?? "?"} v${subject.version ?? "?"}`;
	if (subject.kind === "comparison") return `效果比较 ${subject.comparisonResultId ?? "?"}`;
	return `来源条目 ${subject.sourceItemId ?? "?"}`;
}

/** 假设偏差面板：生成草案 → 确认成假设 → 证据判定（自动初判需人工确认）。 */
export function HypothesesPanel({ taskId }: { taskId: string }) {
	const queryClient = useQueryClient();
	const [error, setError] = useState("");
	const [materials, setMaterials] = useState("");
	const [feedback, setFeedback] = useState("");
	const [drafts, setDrafts] = useState<Draft[]>([]);
	const [edits, setEdits] = useState<Record<number, { statement: string; rationale: string; testable: string }>>({});
	const [newStatement, setNewStatement] = useState("");
	const [newRationale, setNewRationale] = useState("");
	const [newTestable, setNewTestable] = useState("");

	const hypotheses = useQuery({
		queryKey: ["task-hypotheses", taskId],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/tasks/{taskId}/hypotheses", {
				params: { path: { taskId } },
			});
			if (!result.data) throw new Error("暂时无法读取假设，请稍后重试。");
			return result.data.items as HypothesisSummary[];
		},
	});
	const pendingAll = useQuery({
		queryKey: ["hypotheses-pending"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/hypotheses/pending");
			if (!result.data) throw new Error("暂时无法读取待确认判定，请稍后重试。");
			return result.data.items as Verdict[];
		},
	});
	// 渲染期过滤：只展示本任务假设的待确认判定。
	const pendingItems = (pendingAll.data ?? []).filter((verdict) =>
		(hypotheses.data ?? []).some((item) => item.head.id === verdict.hypothesisId));

	const invalidate = async () => {
		await queryClient.invalidateQueries({ queryKey: ["task-hypotheses", taskId] });
		await queryClient.invalidateQueries({ queryKey: ["hypotheses-pending"] });
	};

	const generateMutation = useMutation({
		mutationFn: async () => {
			const result = await consoleClient.POST("/api/tasks/{taskId}/hypotheses/drafts", {
				params: { path: { taskId } },
				body: {
					...(materials.trim() ? { materials: materials.trim() } : {}),
					...(feedback.trim() && drafts.length ? { feedback: feedback.trim(), previous: drafts.map((draft) => ({ statement: draft.statement, outcome: "revised" as const })) } : {}),
				},
			});
			if (!result.data) {
				if (result.response.status === 503) throw new Error("暂时没有可用的模型连接，请在任务设置里配置模型后重试。");
				throw new Error("草案生成失败，请稍后重试。");
			}
			return result.data.drafts;
		},
		onSuccess: (items) => {
			setError("");
			setDrafts(items);
			setEdits(Object.fromEntries(items.map((draft, index) => [index, {
				statement: draft.statement,
				rationale: draft.rationale,
				testable: draft.testable ?? "",
			}])));
			if (feedback.trim()) setFeedback("");
		},
		onError: (cause: Error) => setError(cause.message),
	});

	const acceptMutation = useMutation({
		mutationFn: async (input: { draft: Draft; index: number }) => {
			const edit = edits[input.index];
			const statement = edit?.statement ?? input.draft.statement;
			const rationale = edit?.rationale ?? input.draft.rationale;
			const testable = edit?.testable || undefined;
			const key = crypto.randomUUID();
			const result = await consoleClient.POST("/api/tasks/{taskId}/hypotheses", {
				params: { path: { taskId }, header: { "Idempotency-Key": key } },
				body: {
					statement, rationale, ...(testable ? { testable } : {}),
					origin: "model_draft_accepted",
					draftRef: { modelRef: "console-draft", generatedAt: new Date().toISOString(), iterations: 0 },
				},
			});
			if (!result.data) {
				const { status } = result.response;
				if (status === 409) throw new Error("该判断已存在，请在下方列表中修订它。");
				throw new Error("草案保存失败，请稍后重试。");
			}
			return input.index;
		},
		onSuccess: async (index) => {
			setError("");
			setDrafts((current) => current.filter((_, i) => i !== index));
			await invalidate();
		},
		onError: (cause: Error) => setError(cause.message),
	});

	const createMutation = useMutation({
		mutationFn: async () => {
			const result = await consoleClient.POST("/api/tasks/{taskId}/hypotheses", {
				params: { path: { taskId }, header: { "Idempotency-Key": crypto.randomUUID() } },
				body: {
					statement: newStatement.trim(),
					rationale: newRationale.trim(),
					...(newTestable.trim() ? { testable: newTestable.trim() } : {}),
					origin: "manual",
				},
			});
			if (!result.data) {
				const { status } = result.response;
				if (status === 409) throw new Error("已有同样陈述的假设，请直接修订它。");
				throw new Error("假设保存失败，请检查内容长度后重试。");
			}
			return result.data;
		},
		onSuccess: async () => {
			setError("");
			setNewStatement("");
			setNewRationale("");
			setNewTestable("");
			await invalidate();
		},
		onError: (cause: Error) => setError(cause.message),
	});

	const retireMutation = useMutation({
		mutationFn: async (input: { id: string; version: number }) => {
			const result = await consoleClient.POST("/api/hypotheses/{hypothesisId}/retire", {
				params: { path: { hypothesisId: input.id }, header: { "Idempotency-Key": crypto.randomUUID() } },
				body: { expectedVersion: input.version },
			});
			if (!result.data) throw new Error(result.response.status === 409 ? "假设已被修订或停用，请刷新后重试。" : "停用失败，请稍后重试。");
			return result.data;
		},
		onSuccess: async () => {
			setError("");
			await invalidate();
		},
		onError: (cause: Error) => setError(cause.message),
	});

	const verdictConfirm = useMutation({
		mutationFn: async (input: { verdictId: string; action: "confirm" | "reject" }) => {
			const path = input.action === "confirm"
				? "/api/hypotheses/verdicts/{verdictId}/confirm"
				: "/api/hypotheses/verdicts/{verdictId}/reject";
			const result = await consoleClient.POST(path, {
				params: { path: { verdictId: input.verdictId } },
			});
			if (!result.data) throw new Error(result.response.status === 409 ? "该判定已被处理，请刷新后重试。" : "操作失败，请稍后重试。");
			return result.data;
		},
		onSuccess: async () => {
			setError("");
			await invalidate();
		},
		onError: (cause: Error) => setError(cause.message),
	});

	const items = hypotheses.data ?? [];

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">方案假设（判断依据）</CardTitle>
				<p className="text-sm text-muted-foreground">
					当前方案依赖的判断。新证据是否支持或挑战它们，由你确认后生效。
				</p>
			</CardHeader>
			<CardContent className="space-y-4">
				{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

				<section className="space-y-2">
					<h3 className="text-sm font-medium">生成草案</h3>
					<textarea
						className="min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						placeholder="可选：补充任务说明之外的材料，供模型提出判断草案。"
						value={materials}
						onChange={(event) => setMaterials(event.target.value)}
					/>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={generateMutation.isPending}
						onClick={() => generateMutation.mutate()}
					>
						<Sparkles aria-hidden="true" className="size-4" />
						{drafts.length ? "根据反馈再生成" : "生成假设草案"}
					</Button>
					{drafts.length ? (
						<textarea
							className="min-h-12 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
							placeholder="对草案的反馈，例如「聚焦装修人群」（可选，随后再生成）"
							value={feedback}
							onChange={(event) => setFeedback(event.target.value)}
						/>
					) : null}
					{generateMutation.isPending ? <p role="status" className="text-sm text-muted-foreground">正在生成草案…</p> : null}
					{drafts.map((draft, index) => {
						const edit = edits[index];
						return (
							<div key={`${draft.statement}:${index}`} className="space-y-2 rounded-lg border p-3">
								<Input
									aria-label={`草案 ${index + 1} 陈述`}
									value={edit?.statement ?? draft.statement}
									onChange={(event) => setEdits((current) => ({ ...current, [index]: { ...(edit ?? { rationale: draft.rationale, testable: draft.testable ?? "" }), statement: event.target.value } }))}
								/>
								<textarea
									aria-label={`草案 ${index + 1} 依据`}
									className="min-h-12 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
									value={edit?.rationale ?? draft.rationale}
									onChange={(event) => setEdits((current) => ({ ...current, [index]: { ...(edit ?? { statement: draft.statement, testable: draft.testable ?? "" }), rationale: event.target.value } }))}
								/>
								{draft.evidenceHint ? <p className="text-xs text-muted-foreground">依据摘录：{draft.evidenceHint}</p> : null}
								<div className="flex gap-2">
									<Button type="button" size="sm" disabled={acceptMutation.isPending}
										onClick={() => acceptMutation.mutate({ draft, index })}>接受为假设</Button>
									<Button type="button" size="sm" variant="outline"
										onClick={() => setDrafts((current) => current.filter((_, i) => i !== index))}>拒绝</Button>
								</div>
							</div>
						);
					})}
				</section>

				<section className="space-y-2">
					<h3 className="text-sm font-medium">手动录入假设</h3>
					<div className="space-y-2 rounded-lg border p-3">
						<Input placeholder="判断陈述，例如「装修人群更看重免费样品」" value={newStatement} onChange={(event) => setNewStatement(event.target.value)} />
						<textarea
							className="min-h-12 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
							placeholder="当前方案为什么依赖这条判断"
							value={newRationale}
							onChange={(event) => setNewRationale(event.target.value)}
						/>
						<Button type="button" size="sm" variant="outline"
							disabled={!newStatement.trim() || !newRationale.trim() || createMutation.isPending}
							onClick={() => createMutation.mutate()}>保存假设</Button>
					</div>
				</section>

				{pendingItems.length ? (
					<section className="space-y-2">
						<h3 className="text-sm font-medium">待确认判定（{pendingItems.length}）</h3>
						{pendingItems.map((verdict) => (
							<div key={verdict.id} className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<Badge variant={verdict.judgment === "challenges" ? "destructive" : "default"}>
										{verdict.judgment === "supports" ? "支持" : verdict.judgment === "challenges" ? "挑战" : "不足以判断"}
									</Badge>
									<span className="text-xs text-muted-foreground">{describeSubject(verdict.subject)} · 初判来自 {verdict.preliminary?.modelRef ?? "模型"}</span>
								</div>
								<p className="text-sm">{verdict.explanation}</p>
								{verdict.quote ? <p className="text-xs text-muted-foreground">原文引用：{verdict.quote}</p> : null}
								<div className="flex gap-2">
									<Button type="button" size="sm" disabled={verdictConfirm.isPending}
										onClick={() => verdictConfirm.mutate({ verdictId: verdict.id, action: "confirm" })}>确认判定</Button>
									<Button type="button" size="sm" variant="outline" disabled={verdictConfirm.isPending}
										onClick={() => verdictConfirm.mutate({ verdictId: verdict.id, action: "reject" })}>驳回</Button>
								</div>
							</div>
						))}
					</section>
				) : null}

				<section className="space-y-2">
					<h3 className="text-sm font-medium">已确认假设（{items.length}）</h3>
					{hypotheses.isLoading ? <p role="status" className="text-sm text-muted-foreground">正在读取…</p> : null}
					{!hypotheses.isLoading && items.length === 0 ? (
						<p className="text-sm text-muted-foreground">还没有假设。上方生成草案或手动录入后，系统会持续观察新证据与它们的关系。</p>
					) : null}
					{items.map((item) => {
						const badge = statusLabels[item.head.status] ?? { label: item.head.status, variant: "outline" as const };
						const verdicts = (hypotheses.data ?? []).flatMap(() => []);
						void verdicts;
						return (
							<div key={item.head.id} className="space-y-1 rounded-lg border p-3">
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant={badge.variant}>{badge.label}</Badge>
									<span className="text-xs text-muted-foreground">
										{item.current.origin === "manual" ? "手动录入" : "草案接受"} · 第 {item.head.currentVersion} 版
									</span>
									{item.head.status !== "retired" ? (
										<Button type="button" size="sm" variant="ghost" className="ml-auto"
											disabled={retireMutation.isPending}
											onClick={() => retireMutation.mutate({ id: item.head.id, version: item.head.currentVersion })}>
											停用
										</Button>
									) : null}
								</div>
								<p className="text-sm">{item.current.statement}</p>
								<p className="text-xs text-muted-foreground">{item.current.rationale}</p>
								{item.current.testable ? <p className="text-xs text-muted-foreground">判定标准：{item.current.testable}</p> : null}
							</div>
						);
					})}
				</section>
			</CardContent>
		</Card>
	);
}
