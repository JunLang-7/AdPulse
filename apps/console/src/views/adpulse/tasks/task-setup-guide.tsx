import { Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
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
import { TASK_SETUP_BRIEF_LIMIT } from "./task-setup-file.js";
import { readTaskSetupAttachment, TASK_SETUP_ATTACHMENT_ACCEPT, TASK_SETUP_PREVIEW_LIMIT } from "./task-setup-attachment.js";
import type { FormState } from "./task-form.js";

import { TaskModelSettings } from "./task-model-settings.js";
import type { TaskModelChoice } from "../models/model-config-dialog.js";

type Suggestions = components["schemas"]["TaskDraftSuggestions"];
type DraftField = Exclude<keyof Suggestions, "recommendations">;
type Idea = { field: DraftField; label?: string; value: string };

const reviewIndex = taskStages.length;
const stepTitles = [...taskStages.map(({ title }) => title), "核对并创建"];
const emptyNotes: Record<TaskDraftStage, string> = { overview: "", audience: "", channels: "" };
const ideaKey = ({ field, value }: Idea) => field + "\u0000" + value;

function hasStageIdeas(stage: TaskDraftStage, form: FormState, data: Suggestions | undefined, excluded: ExcludedChoices): boolean {
	const ideas = data?.recommendations;
	if (!ideas) return false;
	const addable = (field: ChoiceField, values?: readonly string[]) => {
		const selected = selectedValues(form, field);
		return (values ?? []).some((value) => !selected.includes(value) && !excluded[field]?.includes(value));
	};
	if (stage === "overview")
		return Boolean((ideas.product && ideas.product.value !== form.product.trim()) ||
			(!form.objective.trim() && ideas.objectives?.length));
	if (stage === "audience") return addable("audience", ideas.audience) || addable("sellingPoints", ideas.sellingPoints);
	return addable("channels", ideas.channels);
}

export function TaskSetupGuide({ form, onChange, onEdit, onSave, onBusyChange, saving }: {
	form: FormState;
	onChange: (form: FormState) => void;
	onEdit: () => void;
	onSave: () => void;
	onBusyChange: (busy: boolean) => void;
	saving: boolean;
}) {
	const [step, setStep] = useState(0);
	const [provider, setProvider] = useState<TaskModelChoice>();
	const [suggestion, setSuggestion] = useState<{ brief: string; data?: Suggestions }>();
	const [deselectedIdeas, setDeselectedIdeas] = useState<string[]>([]);
	const [returnToReview, setReturnToReview] = useState(false);
	const [notes, setNotes] = useState(emptyNotes);
	const [excluded, setExcluded] = useState<ExcludedChoices>({});
	const [attached, setAttached] = useState<Partial<Record<TaskDraftStage, { name: string; clipped: boolean; pagesWithoutText?: number }>>>({});
	const [processing, setProcessing] = useState(false);
	const [reading, setReading] = useState(false);
	const [error, setError] = useState("");
	const [fileError, setFileError] = useState("");
	const [failed, setFailed] = useState(false);
	const [useEnteredValues, setUseEnteredValues] = useState(false);
	const [localStages, setLocalStages] = useState<Partial<Record<TaskDraftStage, boolean>>>({});
	const busyRef = useRef(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const assistId = useId();
	const fileHelpId = useId();
	const [dragging, setDragging] = useState(false);
	const stage = taskStages[step];
	const busy = processing || reading || saving;
	const brief = stage ? stageBrief(form, stage, notes[stage.id]) : "";
	const remaining = TASK_SETUP_BRIEF_LIMIT - brief.length;
	const attachment = stage ? attached[stage.id] : undefined;
	const canUseFileStart = remaining < 0 && Boolean(attachment);
	const suggestionCurrent = suggestion?.brief === brief ? suggestion : undefined;
	const recommendations = suggestionCurrent?.data?.recommendations;
	const productIdea = stage?.id === "overview" && recommendations?.product?.value !== form.product.trim()
		? recommendations?.product : undefined;
	const goalIdeas = stage?.id === "overview" && !form.objective.trim() ? recommendations?.objectives ?? [] : [];
	const addable = (field: ChoiceField, values?: readonly string[]) => {
		const selected = selectedValues(form, field);
		return [...new Set(values ?? [])].filter((value) => !selected.includes(value) && !excluded[field]?.includes(value));
	};
	const ideas: Idea[] = [
		...(productIdea ? [{ field: "product" as const, label: "建议名称", value: productIdea.value }] : []),
		...goalIdeas.map((value) => ({ field: "objective" as const, value })),
		...(stage?.id === "audience" ? [
			...addable("audience", recommendations?.audience).map((value) => ({ field: "audience" as const, label: "人群建议", value })),
			...addable("sellingPoints", recommendations?.sellingPoints).map((value) => ({ field: "sellingPoints" as const, label: "卖点建议", value })),
		] : []),
		...(stage?.id === "channels"
			? addable("channels", recommendations?.channels).map((value) => ({ field: "channels" as const, label: "渠道建议", value }))
			: []),
	];
	const excerpts = stage && suggestionCurrent?.data ? applyStageSuggestions(form, stage.id, suggestionCurrent.data, excluded) : undefined;
	const draft = excerpts && productIdea ? { ...excerpts, product: form.product } : excerpts;
	const additions = stage?.fields.filter((field) => draft && stageValue(draft, field) !== stageValue(form, field)) ?? [];
	const missingFields = stage?.fields.filter((field) => !stageValue(form, field)) ?? [];
	const selectedIdeas = ideas.filter((idea) => !deselectedIdeas.includes(ideaKey(idea)));

	function applySuggestions() {
		if (!stage || !draft) return;
		let next = { ...draft };
		const chosenProduct = selectedIdeas.find((idea) => idea.field === "product");
		if (chosenProduct) next.product = chosenProduct.value;
		if (!form.objective.trim()) {
			const chosenGoals = selectedIdeas.filter((idea) => idea.field === "objective").map((idea) => idea.value);
			if (chosenGoals.length) next.objective = chosenGoals.join("\n");
		}
		for (const idea of selectedIdeas) {
			if (idea.field === "product" || idea.field === "objective") continue;
			if (!selectedValues(next, idea.field).includes(idea.value))
				next = withSelectedValue(next, idea.field, idea.value);
		}
		onChange(next);
		setSuggestion({ brief: stageBrief(next, stage, notes[stage.id]) });
	}

	function go(index: number, fromReview = false) {
		setStep(index);
		setReturnToReview(fromReview);
		setError("");
		setFileError("");
		setFailed(false);
		setUseEnteredValues(false);
		setSuggestion(undefined);
		setDeselectedIdeas([]);
	}

	async function loadFile(file: File) {
		if (!stage || busyRef.current) return;
		busyRef.current = true;
		setReading(true);
		onBusyChange(true);
		setFileError("");
		try {
			const { text, clipped, pagesWithoutText } = await readTaskSetupAttachment(file);
			const existing = notes[stage.id].trim();
			const prefix = existing ? existing + "\n" : "";
			const available = Math.max(0, TASK_SETUP_PREVIEW_LIMIT - prefix.length);
			const excerpt = text.slice(0, available).replace(/[\uD800-\uDBFF]$/, "");
			if (!excerpt)
				throw new Error("预览区已满。请删减现有资料后再选择文件。");
			const combined = prefix + excerpt;
			setNotes((previous) => ({ ...previous, [stage.id]: combined }));
			setAttached((previous) => ({
				...previous, [stage.id]: { name: file.name, clipped: clipped || excerpt.length < text.length, pagesWithoutText },
			}));
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
		const hasNotes = Boolean(notes[stage.id].trim());
		const needsExtraction = Boolean(brief) && (preview || (hasNotes && !useEnteredValues && !suggestionCurrent));
		const useFileStart = preview && canUseFileStart;
		if (needsExtraction && remaining < 0 && !useFileStart) {
			setError(canUseFileStart
				? "资料超过 2,500 字。请先在上方用前 2,500 字生成建议，或编辑预览后提交。"
				: "说明和选项共超过 2,500 字，请先精简资料。");
			return;
		}
		let nextForm = form;
		if (needsExtraction) {
			busyRef.current = true;
			setProcessing(true);
			onBusyChange(true);
			try {
				const result = await consoleClient.POST("/api/task-drafts/extract", {
					body: {
						brief: useFileStart ? brief.slice(0, TASK_SETUP_BRIEF_LIMIT).replace(/[\uD800-\uDBFF]$/, "") : brief,
						stage: stage.id,
						...(provider
							? "connectionId" in provider
								? { connectionId: provider.connectionId, model: provider.model }
								: { provider: provider.provider, model: provider.model }
							: {}),
					},
				});
				if (result.response.status === 409 && result.error?.error === "model_selection_required") {
					setFailed(true);
					setError("请先选择一个模型，或按已填写的内容继续。");
					return;
				}
				if (result.response.status === 503) {
					setFailed(true);
					setError("当前模型暂时无法整理资料。请检查模型配置、换一个模型重试，或按已填写的内容继续。");
					return;
				}
				if (!result.data) throw new Error("整理服务不可用");
				if (preview || hasStageIdeas(stage.id, form, result.data, excluded)) {
					setSuggestion({ brief, data: result.data });
					setDeselectedIdeas([]);
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
						setDeselectedIdeas([]);
						setError("");
						setFailed(false);
						setUseEnteredValues(false);
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
							{missingFields.length ? (
								<p className="text-xs text-muted-foreground">
									还待补充：{missingFields.map((field) => fieldLabels[field]).join("、")}。可以直接在下方填写，或补充一句描述后点「生成建议」。
								</p>
							) : null}
						</div>
						<section key={stage.id} aria-labelledby={assistId} className="space-y-3 rounded-lg border border-primary/25 bg-muted/25 p-4">
							<div className="space-y-1">
								<h3 id={assistId} className="text-sm font-semibold">AI 辅助填写</h3>
								<p className="text-sm text-muted-foreground">写一句话或上传已有资料，生成建议后再核对。</p>
							</div>
							<div className="space-y-3">
								<div className="space-y-1 text-sm">
									<label className="sr-only" htmlFor={"task-setup-notes-" + stage.id}>本阶段说明</label>
									<textarea id={"task-setup-notes-" + stage.id} className="min-h-24 w-full rounded-md border bg-background p-3 text-sm"
										value={notes[stage.id]} maxLength={TASK_SETUP_PREVIEW_LIMIT} disabled={busy}
										placeholder={stage.placeholder} onChange={(event) => {
											const value = event.target.value;
											setNotes((previous) => ({ ...previous, [stage.id]: value }));
										}} />
								</div>
								<input ref={fileInput} type="file" accept={TASK_SETUP_ATTACHMENT_ACCEPT} hidden
									onChange={(event) => {
										const file = event.currentTarget.files?.[0];
										event.currentTarget.value = "";
										if (file) void loadFile(file);
									}} />
								<button type="button" disabled={busy} aria-label="选择资料文件" aria-describedby={fileHelpId}
									className={"flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border-2 border-dashed px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60 " +
										(dragging ? "border-primary bg-primary/10" : "border-primary/40 bg-muted/55 hover:border-primary hover:bg-muted")}
									onClick={() => fileInput.current?.click()}
									onDragOver={(event) => {
										event.preventDefault();
										if (!busy) setDragging(true);
									}} onDragLeave={() => setDragging(false)}
									onDrop={(event) => {
										event.preventDefault();
										setDragging(false);
										if (busy) return;
										const files = event.dataTransfer.files;
										if (files.length > 1) {
											setFileError("请每次选择一个文件。");
											return;
										}
										const file = files[0];
										if (file) void loadFile(file);
									}}>
									<Upload aria-hidden="true" className="size-4 shrink-0" />
									<span className="text-sm font-semibold">{reading ? "正在读取文件…" : "选择文件"}</span>
									<span className="text-xs text-muted-foreground">也可以拖到这里</span>
								</button>
								<p id={fileHelpId} className="text-xs text-muted-foreground">支持 PDF、Word（.docx）、Excel（.xlsx）、TXT、Markdown、CSV，每份最多 8 MB。</p>
								{attachment ? (
									<div role="status" className="space-y-1 break-words text-sm">
										<p>已读入 {attachment.name}。{attachment.clipped ? "仅展示部分文字，可在上方保留相关内容。" : "可在上方核对和修改文字。"}</p>
										{attachment.pagesWithoutText ? <p>已检查的页面中有 {attachment.pagesWithoutText} 页没有可读取文字。如有需要，请识别文字后补充。</p> : null}
									</div>
								) : null}
								{fileError ? <p role="alert" className="text-sm text-red-600">{fileError}</p> : null}
								<p className={remaining >= 0 || canUseFileStart ? "text-xs text-muted-foreground" : "text-sm text-red-600"}>
									{canUseFileStart ? "生成建议时使用本阶段资料的前 2,500 字。你也可以先编辑预览，保留想用的段落。"
										: remaining >= 0 ? "先在本机预览，提交前可编辑。本阶段还可输入 " + remaining + " 字。" : "超过本阶段 2,500 字上限，请在上方删减 " + (-remaining) + " 字后提交。"}
								</p>
							</div>
							<Button type="button" disabled={busy || !brief || (remaining < 0 && !canUseFileStart)}
								onClick={() => void submitStage(true)}>{processing ? "正在整理…" : canUseFileStart ? "用前 2,500 字生成建议" : "生成建议"}</Button>
							{draft && (additions.length > 0 || ideas.length > 0) ? (
								<div className="space-y-2 rounded-md bg-muted/40 p-2 text-sm">
									<p className="font-medium">待核对建议</p>
									<p className="text-xs text-muted-foreground">根据你的描述整理，勾选的内容会填入下方表单。</p>
									{additions.map((field) => <p key={field}>{fieldLabels[field]} · {stageValue(draft, field)}</p>)}
									{ideas.map((idea) => (
										<label key={ideaKey(idea)} className="flex items-center gap-2">
											<input type="checkbox" checked={!deselectedIdeas.includes(ideaKey(idea))} disabled={busy}
												onChange={(event) => {
													const key = ideaKey(idea);
													setDeselectedIdeas((current) => event.target.checked
														? current.filter((item) => item !== key)
														: [...current, key]);
												}} />
											<span>{idea.label ? idea.label + " · " : ""}{idea.value}</span>
										</label>
									))}
									{productIdea?.evidence ? <p className="text-xs text-muted-foreground">根据原文「{productIdea.evidence}」整理</p> : null}
									<Button type="button" size="sm"
										disabled={busy || (!additions.length && selectedIdeas.length === 0)}
										onClick={applySuggestions}>
										{ideas.length ? "应用所选建议" : "应用建议"}
									</Button>
								</div>
							) : draft ? <p role="status" className="text-sm">没有可补充的建议。可以在下方直接选择或填写，或把补充说明写得更具体一些。</p> : null}
							{failed ? (
								<div className="space-y-2">
									{error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
									<label className="flex items-center gap-2 text-sm">
										<input type="checkbox" checked={useEnteredValues} disabled={busy}
											onChange={(event) => setUseEnteredValues(event.target.checked)} />
										本阶段按已填写的内容继续
									</label>
								</div>
							) : null}
						</section>

						{stage.fields.map((field) => field === "product" ? (
							<label key={field} className="block space-y-1 text-sm font-medium">
								<span>产品或服务名称</span>
								<Input value={form.product} maxLength={200} disabled={busy} placeholder="例如：新品试用装"
									onChange={(event) => onChange({ ...form, product: event.target.value })} />
								<span className="block text-xs font-normal text-muted-foreground">任务唯一必填项，可直接填写或应用上方建议。</span>
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
						{!failed && error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
						<p className="text-xs text-muted-foreground">
							补充说明会在生成建议或提交本阶段时用于整理。还没确定的信息可以暂时留空。
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
			<legend className="text-sm font-medium">{fieldLabels[field]} <span className="font-normal text-muted-foreground">（可多选）</span></legend>
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
