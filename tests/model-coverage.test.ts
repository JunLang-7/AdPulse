// 供应商覆盖清单（#86 §4.3/§10）：文档必须与锁定目录一致，
// 并且不能把“目录存在/合成测试通过”写成“真实供应商已验收”。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { modelCatalogDocument } from "../packages/runtime/dist/model-catalog.generated.js";
import { authLabel, coverageDocPath, renderCoverage } from "../scripts/model-provider-coverage.mjs";

const doc = () => readFileSync(coverageDocPath, "utf8").replaceAll("\r\n", "\n");

test("coverage doc is generated from the committed catalog, not hand-edited", () => {
	assert.equal(doc(), renderCoverage(modelCatalogDocument));
});

test("coverage doc lists every provider and the four separate states", () => {
	const text = doc();
	const providers = modelCatalogDocument.providers;
	const supported = providers.filter((provider) => provider.supported);
	const models = supported.reduce((sum, provider) => sum + provider.models.length, 0);
	assert.match(text, new RegExp(`${providers.length} 个供应商`));
	assert.match(text, new RegExp(`${supported.length} 个可直连（${models} 个模型）`));
	assert.match(text, /真实供应商验收 0 个/);
	for (const provider of providers) assert.ok(text.includes(`\`${provider.id}\``), provider.id);
});

test("coverage doc never marks an unreviewed provider as accepted", () => {
	const text = doc();
	const rows = text.split("\n").filter((line) => line.startsWith("| ") && line.includes("`"));
	const providers = modelCatalogDocument.providers;
	assert.equal(rows.length, providers.length);
	for (const row of rows) assert.match(row, /\| 未验收 \|$/, row);
	assert.doesNotMatch(text, /已验收/);
});

test("coverage keeps SDK cloud-auth labels and full directory model counts", () => {
	assert.equal(authLabel({ apiKey: true, oauth: false, name: "AWS credentials or bearer token" }), "AWS credentials or bearer token");
	const text = doc();
	for (const provider of modelCatalogDocument.providers) {
		const row = text.split("\n").find((line) => line.includes(`| \`${provider.id}\` |`));
		assert.ok(row?.includes(`| ${provider.catalogModelCount} |`), provider.id);
	}
});

test("auth labels come from the SDK declaration", () => {
	assert.equal(authLabel({ apiKey: true, oauth: true }), "API Key / 账号授权（OAuth）");
	assert.equal(authLabel({ apiKey: true, oauth: false }), "API Key");
	assert.equal(authLabel({ apiKey: false, oauth: true }), "账号授权（OAuth）");
	assert.equal(authLabel(undefined), "—");
});
