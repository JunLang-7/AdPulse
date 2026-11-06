import assert from "node:assert/strict";
import test from "node:test";
import {
	reduceTaskEditorState,
	reuseOperation,
	type TaskEditorState,
} from "../apps/console/src/views/adpulse/tasks/editor-state.ts";

type Form = { product: string };
const initial = (form: Form, version: number | null): TaskEditorState<Form> => ({
	form,
	version,
	dirty: false,
	remoteVersion: null,
});

test("remote task refresh preserves dirty input and original edit version", () => {
	const local = { product: "本地未保存" };
	const edited = reduceTaskEditorState(initial({ product: "v1" }, 1), {
		type: "edit",
		form: local,
	});
	const refreshed = reduceTaskEditorState(edited, {
		type: "remote",
		version: 2,
		form: { product: "远端 v2" },
	});

	assert.equal(refreshed.form, local);
	assert.equal(refreshed.version, 1);
	assert.equal(refreshed.dirty, true);
	assert.equal(refreshed.remoteVersion, 2);
});

test("clean task refresh initializes from the newest version", () => {
	const refreshed = reduceTaskEditorState(initial({ product: "v1" }, 1), {
		type: "remote",
		version: 2,
		form: { product: "远端 v2" },
	});
	assert.deepEqual(refreshed, {
		form: { product: "远端 v2" },
		version: 2,
		dirty: false,
		remoteVersion: null,
	});
});

test("save advances the edit baseline without discarding changes made in flight", () => {
	const current = reduceTaskEditorState(
		reduceTaskEditorState(initial({ product: "v1" }, 1), {
			type: "edit",
			form: { product: "submitted" },
		}),
		{ type: "edit", form: { product: "edited while saving" } },
	);
	const afterSave = reduceTaskEditorState(current, {
		type: "saved",
		version: 2,
		form: { product: "submitted" },
		submittedForm: { product: "submitted" },
	});

	assert.deepEqual(afterSave, {
		form: { product: "edited while saving" },
		version: 2,
		dirty: true,
		remoteVersion: null,
	});
});

test("retry reuses the same idempotency key and frozen request body", () => {
	const original = {
		key: "operation-key",
		body: { expectedTaskVersion: 2, task: { product: "original" } },
	};
	const retry = reuseOperation(original, () => ({
		key: "new-key",
		body: { expectedTaskVersion: 3, task: { product: "changed" } },
	}));

	assert.equal(retry, original);
	assert.deepEqual(retry.body, {
		expectedTaskVersion: 2,
		task: { product: "original" },
	});
});
