// 与 Harness 参考目录的差异文档（#86 §4.3/§10）：文档必须由快照+目录重新渲染一致，
// 且不能把“目录存在”或“合成了适配测试”写成真实供应商验收。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { modelCatalogDocument } from "../packages/runtime/dist/model-catalog.generated.js";
import {
	diffDocPath,
	harnessSnapshotPath,
	loadHarnessSnapshot,
	renderDiff,
	unwiredCustomProtocols,
	wiredProtocols,
} from "../scripts/model-provider-diff.mjs";

const doc = () => readFileSync(diffDocPath, "utf8").replaceAll("\r\n", "\n");

test("reference snapshot pins the Harness commit and its pi-ai range", () => {
	const snapshot = loadHarnessSnapshot();
	assert.equal(snapshot.source.commit, "e8f7b93a344964de3dca1ace9e72b6e4d6de87cb");
	assert.equal(snapshot.source.piAiRange, "^1.3.0");
	assert.equal(snapshot.source.path, "packages/llm/llm-pi-ai/src/provider-data.generated.ts");
	assert.equal(snapshot.providers.length, 42);
	for (const provider of snapshot.providers) {
		assert.match(provider.id, /^[a-z0-9-]+$/u, provider.id);
		// 空变量表是合法的：表示只靠账号授权（OAuth）的供应商。
		assert.ok(Array.isArray(provider.env), provider.id);
	}
	assert.ok(harnessSnapshotPath.endsWith("harness-provider-data.json"));
});

test("diff doc is generated from the snapshot and the committed catalog", () => {
	assert.equal(doc(), renderDiff(modelCatalogDocument, loadHarnessSnapshot()));
});

test("diff doc lists every shared provider exactly once and states the SDK version gap", () => {
	const text = doc();
	const snapshot = loadHarnessSnapshot();
	const shared: string[] = snapshot.providers.map((provider: { id: string }) => provider.id).sort();
	const rows = text.split("\n").filter((line) => line.startsWith("| `"));
	assert.equal(rows.length, shared.length, "一行一个共有供应商");
	for (const id of shared) {
		const matches = rows.filter((row) => row.startsWith(`| \`${id}\` |`));
		assert.equal(matches.length, 1, id);
	}
	assert.match(text, /供应商集合一致/u);
	assert.match(text, /\^1\.3\.0/u);
	assert.match(text, /没有\*\*验收证据|没有\*\*验收/u);
});

test("diff doc never claims live acceptance and keeps unwired protocols visible", () => {
	const text = doc();
	assert.doesNotMatch(text, /已验收|真实验收通过/u);
	for (const protocol of wiredProtocols) assert.ok(text.includes(protocol), protocol);
	for (const protocol of unwiredCustomProtocols) assert.ok(text.includes(protocol), protocol);
	assert.equal(unwiredCustomProtocols.length, 1, "只有 Gemini 仍未接通；改这里必须同时改说明");
});
