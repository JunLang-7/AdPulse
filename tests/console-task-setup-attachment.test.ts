import assert from "node:assert/strict";
import test from "node:test";
import { readTaskSetupAttachment, TASK_SETUP_PREVIEW_LIMIT } from "../apps/console/src/views/adpulse/tasks/task-setup-attachment.ts";

test("attachment preview continues to accept UTF-8 text and labels full results", async () => {
	assert.deepEqual(await readTaskSetupAttachment(new File(["产品：试用装"], "brief.csv")), {
		text: "产品：试用装", clipped: false,
	});
});

test("attachment preview rejects unsupported, oversize and disguised documents", async () => {
	await assert.rejects(readTaskSetupAttachment(new File(["word"], "legacy.doc")), /请选择 PDF/);
	await assert.rejects(readTaskSetupAttachment(new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.pdf")), /超过 8 MB/);
	await assert.rejects(readTaskSetupAttachment(new File(["not a package"], "broken.docx")), /无法读取这个文档/);
});

test("long text attachments are clipped at the local preview limit without splitting a surrogate pair", async () => {
	const prefix = "字".repeat(TASK_SETUP_PREVIEW_LIMIT - 1);
	assert.deepEqual(await readTaskSetupAttachment(new File([prefix, "🍵"], "brief.txt")), {
		text: prefix, clipped: true,
	});
});
