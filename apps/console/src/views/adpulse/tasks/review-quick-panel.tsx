import { Calculator, ChevronRight, FileSpreadsheet } from "lucide-react";
import { useRef, useState } from "react";
import type { SheetData } from "read-excel-file/browser";
import type { components } from "../../../generated/api.js";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
	cellText,
	estimateReview,
	findReviewHeader,
	isYuanColumn,
	type QuickReviewInput,
	reviewInputFromRow,
	suggestReviewColumns,
} from "./review-quick";
import { displayMoney } from "./task-form";
import { readReviewWorkbook } from "./task-setup-attachment";

const emptyInput: QuickReviewInput = { spend: "", consultations: "" };
const selectClass = "w-full rounded-md border bg-background px-2 py-1.5";
type QuickEstimate = ReturnType<typeof estimateReview>;
type Workbook = Awaited<ReturnType<typeof readReviewWorkbook>>;

export function QuickReviewPanel({ rules, startOpen }: {
	rules: components["schemas"]["TaskRules"];
	startOpen: boolean;
}) {
	const [values, setValues] = useState(emptyInput);
	const [estimate, setEstimate] = useState<QuickEstimate | null>(null);
	const [error, setError] = useState("");
	const workbookSection = useRef<HTMLDetailsElement>(null);

	function update(input: QuickReviewInput) {
		setValues(input);
		setEstimate(null);
		setError("");
	}

	function calculate(input: QuickReviewInput) {
		try {
			setEstimate(estimateReview(input, rules));
			setError("");
		} catch (cause) {
			setEstimate(null);
			setError(cause instanceof Error ? cause.message : "请检查填写的数字。");
		}
	}

	return (
		<details open={startOpen || undefined} className="group rounded-lg border bg-muted/25">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold marker:hidden">
				<ChevronRight aria-hidden="true" className="size-4 shrink-0 group-open:rotate-90" />
				快速看看
			</summary>
			<div className="space-y-4 border-t px-4 py-4">
				<p className="text-sm text-muted-foreground">填同一时段的数字，知道一项就可以先看。两项都有时，可以试算每次咨询花了多少钱。</p>
				<form className="space-y-3" onSubmit={(event) => {
					event.preventDefault();
					calculate(values);
				}}>
					<div className="grid gap-3 sm:grid-cols-2">
						<label className="block space-y-1 text-sm font-medium">
							<span>投放花费（元）</span>
							<Input inputMode="decimal" placeholder="例如 300" value={values.spend}
								onChange={(event) => update({ ...values, spend: event.target.value })} />
						</label>
						<label className="block space-y-1 text-sm font-medium">
							<span>咨询次数</span>
							<Input inputMode="numeric" placeholder="例如 12" value={values.consultations}
								onChange={(event) => update({ ...values, consultations: event.target.value })} />
						</label>
					</div>
					<p className="text-xs text-muted-foreground">不知道就留空，确认没有花费或咨询时填 0。</p>
					<Button type="submit" disabled={!values.spend.trim() && !values.consultations.trim()}>
						<Calculator aria-hidden="true" /> 看看结果
					</Button>
				</form>
				{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
				{estimate ? <QuickResult estimate={estimate} /> : null}
				<details ref={workbookSection} className="rounded-lg border bg-background">
					<summary className="cursor-pointer px-3 py-2 text-sm font-medium">
						<FileSpreadsheet aria-hidden="true" className="mr-2 inline size-4" />
						从 Excel 带入
					</summary>
					<WorkbookReview onConfirm={(input) => {
						update(input);
						calculate(input);
						if (workbookSection.current) workbookSection.current.open = false;
					}} />
				</details>
			</div>
		</details>
	);
}

function QuickResult({ estimate }: { estimate: QuickEstimate }) {
	const { spendMinor, consultations } = estimate;
	const unitCost = "unitCostMinor" in estimate ? estimate.unitCostMinor : undefined;
	const limit = "limit" in estimate ? estimate.limit : undefined;
	const costLabel = unitCost === 0 && spendMinor ? "不足 0.01 元" : `约 ${displayMoney(unitCost, true)} 元`;
	return (
		<div role="status" className="space-y-2 rounded-md border bg-card p-3 text-sm">
			<p className="font-semibold">本次试算</p>
			<p className="flex flex-wrap gap-x-5 gap-y-1">
				<span>花费 {spendMinor === undefined ? "未填写" : `${displayMoney(spendMinor, true)} 元`}</span>
				<span>咨询 {consultations === undefined ? "未填写" : `${consultations.toLocaleString("zh-CN")} 次`}</span>
			</p>
			{unitCost !== undefined ? (
				<p className="text-lg font-semibold tabular-nums">平均每次咨询{costLabel}</p>
			) : (
				<p>{consultations === 0 ? "这段时间没有收到咨询，单次咨询成本无法计算。" :
					"补齐同一时段的花费和咨询次数，就能试算单次咨询成本。"}</p>
			)}
			{limit ? (
				<p>{limit.belowMinimum ? "数据量低于任务设置的最低要求，暂时不判断成本是否超标。" :
					`按本次数字估算，单次成本${limit.exceeded ? "高于" : "未超过"}任务设定的 ${displayMoney(limit.minor, true)} 元警戒线。`}</p>
			) : null}
			<p className="text-xs text-muted-foreground">结果只在当前页面显示，供快速参考。</p>
		</div>
	);
}

function WorkbookReview({ onConfirm }: { onConfirm: (values: QuickReviewInput) => void }) {
	const [workbook, setWorkbook] = useState<Workbook>([]);
	const [name, setName] = useState("");
	const [sheet, setSheet] = useState(0);
	const [reading, setReading] = useState(false);
	const [error, setError] = useState("");
	const fileInput = useRef<HTMLInputElement>(null);

	async function readFile(file: File) {
		setReading(true);
		setError("");
		setName("");
		setWorkbook([]);
		try {
			const loaded = (await readReviewWorkbook(file)).filter(({ data }) => data.length > 0);
			if (!loaded.length) throw new Error("表格没有可读取的内容，也可以在上面手动填写。");
			setSheet(0);
			setName(file.name);
			setWorkbook(loaded);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "无法读取表格。");
		} finally {
			setReading(false);
		}
	}

	return (
		<div className="space-y-3 border-t p-3 text-sm">
			<p className="text-muted-foreground">选择 Excel 报表（.xlsx，最多 8 MB）。核对两个数字后即可试算。</p>
			<input ref={fileInput} type="file" hidden aria-label="选择 Excel 报表" accept=".xlsx"
				disabled={reading} onChange={(event) => {
					const file = event.currentTarget.files?.[0];
					event.currentTarget.value = "";
					if (file) void readFile(file);
				}} />
			<Button type="button" variant="outline" disabled={reading} onClick={() => fileInput.current?.click()}>
				<FileSpreadsheet aria-hidden="true" />
				{name ? "换一份 Excel" : "选择 Excel 报表"}
			</Button>
			{reading ? <p role="status">正在读取表格…</p> : null}
			{error ? <p role="alert" className="text-destructive">{error}</p> : null}
			{workbook[sheet] ? (
				<>
					<p className="break-words">已读取 {name}</p>
					{workbook.length > 1 ? (
						<label className="block space-y-1">
							<span>工作表</span>
							<select className={selectClass} value={sheet} onChange={(event) => setSheet(Number(event.target.value))}>
								{workbook.map((item, index) => <option key={index} value={index}>{item.sheet}</option>)}
							</select>
						</label>
					) : null}
					<WorkbookRows key={sheet} data={workbook[sheet].data} onConfirm={onConfirm} />
				</>
			) : null}
		</div>
	);
}

function WorkbookRows({ data, onConfirm }: { data: SheetData<string>; onConfirm: (values: QuickReviewInput) => void }) {
	const [headerNumber, setHeaderNumber] = useState(String(findReviewHeader(data) + 1));
	const header = data[Number(headerNumber) - 1];
	return (
		<div className="space-y-3">
			<details className="text-xs">
				<summary className="cursor-pointer">调整列名所在行（第 {headerNumber || "…"} 行）</summary>
				<label className="mt-2 block max-w-40 space-y-1">
					<span>列名行号</span>
					<Input type="number" min={1} max={data.length} value={headerNumber}
						onChange={(event) => setHeaderNumber(event.target.value)} />
				</label>
			</details>
			{header ? <ReviewMapping key={headerNumber} data={data} headerIndex={Number(headerNumber) - 1} onConfirm={onConfirm} /> :
				<p>请输入表中标题所在的行号。</p>}
		</div>
	);
}

function ReviewMapping({ data, headerIndex, onConfirm }: {
	data: SheetData<string>;
	headerIndex: number;
	onConfirm: (values: QuickReviewInput) => void;
}) {
	const header = data[headerIndex];
	const rows = data.flatMap((row, index) => index > headerIndex && row.some((cell) => cellText(cell) !== "") ? [index] : []);
	const [rowNumber, setRowNumber] = useState(rows.length === 1 ? String(rows[0] + 1) : "");
	const [columns, setColumns] = useState(() => suggestReviewColumns(header));
	const [confirmedSpendCell, setConfirmedSpendCell] = useState("");
	const rowIndex = Number(rowNumber) - 1;
	const selectedRow = rows.includes(rowIndex) ? data[rowIndex] : undefined;
	let preview: QuickReviewInput | undefined;
	let error = "";
	if (selectedRow) {
		try {
			preview = reviewInputFromRow(selectedRow, header, columns);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "请检查选中的行和列。";
		}
	}
	if (!rows.length) return <p>标题下面没有数字。可以调整标题所在行，或回到上方手动填写。</p>;
	const options = header.flatMap((cell, index) => cellText(cell) ? [{ index, label: cellText(cell) }] : []);
	if (options.length > 200) return <p>列太多，请把需要的列复制到新的工作表后重试。</p>;
	const fieldLabels = { spend: "投放花费（元）", consultations: "咨询次数" };
	const needsColumnChoice = !columns.spend || !columns.consultations;
	const spendCell = `${rowIndex}:${columns.spend}`;
	const requiresYuanConfirmation = Boolean(preview?.spend) && !isYuanColumn(cellText(header[Number(columns.spend)]));

	return (
		<div className="space-y-3 rounded-md border p-3">
			{rows.length > 1 ? (
				<>
					<p>表里有 {rows.length} 条记录。请选择本次想看的那一条。</p>
					<div className="flex flex-wrap gap-2">
						{[...new Set([...rows.slice(0, 3), rows[rows.length - 1]])].map((index) => (
							<Button key={index} size="sm" type="button" variant={rowIndex === index ? "secondary" : "outline"}
								aria-pressed={rowIndex === index} onClick={() => setRowNumber(String(index + 1))}>
								第 {index + 1} 行 · {data[index].map(cellText).filter(Boolean).slice(0, 3).join(" / ").slice(0, 30)}
							</Button>
						))}
					</div>
					{rows.length > 4 ? (
						<label className="block max-w-40 space-y-1">
							<span>按行号选择（选填）</span>
							<Input type="number" min={headerIndex + 2} max={data.length} value={rowNumber}
								onChange={(event) => setRowNumber(event.target.value)} />
						</label>
					) : null}
					{rowNumber && !selectedRow ? <p>请选择包含数据的行。</p> : null}
				</>
			) : null}
			{selectedRow ? (
				<>
					<p className="font-medium">核对第 {rowNumber} 行</p>
					{preview ? (
						<table className="w-full text-left text-sm">
							<caption className="sr-only">本次试算的数据</caption>
							<thead className="text-xs text-muted-foreground">
								<tr>
									<th scope="col" className="px-2 py-1 font-medium">项目</th>
									<th scope="col" className="px-2 py-1 font-medium">读取结果</th>
								</tr>
							</thead>
							<tbody>
								{(["spend", "consultations"] as const).map((field) => (
									<tr key={field} className="border-t">
										<th scope="row" className="px-2 py-2 font-medium">{fieldLabels[field]}</th>
										<td className="px-2 py-2 tabular-nums">{preview[field] || "留空"}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : null}
					<details open={needsColumnChoice || Boolean(error) || undefined} className="rounded border px-3 py-2">
						<summary className="cursor-pointer text-sm">{needsColumnChoice ? "选填：补充未识别的数据" : "调整读取结果"}</summary>
						<div className="mt-2 grid gap-3 sm:grid-cols-2">
							{(["spend", "consultations"] as const).map((field) => (
								<label key={field} className="block min-w-0 space-y-1">
									<span>{fieldLabels[field]}来自哪一列</span>
									<select className={selectClass} value={columns[field]}
										onChange={(event) => setColumns({ ...columns, [field]: event.target.value })}>
										<option value="">留空，稍后可手填</option>
										{options.map(({ index, label }) => (
											<option key={index} value={index}>{label.slice(0, 45)} · {cellText(selectedRow[index]).slice(0, 24) || "留空"}（第 {index + 1} 列）</option>
										))}
									</select>
								</label>
							))}
						</div>
					</details>
					{error ? <p role="alert" className="text-destructive">{error}</p> : null}
					{requiresYuanConfirmation ? (
						<label className="flex items-start gap-2">
							<input type="checkbox" className="mt-1" checked={confirmedSpendCell === spendCell}
								onChange={(event) => setConfirmedSpendCell(event.target.checked ? spendCell : "")} />
							<span>我已核对，这个花费数字的单位是人民币元。</span>
						</label>
					) : null}
					<Button type="button" disabled={!preview || (!preview.spend && !preview.consultations) ||
						(requiresYuanConfirmation && confirmedSpendCell !== spendCell)}
						onClick={() => { if (preview) onConfirm(preview); }}>
						确认并试算
					</Button>
				</>
			) : null}
		</div>
	);
}
