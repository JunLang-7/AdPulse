import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { consoleClient } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import {
	addGuideAnswer,
	applyTaskSuggestions,
	guideQuestions,
	guideValue,
	nextGuideQuestion,
} from "./task-setup.js";
import type { FormState } from "./task-form.js";

const BRIEF_LIMIT = 2500;
const textAreaClass = "min-h-24 w-full rounded-md border bg-background p-3 text-sm";

export function TaskSetupGuide({ form, onChange, onEdit, onSave, saving }: {
	form: FormState;
	onChange: (form: FormState) => void;
	onEdit: () => void;
	onSave: () => void;
	saving: boolean;
}) {
	const [step, setStep] = useState<number | "brief" | "review">("brief");
	const [brief, setBrief] = useState("");
	const [answer, setAnswer] = useState("");
	const [answerError, setAnswerError] = useState("");
	const extraction = useMutation({
		mutationFn: async () => {
			const result = await consoleClient.POST("/api/task-drafts/extract", {
				body: { brief: brief.trim() },
			});
			if (!result.data) throw new Error("提取服务暂时不可用，可以直接逐题填写。");
			return result.data;
		},
	});

	function next(nextForm: FormState, after = -1) {
		const index = nextGuideQuestion(nextForm, after);
		setStep(index === -1 ? "review" : index);
		setAnswer("");
		setAnswerError("");
	}

	function finishAnswer(review = false, skip = false) {
		if (typeof step !== "number") return;
		const question = guideQuestions[step];
		if (!question) return;
		try {
			const nextForm = skip ? form : addGuideAnswer(form, question.field, answer);
			if (nextForm !== form) onChange(nextForm);
			if (review) {
				setStep("review");
				setAnswer("");
				setAnswerError("");
			} else {
				next(nextForm, step);
			}
		} catch (error) {
			setAnswerError(error instanceof Error ? error.message : "请检查这一项。");
		}
	}

	if (step === "brief") {
		const suggestion = extraction.data;
		const proposedForm = suggestion ? applyTaskSuggestions(form, suggestion) : null;
		const added = proposedForm ? guideQuestions.filter(({ field }) =>
			!guideValue(form, field) && guideValue(proposedForm, field)) : [];
		return (
			<Card className="border-t-2 border-t-primary">
				<CardContent className="space-y-4">
					<div className="space-y-1">
						<h2 className="text-lg font-semibold">用一句话开始</h2>
						<p className="text-sm text-muted-foreground">可以粘贴已有的推广说明，也可以直接回答问题。只要知道要推广什么，就能创建任务。</p>
					</div>
					<label className="block space-y-1 text-sm">
						<span className="font-medium">已有的推广说明（选填）</span>
						<textarea className={textAreaClass} maxLength={BRIEF_LIMIT} value={brief}
							disabled={extraction.isPending} onChange={(event) => {
								setBrief(event.target.value);
								extraction.reset();
							}}
							placeholder="例如：我要在小红书推广新品试用装，想让准备装修的业主来咨询，可以免费领取样品。" />
					</label>
					<p className="text-xs text-muted-foreground">选择提取时，这段文字会发送给 DeepSeek。请先删去手机号、客户姓名等个人资料。</p>
					{extraction.isError ? <p role="alert" className="text-sm text-red-600">提取服务暂时不可用。可以直接逐题填写。</p> : null}
					{proposedForm && added.length > 0 ? (
						<div className="space-y-2 rounded-lg border bg-muted/40 p-3">
							<p className="text-sm font-medium">从说明提取的内容</p>
							<dl className="grid gap-2 text-sm sm:grid-cols-2">
								{added.map(({ field, label }) => (
									<div key={field} className="min-w-0">
										<dt className="text-xs text-muted-foreground">{label}</dt>
										<dd className="whitespace-pre-wrap break-words">{guideValue(proposedForm, field)}</dd>
									</div>
								))}
							</dl>
							<Button type="button" onClick={() => {
								onChange(proposedForm);
								extraction.reset();
								next(proposedForm);
							}}>带入草稿并补答</Button>
						</div>
					) : null}
					{proposedForm && added.length === 0 ? (
						<p role="status" className="text-sm text-muted-foreground">这段说明没有可补充的内容，可以直接逐题填写。</p>
					) : null}
					<div className="flex flex-wrap gap-2">
						<Button type="button" variant={brief.trim() ? "default" : "outline"}
							disabled={!brief.trim() || extraction.isPending} onClick={() => extraction.mutate()}>
							{extraction.isPending ? "正在提取…" : extraction.isError ? "重试提取" : "用 DeepSeek 提取"}
						</Button>
						<Button type="button" variant={brief.trim() ? "outline" : "default"} onClick={() => next(form)}>直接回答问题</Button>
					</div>
				</CardContent>
			</Card>
		);
	}

	if (step === "review") {
		return (
			<Card>
				<CardContent className="space-y-4">
					<h2 className="text-lg font-semibold">核对推广任务</h2>
					<dl className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
						{guideQuestions.map(({ field, label }) => (
							<div key={field} className="min-w-0">
								<dt className="text-xs text-muted-foreground">{label}</dt>
								<dd className="whitespace-pre-wrap break-words">{guideValue(form, field) || "待补充"}</dd>
							</div>
						))}
					</dl>
					<p className="text-sm text-muted-foreground">观察时间、预算和提醒条件可以稍后补充。创建任务后，可回到任务详情继续填写。</p>
					<div className="flex flex-wrap gap-2">
						<Button type="button" disabled={saving || !form.product.trim()} onClick={onSave}>{saving ? "保存中…" : "确认并创建任务"}</Button>
						<Button type="button" variant="outline" onClick={onEdit}>打开表单修改</Button>
					</div>
				</CardContent>
			</Card>
		);
	}

	const question = guideQuestions[step];
	if (!question) return null;
	const required = question.field === "product";
	return (
		<Card>
			<CardContent className="space-y-4">
				<p className="text-xs font-medium text-muted-foreground">补充信息 · {required ? "唯一必填项" : "选填"}</p>
				<label className="block space-y-2">
					<span className="block text-lg font-semibold">{question.question}</span>
					<Input key={question.field} value={answer} maxLength={question.maxLength} placeholder={question.example}
						onKeyDown={(event) => {
							if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
							event.preventDefault();
							finishAnswer();
						}}
						onChange={(event) => {
							setAnswer(event.target.value);
							setAnswerError("");
						}} />
				</label>
				{answerError ? <p role="alert" className="text-sm text-red-600">{answerError}</p> : null}
				<div className="flex flex-wrap gap-2">
					<Button type="button" onClick={() => finishAnswer()}>下一题</Button>
					{required ? null : (
						<Button type="button" variant="outline" onClick={() => finishAnswer(false, true)}>我还不知道，先跳过</Button>
					)}
					{!required || answer.trim() ? (
						<Button type="button" variant="ghost" onClick={() => finishAnswer(true)}>现在核对草稿</Button>
					) : null}
				</div>
			</CardContent>
		</Card>
	);
}
