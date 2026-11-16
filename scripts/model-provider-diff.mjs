// 生成 docs/model-provider-diff-harness.md：与 Harness 固定参考提交的逐家差异。
// 输入都是仓库内快照与已生成目录，运行时不联网。
// 用法：先 `bun run build`，再 `bun run model-diff:generate`
// 漂移由 tests/model-provider-diff.test.ts 守住。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { modelCatalogDocument } from "../packages/runtime/dist/model-catalog.generated.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const harnessSnapshotPath = join(root, "docs", "reference", "harness-provider-data.json");
export const diffDocPath = join(root, "docs", "model-provider-diff-harness.md");

/** 我们实际接通的原生协议；其余协议一律 422，不降级。 */
export const wiredProtocols = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
/** Harness 自定义表单里的四种协议已全部接通；清单保留给后续新增协议时使用。 */
export const unwiredCustomProtocols = [];

export function loadHarnessSnapshot() {
	return JSON.parse(readFileSync(harnessSnapshotPath, "utf8"));
}

function authEntry(entry) {
	// 空变量表 = 只靠账号授权；没有个人密钥变量 = 云凭据/账号链。
	if (entry.env.length === 0) return "账号授权（OAuth）";
	const personal = entry.env.filter((name) => /(_API_KEY|_TOKEN|_AUTH_TOKEN)$/u.test(name));
	return personal.length === 0 ? "云凭据/账号" : "个人 Key 或更多";
}

function adaptation(provider) {
	if (!provider.supported) return `未接通：${provider.reason ?? "未说明"}`;
	const protocols = [...new Set(provider.models.map((model) => model.api))]
		.map((api) => api === "anthropic-messages" ? "Anthropic Messages"
			: api === "openai-responses" ? "Responses"
				: api === "google-generative-ai" ? "Gemini" : "Chat Completions");
	return `可直连（个人 API Key · ${protocols.join(" / ")}）`;
}

export function renderDiff(catalog, snapshot) {
	const ours = new Map(catalog.providers.map((provider) => [provider.id, provider]));
	const theirs = new Map(snapshot.providers.map((provider) => [provider.id, provider]));
	const onlyHarness = [...theirs.keys()].filter((id) => !ours.has(id)).sort();
	const onlyAdPulse = [...ours.keys()].filter((id) => !theirs.has(id)).sort();
	const shared = [...theirs.keys()].filter((id) => ours.has(id)).sort();
	const supported = catalog.providers.filter((provider) => provider.supported);
	const models = supported.reduce((sum, provider) => sum + provider.models.length, 0);
	const rows = shared.map((id) => {
		const mine = ours.get(id);
		const their = theirs.get(id);
		return `| \`${id}\` | ${their.env.length} | ${authEntry(their)} | \`${their.defaultBaseURL ?? "—"}\` | \`${mine.baseUrl ?? "—"}\` | ${adaptation(mine)} |`;
	});
	return [
		"<!-- 由 `bun run model-diff:generate` 生成，勿手改。 -->",
		"",
		"# 与 Harness 参考目录的逐家差异",
		"",
		`参考提交：[\`${snapshot.source.commit}\`](${snapshot.source.repository}/tree/${snapshot.source.commit})，`,
		`取 \`${snapshot.source.path}\`（由 Harness 的 \`gen-provider-data\` 从当时安装的 pi-ai 目录生成）。`,
		`该提交的 pi-ai 依赖为 \`${snapshot.source.piAiRange}\`；AdPulse 锁定 \`${catalog.generatedFrom.package}@${catalog.generatedFrom.version}\`。`,
		"",
		"## 结论",
		"",
		`- 供应商集合一致：双方各 ${theirs.size} 家，仅 Harness 有 ${onlyHarness.length} 家，仅 AdPulse 有 ${onlyAdPulse.length} 家。`,
		`- **版本不同**：参考提交用 \`${snapshot.source.piAiRange}\`，本仓库锁 1.5.0，因此模型清单与个别端点差异来自 SDK 版本，不能直接按本表推算对方模型数。`,
		`- AdPulse 可直连 ${supported.length} 家、${models} 个模型（个人 API Key + ${wiredProtocols.map((item) => `\`${item}\``).join(" / ")}）；其余家保留在目录里并写明原因，不隐藏。`,
		`- 自定义协议：Harness 表单里的四种（Chat Completions / Responses / Messages / Gemini）已全部接通；Gemini 由本仓库自研受控传输，因为 pi-ai 适配器拒绝自定义 fetch。`,
		"- 认证范围不同：Harness 接受账号登录、云凭据链与多环境变量；AdPulse 本期只接受**个人 API Key**，不读取部署环境凭据或其他人的密钥。",
		"- 真实供应商验收：双方在本表中都**没有**验收证据；本表只说明目录覆盖与适配状态。",
		"",
		"## 逐家对照",
		"",
		"| Provider | Harness 认证变量数 | Harness 认证入口 | Harness 默认端点 | AdPulse 目录端点 | AdPulse 适配 |",
		"| --- | -: | --- | --- | --- | --- |",
		...rows,
		"",
		"## 未列入的差异",
		"",
		"- 模型级差异（同一供应商的模型清单、价格、上下文）未逐项比对：参考快照只含端点与环境变量名，不含模型清单。",
		"- Harness 的凭据文件、profile 与共享 credential reference 不在对照范围；AdPulse 明确不采用这些方式。",
		"- 两家都未接通 `google-generative-ai` 之外的重型能力（图片/音视频、插件、任意 headers）不在本期范围。",
		"",
	].join("\n");
}

export function writeDiff(catalog = modelCatalogDocument, snapshot = loadHarnessSnapshot()) {
	const text = renderDiff(catalog, snapshot);
	writeFileSync(diffDocPath, text, "utf8");
	return diffDocPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	console.log(`wrote ${writeDiff()}`);
}
