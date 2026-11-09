import { useRef, useState } from "react";
import { consoleClient, type components } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import {
	applyStageSuggestions,
	fieldLabels,
	fieldOptions,
	selectedValues,
	stageBrief,
	stageValue,
	taskStages,
	withSelectedValue,
	type ChoiceField,
	type ExcludedChoices,
	type TaskDraftStage,
} from "./task-setup.js";
import { readTaskSetupFile, TASK_SETUP_BRIEF_LIMIT, TASK_SETUP_FILE_ACCEPT } from "./task-setup-file.js";
import type { FormState } from "./task-form.js";

import { TaskModelSettings, type TaskDraftProvider } from "./task-model-settings.js";

type Suggestions = components["schemas"]["TaskDraftSuggestions"];

const reviewIndex = taskStages.length;
const stepTitles = [...taskStages.map(({ title }) => title), "核对并创建"];
const emptyNotes: Record<TaskDraftStage, string> = { overview: "", audience: "", channels: "" };

export function TaskSetupGuide({ form, onChange, onEdit, onSave, onBusyChange, saving }: {
	form: FormState;
	onChange: (form: FormState) => void;
	onEdit: () => void;
	onSave: () => void;
	onBusyChange: (busy: boolean) => void;
	saving: boolean;
}) {
	const [step, setStep] = useState(0);
	const [provider, setProvider] = useState<TaskDraftProvider>();
	const [suggestion, setSuggestion] = useState<{ brief: string; data?: Suggestions }>();
	const [returnToReview, setReturnToReview] = useState(false);
	const [notes, setNotes] = useState(emptyNotes);
	const [excluded, setExcluded] = useState<ExcludedChoices>({});
	const [attached, setAttached] = useState<Partial<Record<TaskDraftStage, string>>>({});
	const [processing, setProcessing] = useState(false);
	const [reading, setReading] = useState(false);
	const [error, setError] = useState("");
	const [fileError, setFileError] = useState("");
	const [failed, setFailed] = useState(false);
	const [useEnteredValues, setUseEnteredValues] = useState(false);
	const [localStages, setLocalStages] = useState<Partial<Record<TaskDraftStage, boolean>>>({});
	const busyRef = useRef(false);
	const stage = taskStages[step];
	const busy = processing || reading || saving;
	const brief = stage ? stageBrief(form, stage, notes[stage.id]) : "";
	const remaining = TASK_SETUP_BRIEF_LIMIT - brief.length;
	const suggestionCurrent = suggestion?.brief === brief ? suggestion : undefined;
	const draft = stage && suggestionCurrent?.data ? applyStageSuggestions(form, stage.id, suggestionCurrent.data, excluded) : undefined;
	const additions = stage?.fields.filter((field) => draft && stageValue(draft, field) !== stageValue(form, field)) ?? [];

	function go(index: number, fromReview = false) {
		setStep(index);
		setReturnToReview(fromReview);
		setError("");
		setFileError("");
		setFailed(false);
		setUseEnteredValues(false);
		setSuggestion(undefined);
	}

	async function loadFile(file: File) {
		if (!stage || busyRef.current) return;
		busyRef.current = true;
		setReading(true);
		onBusyChange(true);
		setFileError("");
		try {
			const contents = await readTaskSetupFile(file);
			const combined = [notes[stage.id].trim(), contents].filter(Boolean).join("\n");
			if (stageBrief(form, stage, combined).length > TASK_SETUP_BRIEF_LIMIT)
				throw new Error("合并后超过本阶段文字上限。请先精简说明，再选择文件。");
			setNotes((previous) => ({ ...previous, [stage.id]: combined }));
			setAttached((previous) => ({ ...previous, [stage.id]: file.name }));
		} catch (problem) {
			setFileError(problem instanceof Error ? problem.message : "无法读取这个文件。");
		} finally {
			busyRef.current = false;
			setReading(false);
			onBusyChange(false);
		}
	}

	async function submitStage(preview = false) {
		if (!stage || busyRef.current || saving) return;
		setError("");
		if (remaining < 0 && !useEnteredValues) {
			setError("说明和选项共超过 2,500 字，请先精简资料。");
			return;
		}
		let nextForm = form;
		if (brief && (preview || (!useEnteredValues && !suggestionCurrent))) {
			busyRef.current = true;
			setProcessing(true);
			onBusyChange(true);
			try {
				const result = await consoleClient.POST("/api/task-drafts/extract", {
					body: { brief, stage: stage.id, ...(provider ? { provider } : {}) },
				});
				if (!result.data) throw new Error("整理服务不可用");
				if (preview) {
					setSuggestion({ brief, data: result.data });
					setFailed(false);
					setUseEnteredValues(false);
					return;
				}
				nextForm = applyStageSuggestions(form, stage.id, result.data, excluded);
			} catch {
				setFailed(true);
				setError("暂时无法整理资料。可以重试，或按已填写的内容继续。");
				return;
			} finally {
				busyRef.current = false;
				setProcessing(false);
				onBusyChange(false);
			}
		}
		if (stage.id === "overview" && !nextForm.product.trim()) {
			setError("请填写一个产品或服务名称，或在补充资料里明确说明要推广什么。");
			return;
		}
		if (nextForm !== form) onChange(nextForm);
		setLocalStages((previous) => ({ ...previous, [stage.id]: useEnteredValues }));
		go(returnToReview ? reviewIndex : step + 1);
	}

	return (
		<Card>
			<CardContent className="space-y-5">
				<div className="flex justify-end">
					<TaskModelSettings selected={provider} disabled={busy} onSelect={(choice) => {
						setProvider(choice);
						setSuggestion(undefined);
					}} />
				</div>
				<ol aria-label="填写进度" className="grid grid-cols-2 gap-2 border-b pb-4 sm:grid-cols-4">
					{stepTitles.map((title, index) => (
						<li key={title} aria-current={step === index ? "step" : undefined}
							className={step === index ? "flex items-center gap-2 text-sm font-semibold" : "flex items-center gap-2 text-sm text-muted-foreground"}>
							<span aria-hidden="true" className={step === index
								? "grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs text-primary-foreground"
								: "grid size-6 shrink-0 place-items-center rounded-full border text-xs"}>
								{index + 1}
							</span>
							{title}
						</li>
					))}
				</ol>

				{stage ? (
					<div className="space-y-5">
						<div className="space-y-1">
							<h2 className="text-lg font-semibold">{stage.title}</h2>
							<p className="text-sm text-muted-foreground">{stage.description}</p>
						</div>
						{stage.fields.map((field) => field === "product" ? (
							<label key={field} className="block space-y-1 text-sm font-medium">
								<span>产品或服务名称</span>
								<Input value={form.product} maxLength={200} disabled={busy} placeholder="例如：新品试用装"
									onChange={(event) => onChange({ ...form, product: event.target.value })} />
								<span className="block text-xs font-normal text-muted-foreground">任务唯一必填项。也可从下方资料整理出来。</span>
							</label>
						) : (
							<StageChoices key={field} field={field} form={form} disabled={busy} onSelect={(value, chosen) => {
								setExcluded((previous) => {
									const omitted = previous[field] ?? [];
									return { ...previous, [field]: chosen ? [...omitted, value] : omitted.filter((item) => item !== value) };
								});
								onChange(withSelectedValue(form, field, value));
							}} />
						))}

						<details key={stage.id} className="rounded-lg border px-3 py-2">
							<summary className="cursor-pointer text-sm font-medium">
								补充说明或文件（选填）{notes[stage.id] ? " · 已填写" : ""}
							</summary>
							<div className="mt-3 space-y-3">
								<div className="space-y-1 text-sm">
									<label htmlFor={"task-setup-notes-" + stage.id}>补充资料</label>
									<textarea id={"task-setup-notes-" + stage.id} className="min-h-24 w-full rounded-md border bg-background p-3 text-sm"
										value={notes[stage.id]} maxLength={TASK_SETUP_BRIEF_LIMIT} disabled={busy}
										placeholder={stage.placeholder} onChange={(event) => {
											const value = event.target.value;
											setNotes((previous) => ({ ...previous, [stage.id]: value }));
										}} />
								</div>
								<label className="block space-y-1 text-sm">
									<span>选择资料文件</span>
									<Input type="file" accept={TASK_SETUP_FILE_ACCEPT} disabled={busy}
										onChange={(event) => {
											const file = event.currentTarget.files?.[0];
											event.currentTarget.value = "";
											if (file) void loadFile(file);
										}} />
								</label>
								{attached[stage.id] ? (
									<p role="status" className="text-xs text-muted-foreground">已读入 {attached[stage.id]}，可在上方检查和修改文字。</p>
								) : null}
								{fileError ? <p role="alert" className="text-sm text-red-600">{fileError}</p> : null}
								<p className="text-xs text-muted-foreground">
									支持 UTF-8 的 TXT、Markdown、CSV。提交前可以修改读入的文字。本阶段{remaining >= 0 ? "还可输入 " + remaining + " 字" : "已超过文字上限"}。
								</p>
							</div>
						</details>

						<div className="space-y-2 rounded-lg border p-3">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<p className="text-sm text-muted-foreground">根据本阶段填写的内容和资料，先生成建议供你核对。</p>
								<Button type="button" variant="outline" disabled={busy || !brief || remaining < 0}
									onClick={() => void submitStage(true)}>AI 辅助填写</Button>
							</div>
							{draft && additions.length ? (
								<div className="space-y-2 rounded-md bg-muted/40 p-2 text-sm">
									<p className="font-medium">待核对建议</p>
									{additions.map((field) => <p key={field}>{fieldLabels[field]} · {stageValue(draft, field)}</p>)}
									<Button type="button" size="sm" disabled={busy} onClick={() => {
										onChange(draft);
										setSuggestion({ brief: stageBrief(draft, stage, notes[stage.id]) });
									}}>应用建议</Button>
								</div>
							) : draft ? <p role="status" className="text-sm">没有可补充的建议，可以继续手填。</p> : null}
						</div>
						{error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
						{failed ? (
							<label className="flex items-center gap-2 text-sm">
								<input type="checkbox" checked={useEnteredValues} disabled={busy}
									onChange={(event) => setUseEnteredValues(event.target.checked)} />
								本阶段按已填写的内容继续
							</label>
						) : null}
						<p className="text-xs text-muted-foreground">
							提交会发送本阶段选择和填写的资料用于整理。选填项未确定时，可以留空提交。
						</p>
						<div className="flex flex-wrap gap-2">
							<Button type="button" variant="outline" disabled={step === 0 || busy} onClick={() => go(step - 1, returnToReview)}>上一步</Button>
							<Button type="button" disabled={busy} onClick={() => void submitStage()}>
								{processing ? "正在整理…" : reading ? "正在读取…" : "提交本阶段"}
							</Button>
						</div>
					</div>
				) : (
					<div className="space-y-4">
						<div className="space-y-1">
							<h2 className="text-lg font-semibold">核对推广任务</h2>
							<p className="text-sm text-muted-foreground">请确认整理后的内容。可以修改任一阶段，也可以先创建，再补预算、时间和提醒条件。</p>
						</div>
						<div className="divide-y rounded-lg border">
							{taskStages.map(({ id, title, fields }, index) => (
								<section key={id} className="space-y-2 p-3">
									<div className="flex items-center justify-between gap-2">
										<h3 className="text-sm font-semibold">{title}</h3>
										<Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => go(index, true)}>修改{title}</Button>
									</div>
									{localStages[id] ? <p className="text-xs text-muted-foreground">本阶段按填写内容记录。</p> : null}
									<dl className="grid gap-2 text-sm sm:grid-cols-2">
										{fields.map((field) => (
											<div key={field} className="min-w-0">
												<dt className="text-xs text-muted-foreground">{fieldLabels[field]}</dt>
												<dd className="whitespace-pre-wrap break-words">{stageValue(form, field) || "待补充"}</dd>
											</div>
										))}
									</dl>
								</section>
							))}
						</div>
						<div className="flex flex-wrap gap-2">
							<Button type="button" variant="outline" disabled={saving} onClick={() => go(reviewIndex - 1, true)}>上一步</Button>
							<Button type="button" disabled={saving || !form.product.trim()} onClick={onSave}>
								{saving ? "正在创建…" : "确认并创建任务"}
							</Button>
							<Button type="button" variant="ghost" disabled={saving} onClick={onEdit}>在表单中修改</Button>
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function StageChoices({ field, form, disabled, onSelect }: {
	field: ChoiceField;
	form: FormState;
	disabled: boolean;
	onSelect: (value: string, chosen: boolean) => void;
}) {
	const selected = selectedValues(form, field);
	const presets = fieldOptions[field];
	const choices = [...new Set([...presets, ...selected])];
	return (
		<fieldset className="space-y-2" disabled={disabled}>
			<legend className="text-sm font-medium">{fieldLabels[field]} <span className="font-normal text-muted-foreground">（选填）</span></legend>
			<div className="flex flex-wrap gap-2">
				{choices.map((value) => {
					const chosen = selected.includes(value);
					return (
						<Button key={value} type="button" size="sm" variant={chosen ? "secondary" : "outline"}
							aria-pressed={chosen} className="max-w-full whitespace-normal text-left"
							onClick={() => onSelect(value, chosen)}>{value}</Button>
					);
				})}
			</div>
		</fieldset>
	);
}
