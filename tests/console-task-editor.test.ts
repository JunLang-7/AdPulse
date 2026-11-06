import assert from "node:assert/strict";
import test from "node:test";
import {
	operationAfterSaveError,
	reduceTaskEditorState,
	reuseOperation,
	SaveResponseError,
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

test("correcting a rejected create starts a new operation with the corrected form", () => {
	const failed = {
		kind: "create" as const,
		key: "create-invalid",
		body: { product: "", observation: { startsAt: "2026-02-02", endsAt: "2026-02-01" } },
	};
	const corrected = {
		kind: "create" as const,
		key: "create-corrected",
		body: { product: "有效任务", observation: { startsAt: "2026-02-01", endsAt: "2026-02-02" } },
	};
	const afterRejection = operationAfterSaveError(
		failed,
		failed,
		new SaveResponseError(400, { error: "observation.startsAt" }),
	);
	const next = reuseOperation(afterRejection, () => corrected);

	assert.equal(afterRejection, null);
	assert.notEqual(next.key, failed.key);
	assert.deepEqual(next.body, corrected.body);
});

test("correcting a rejected revision starts a new operation with the corrected form", () => {
	const failed = {
		kind: "revise" as const,
		key: "revise-invalid",
		taskId: "task-1",
		body: { expectedTaskVersion: 2, task: { product: "有效任务", channels: { ads: { budget: -1 } } } },
	};
	const corrected = {
		kind: "revise" as const,
		key: "revise-corrected",
		taskId: "task-1",
		body: { expectedTaskVersion: 2, task: { product: "有效任务", channels: { ads: { budget: 0 } } } },
	};
	const afterRejection = operationAfterSaveError(
		failed,
		failed,
		new SaveResponseError(400, { error: "strategy.channels.ads.budget" }),
	);
	const next = reuseOperation(afterRejection, () => corrected);

	assert.equal(afterRejection, null);
	assert.notEqual(next.key, failed.key);
	assert.equal(next.body.expectedTaskVersion, 2);
	assert.equal(next.body.task.channels.ads.budget, 0);
});

test("unknown failures keep the frozen operation for a safe retry", () => {
	const original = {
		key: "operation-key",
		body: { expectedTaskVersion: 2, task: { product: "original" } },
	};
	assert.equal(
		operationAfterSaveError(original, original, new TypeError("fetch failed")),
		original,
	);
	assert.equal(
		operationAfterSaveError(
			original,
			original,
			new SaveResponseError(503, { error: "temporarily unavailable" }),
		),
		original,
	);
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
