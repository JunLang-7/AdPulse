import assert from "node:assert/strict";
import test from "node:test";
import { checkXlsxGridBounds } from "../apps/console/src/views/adpulse/tasks/task-setup-xlsx-guard.ts";

test("worksheet estimate accounts for wide cells, inferred rows and gaps", () => {
	assert.equal(checkXlsxGridBounds([
		{ index: "1", cells: ["A1", "AA1"] },
		{ index: null, cells: ["B12"] },
		{ index: null, cells: [] },
	]), 13 * 27);
	assert.equal(checkXlsxGridBounds([{ index: "1", cells: ["XFD1"] }]), 16_384);
	assert.equal(checkXlsxGridBounds([]), 0);
});

test("worksheet rejects valid Excel coordinates that would expand to an oversized preview", () => {
	assert.throws(() => checkXlsxGridBounds([{ index: "1048576", cells: [] }]), /工作表范围过大/);
	assert.throws(() => checkXlsxGridBounds([{ index: null, cells: ["A1048576"] }]), /工作表范围过大/);
	assert.throws(() => checkXlsxGridBounds([
		{ index: "1", cells: ["XFD1"] },
		{ index: "100", cells: ["A100"] },
	]), /工作表范围过大/);
});
