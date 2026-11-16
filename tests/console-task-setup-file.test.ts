import assert from "node:assert/strict";
import test from "node:test";
import {
	readTaskSetupFile,
	TASK_SETUP_ATTACHMENT_MAX_BYTES,
	TASK_SETUP_BRIEF_LIMIT,
} from "../apps/console/src/views/adpulse/tasks/task-setup-file.ts";

test("reads supported UTF-8 files as local preview text", async () => {
	for (const [name, text] of [
		["brief.TXT", "  向测试客户王小明介绍试用装。\r\n"],
		["brief.md", "# 新品试用装\n- 有免费样品\n"],
		["brief.csv", '渠道,卖点\r\n小红书,"免费试用,送货上门"\r\n'],
	] as const) {
		assert.equal(await readTaskSetupFile(new File(["\uFEFF", text], name)), text);
	}
});

test("rejects unsupported extensions before reading", async () => {
	for (const name of ["brief.pdf", "brief.xlsx", "brief.txt.exe"]) {
		await assert.rejects(
			readTaskSetupFile({
				name,
				size: 10,
				arrayBuffer: async () => assert.fail("unsupported files should not be read"),
			}),
			/请选择 .*文本文件/,
		);
	}
});

test("rejects invalid encoding, disguised binary formats and empty text", async () => {
	await assert.rejects(
		readTaskSetupFile(new File([new Uint8Array([0xc3, 0x28])], "brief.txt")),
		/UTF-8/,
	);
	await assert.rejects(
		readTaskSetupFile(new File(["表格\u0000数据"], "renamed.csv")),
		/纯文本/,
	);
	await assert.rejects(
		readTaskSetupFile(new File(["%PDF-1.4\n%%EOF\n"], "renamed.txt")),
		/纯文本/,
	);
	await assert.rejects(readTaskSetupFile(new File(["\uFEFF  \t\n"], "empty.md")), /没有可读取的文字/);
});

test("reads text longer than the model brief and rejects oversized files before decoding", async () => {
	const text = "样".repeat(TASK_SETUP_BRIEF_LIMIT + 1);
	assert.equal(await readTaskSetupFile(new File(["\uFEFF", text], "brief.md")), text);
	await assert.rejects(
		readTaskSetupFile({
			name: "large.csv",
			size: TASK_SETUP_ATTACHMENT_MAX_BYTES + 1,
			arrayBuffer: async () => assert.fail("oversized files should not be read"),
		}),
		/超过 8 MB/,
	);
});
