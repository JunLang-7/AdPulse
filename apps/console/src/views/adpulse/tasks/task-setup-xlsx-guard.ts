const maxRows = 10_000;
const maxColumns = 16_384;
const maxGridCells = 200_000;

const invalidCoordinates = "无法识别工作表坐标，请用 Excel 或 WPS 另存为 .xlsx 后重试。";
const worksheetTooLarge = "工作表范围过大，请把相关行列复制到新工作表后重试。";

type WorksheetRow = {
	index: string | null;
	cells: Iterable<string | null>;
};

function positiveIndex(value: string): number {
	if (!/^\+?[0-9]+$/.test(value.trim())) throw new Error(invalidCoordinates);
	const index = Number(value);
	if (index < 1) throw new Error(invalidCoordinates);
	return index;
}

export function checkXlsxGridBounds(rows: Iterable<WorksheetRow>): number {
	let lastRow = 0;
	let maxColumn = 1;
	let cellCount = 0;
	for (const { index, cells } of rows) {
		let currentRow = Math.max(lastRow + 1, index === null ? 0 : positiveIndex(index));
		if (currentRow > maxRows) throw new Error(worksheetTooLarge);
		for (const cell of cells) {
			if (++cellCount > maxGridCells) throw new Error(worksheetTooLarge);
			const address = /^([A-Z]{1,3})([0-9]+)$/.exec(cell ?? "");
			if (!address) throw new Error(invalidCoordinates);
			const [, letters, row] = address;
			let column = 0;
			for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
			currentRow = Math.max(currentRow, positiveIndex(row));
			maxColumn = Math.max(maxColumn, column);
		}
		if (currentRow > maxRows || maxColumn > maxColumns || currentRow * maxColumn > maxGridCells)
			throw new Error(worksheetTooLarge);
		lastRow = currentRow;
	}
	return lastRow * maxColumn;
}

function coordinate(element: Element): string | null {
	let result: string | null = null;
	for (const attribute of element.attributes) {
		if (attribute.localName !== "r" || attribute.namespaceURI === "http://www.w3.org/2000/xmlns/") continue;
		if (result !== null) throw new Error(invalidCoordinates);
		result = attribute.value;
	}
	return result;
}

function* worksheetCells(row: Element): Iterable<string | null> {
	for (const cell of row.getElementsByTagNameNS("*", "c")) yield coordinate(cell);
}

function* worksheetRows(document: Document): Iterable<WorksheetRow> {
	for (const row of document.getElementsByTagNameNS("*", "row")) {
		yield { index: coordinate(row), cells: worksheetCells(row) };
	}
}

export function checkXlsxWorksheetCoordinates(xml: string): number {
	if (/<!DOCTYPE\s/.test(xml)) throw new Error(invalidCoordinates);
	const document = new DOMParser().parseFromString(xml, "application/xml");
	if (document.documentElement.localName !== "worksheet" || document.getElementsByTagName("parsererror").length)
		throw new Error(invalidCoordinates);
	// The reader allocates row gaps and pads every row to the widest cell.
	return checkXlsxGridBounds(worksheetRows(document));
}
