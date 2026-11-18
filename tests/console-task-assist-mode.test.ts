import assert from "node:assert/strict";
import test from "node:test";
import {
	assistModeLabel,
	assistModeOptions,
	assistModeStorageKey,
	readAssistMode,
	writeAssistMode,
} from "../apps/console/src/views/adpulse/tasks/task-assist-mode.ts";

function memoryStorage(initial: Record<string, string> = {}) {
	const entries = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => { entries.set(key, value); },
		dump: () => Object.fromEntries(entries),
	};
}

test("the first visit has no stored choice, so the page asks once", () => {
	assert.equal(readAssistMode(memoryStorage()), undefined);
});

test("the chosen mode is recorded and read back", () => {
	const storage = memoryStorage();
	writeAssistMode("stage", storage);
	assert.equal(readAssistMode(storage), "stage");
	writeAssistMode("form", storage);
	assert.equal(readAssistMode(storage), "form");
	assert.deepEqual(storage.dump(), { [assistModeStorageKey]: "form" });
});

test("unknown or corrupted values are treated as unset", () => {
	assert.equal(readAssistMode(memoryStorage({ [assistModeStorageKey]: "everything" })), undefined);
	assert.equal(readAssistMode(memoryStorage({ [assistModeStorageKey]: "" })), undefined);
});

test("a storage that refuses to read or write never breaks the page", () => {
	const broken = {
		getItem: () => { throw new Error("denied"); },
		setItem: () => { throw new Error("denied"); },
	};
	assert.equal(readAssistMode(broken), undefined);
	assert.doesNotThrow(() => writeAssistMode("form", broken));
});

test("both choices are explained in plain language", () => {
	assert.deepEqual(assistModeOptions.map((option) => option.id), ["form", "stage"]);
	for (const option of assistModeOptions) {
		assert.ok(option.title.length > 2);
		assert.ok(option.summary.length > 10, "要说清这个方式怎么给建议");
		assert.ok(option.detail.length > 8, "要说清适合谁");
	}
	assert.equal(assistModeLabel("form"), "整表单一次给");
	assert.equal(assistModeLabel("stage"), "按阶段一次次给");
});
