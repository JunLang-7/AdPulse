import { Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
import { consoleClient, type components } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import {
	applyTaskSuggestions,
	draftFields,
	emptyNotes,
	fieldHints,
	fieldLabels,
	fieldOptions,
	missingFields,
	selectedValues,
	setupBrief,
	stageValue,
	suggestionKey,
	taskStages,
	taskSuggestions,
	withSelectedValue,
	type ChoiceField,
	type ExcludedChoices,
	type TaskDraftStage,
	type TaskSuggestion,
} from "./task-setup.js";
import { TASK_SETUP_BRIEF_LIMIT } from "./task-setup-file.js";
import { readTaskSetupAttachment, TASK_SETUP_ATTACHMENT_ACCEPT, TASK_SETUP_PREVIEW_LIMIT } from "./task-setup-attachment.js";
import type { FormState } from "./task-form.js";

import { TaskModelSettings } from "./task-model-settings.js";
import type { TaskModelChoice } from "../models/model-config-dialog.js";

type Suggestions = components["schemas"]["TaskDraftSuggestions"];

const reviewIndex = taskStages.length;
const stepTitles = [...taskStages.map(({ title }) => title), "核对并创建"];

/** 默认只勾原话；模型整理出来的建议默认不勾，由用户自己挑。 */
const suggestSourceLabel: Record<TaskSuggestion["source"], string> = {
	quote: "原话摘录",
	idea: "AI 建议",
};

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
	/** 用户对单条建议的勾选：没记录的按来源给默认值（原话默认勾，AI 建议默认不勾）。 */
	const [choices, setChoices] = useState<Record<string, boolean>>({});
	const [returnToReview, setReturnToReview] = useState(false);
	const [notes, setNotes] = useState(emptyNotes);
	const [excluded, setExcluded] = useState<ExcludedChoices>({});
	const [attached, setAttached] = useState<Partial<Record<TaskDraftStage, { name: string; clipped: boolean; pagesWithoutText?: number }>>>({});
	const [processing, setProcessing] = useState(false);
	const [reading, setReading] = useState(false);
	const [error, setError] = useState("");
	const [fileError, setFileError] = useState("");
	const busyRef = useRef(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const assistId = useId();
	const fileHelpId = useId();
	const [dragging, setDragging] = useState(false);
	const stage = taskStages[step];
	const busy = processing || reading || saving;
	const brief = setupBrief(form, notes);
	const remaining = TASK_SETUP_BRIEF_LIMIT - brief.length;
	const attachment = stage ? attached[stage.id] : undefined;
	const canUseFileStart = remaining < 0 && Boolean(attachment);
	const suggestionCurrent = suggestion?.brief === brief ? suggestion : undefined;
	const items = suggestionCurrent?.data ? taskSuggestions(form, suggestionCurrent.data, excluded) : [];
	const isPicked = (item: TaskSuggestion) => choices[suggestionKey(item)] ?? item.source === "quote";
	const pickedItems = items.filter(isPicked);
	const missing = missingFields(form);
	const stageMissing = stage ? stage.fields.filter((field) => !stageValue(form, field)) : [];

	function applySelected() {
		if (!pickedItems.length) return;
		onChange(applyTaskSuggestions(form, pickedItems));
		setSuggestion(undefined);
		setChoices({});
	}

	function go(index: number, fromReview = false) {
		setStep(index);
		setReturnToReview(fromReview);
		setError("");
		setFileError("");
		setSuggestion(undefined);
		setChoices({});
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

	/** 一次整理全部阶段：说到哪些字段就给哪些字段，返回后统一勾选。 */
	async function generate() {
		if (!stage || busyRef.current || saving) return;
		setError("");
		const useFileStart = canUseFileStart;
		if (!brief || (remaining < 0 && !useFileStart)) {
			setError(canUseFileStart
				? "资料超过 2,500 字。请先在上方用前 2,500 字生成建议，或编辑预览后重试。"
				: "说明和选项共超过 2,500 字，请先精简资料。");
			return;
		}
		busyRef.current = true;
		setProcessing(true);
		onBusyChange(true);
		try {
			const result = await consoleClient.POST("/api/task-drafts/extract", {
				body: {
					brief: useFileStart ? brief.slice(0, TASK_SETUP_BRIEF_LIMIT).replace(/[\uD800-\uDBFF]$/, "") : brief,
					...(provider
						? "connectionId" in provider
							? { connectionId: provider.connectionId, model: provider.model }
							: { provider: provider.provider, model: provider.model }
						: {}),
				},
			});
			if (result.response.status === 409 && result.error?.error === "model_selection_required") {
				setSuggestion(undefined);
				setError("请先选择一个模型，或直接手填。");
				return;
			}
			if (result.response.status === 503) {
				setSuggestion(undefined);
				setError("当前模型暂时无法整理资料。请检查模型配置或换一个模型重试；手填不受影响。");
				return;
			}
			if (!result.data) throw new Error("整理服务不可用");
			setSuggestion({ brief, data: result.data });
			setChoices({});
		} catch {
			setSuggestion(undefined);
			setError("暂时无法整理资料。可以重试，或直接手填；手填不影响后续步骤。");
		} finally {
			busyRef.current = false;
			setProcessing(false);
			onBusyChange(false);
		}
	}

	/** 提交只在本机校验并前进：不再隐式调用模型，也不替用户写入任何建议。 */
	function submitStage() {
		if (!stage || busyRef.current || saving) return;
		setError("");
		if (stage.id === "overview" && !form.product.trim()) {
			setError("请先填写产品或服务名称；也可以在上面的说明里写清卖的是什么，再点「生成建议」。");
			return;
		}
		go(returnToReview ? reviewIndex : step + 1);
	}

	return (
		<Card>
			<CardContent className="space-y-5">
				<div className="flex justify-end">
					<TaskModelSettings selected={provider} disabled={busy} onSelect={(choice) => {
						setProvider(choice);
						setSuggestion(undefined);
						setChoices({});
						setError("");
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
							{stageMissing.length ? (
								<p className="text-xs text-muted-foreground">
									还待补充：{stageMissing.map((field) => fieldLabels[field]).join("、")}。可以直接在下方填写，或补充一句描述后点「一次整理全部字段」。
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
								onClick={() => void generate()}>{processing ? "正在整理…" : canUseFileStart ? "用前 2,500 字整理全部" : "一次整理全部字段"}</Button>
							{suggestionCurrent ? (
								<div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
									<p className="font-medium">可填的内容 · 共 {items.length} 条，已选 {pickedItems.length} 条</p>
									<p className="text-xs text-muted-foreground">
										按你的说明一次整理出所有字段。原话摘录默认勾选；标“AI 建议”的是模型整理，默认不勾，请先核对。
									</p>
									{draftFields.map((field) => ({ field, fieldItems: items.filter((item) => item.field === field) }))
										.filter(({ fieldItems }) => fieldItems.length > 0)
										.map(({ field, fieldItems }) => (
											<fieldset key={field} className="space-y-1">
												<legend className="text-xs font-medium text-muted-foreground">{fieldLabels[field]}</legend>
												{fieldItems.map((item) => (
													<label key={suggestionKey(item)} className="flex items-start gap-2">
														<input type="checkbox" className="mt-1" checked={isPicked(item)} disabled={busy}
															onChange={() => setChoices((current) => ({ ...current, [suggestionKey(item)]: !isPicked(item) }))} />
														<span className="min-w-0 break-words">
															{item.value}
															<span className={item.source === "idea"
																? "ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900"
																: "ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"}>
																{suggestSourceLabel[item.source]}
															</span>
															{item.evidence ? (
																<span className="block text-xs text-muted-foreground">根据原文「{item.evidence}」整理</span>
															) : null}
														</span>
													</label>
												))}
											</fieldset>
										))}
									{items.length ? (
										<div className="flex flex-wrap gap-2">											<Button type="button" size="sm" disabled={busy || !pickedItems.length} onClick={applySelected}>
												写入表单（{pickedItems.length}）
											</Button>
											<Button type="button" size="sm" variant="ghost" disabled={busy}
												onClick={() => { setSuggestion(undefined); setChoices({}); }}>都不用</Button>
										</div>
									) : null}
									{missing.length ? (
										<div className="space-y-1 border-t pt-2">
											<p className="text-xs font-medium text-muted-foreground">还没整理出来的字段，补一句就能生成：</p>
											<ul className="space-y-1 text-xs">
												{missing.map((field) => (
													<li key={field} className="break-words">
														<span className="font-medium">{fieldLabels[field]}</span>：{fieldHints[field].hint}
														<span className="text-muted-foreground">{fieldHints[field].example}</span>
													</li>
												))}
											</ul>
										</div>
									) : null}
								</div>
							) : null}
						</section>

						{stage.fields.map((field) => field === "product" ? (
							<label key={field} className="block space-y-1 text-sm font-medium">
								<span>产品或服务名称</span>
								<Input value={form.product} maxLength={200} disabled={busy} placeholder="例如：新品试用装"
									onChange={(event) => onChange({ ...form, product: event.target.value })} />
								<span className="block text-xs font-normal text-muted-foreground">
									任务唯一必填项，可直接填写或应用上方建议。{fieldHints.product.hint}{fieldHints.product.example}
								</span>
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
						{error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
						<p className="text-xs text-muted-foreground">
							只有点「一次整理全部字段」才会把上面三个阶段的说明发送给所选模型；提交本阶段只在本机校验。还没确定的信息可以暂时留空。
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
			<p className="text-xs font-normal text-muted-foreground">
				没有合适的选项，就在上面的说明里写一句。{fieldHints[field].hint}{fieldHints[field].example}
			</p>
		</fieldset>
	);
}
