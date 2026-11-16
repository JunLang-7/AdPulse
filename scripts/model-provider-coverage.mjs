// 生成 docs/model-provider-coverage.md（#86 §4.3/§10 的逐项覆盖与差异清单）。
// 数据只来自锁定 pi-ai 版本生成的目录，不手写品牌清单；
// “目录存在 / 适配可用 / 个人已配置 / 真实测试通过”是四个独立状态，不互相替代。
//
// 用法：先 `bun run build`，再 `bun run model-coverage:generate`
// 漂移由 tests/model-coverage.test.ts 守住。

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { modelCatalogDocument } from "../packages/runtime/dist/model-catalog.generated.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const coverageDocPath = join(root, "docs", "model-provider-coverage.md");

export function authLabel(auth) {
	if (!auth) return "—";
	const keyLabel = auth.name ?? "API Key";
	if (auth.apiKey && auth.oauth) return `${keyLabel} / 账号授权（OAuth）`;
	if (auth.apiKey) return keyLabel;
	if (auth.oauth) return "账号授权（OAuth）";
	return "—";
}

function cell(value) {
	return String(value).replaceAll("|", "\\|");
}

export function renderCoverage(document) {
	const providers = [...document.providers].sort((left, right) =>
		Number(right.supported) - Number(left.supported) || left.id.localeCompare(right.id));
	const supported = providers.filter((provider) => provider.supported);
	const models = supported.reduce((sum, provider) => sum + provider.models.length, 0);
	const unsupported = providers.length - supported.length;
	const rows = providers.map((provider, index) => {
		const adaptation = provider.supported
			? `可直连（个人 API Key · ${[...new Set(provider.models.map((model) => model.api === "openai-responses" ? "Responses" : model.api === "anthropic-messages" ? "Anthropic Messages"
				: model.api === "google-generative-ai" ? "Gemini"
					: "Chat Completions"))].join(" / ")}）`
			: `未接通：${provider.reason ?? "未说明"}`;
		return `| ${index + 1} | ${cell(provider.name)} | \`${provider.id}\` | ${cell(authLabel(provider.auth))} | ${provider.protocols.length ? provider.protocols.map((item) => `\`${item}\``).join(" / ") : "—"} | ${provider.catalogModelCount} | ${cell(adaptation)} | 未验收 |`;
	});
	return [
		"<!-- 由 `bun run model-coverage:generate` 生成，勿手改。 -->",
		"",
		"# 模型供应商覆盖清单",
		"",
		`来源：锁定版本 \`${document.generatedFrom.package}@${document.generatedFrom.version}\` 的完整供应商目录。`,
		"本表由锁定 pi-ai 目录生成；目录模型数包含未接通项，可直连汇总仅计算已适配模型。认证列保留 SDK 认证名称，apiKey 扩展点也可能代表云凭据链。尚未完成与 Harness 参考提交的逐项差异核对。",
		"",
		"状态是四个独立事实，不能互相替代：",
		"",
		"1. **目录存在**：SDK 里有这个供应商与模型。",
		"2. **AdPulse 适配可用**：已接通“个人 API Key + OpenAI Chat Completions / Responses / Anthropic Messages / Gemini”；通过的是合成适配测试。",
		"3. **本人已配置密钥**：运行时数据，不在本文档里。",
		"4. **真实供应商验收**：逐家真实联调；本表统一记为“未验收”，不因目录存在或合成测试通过而改写。",
		"",
		`汇总：${providers.length} 个供应商；${supported.length} 个可直连（${models} 个模型）；${unsupported} 个未接通；真实供应商验收 0 个。`,
		"",
		"| # | 供应商 | Provider ID | 认证 | 协议 | 目录模型 | AdPulse 适配 | 真实验收 |",
		"| -: | --- | --- | --- | --- | -: | --- | --- |",
		...rows,
		"",
		"## 差异与后续",
		"",
		"- 未接通的主因：原生协议未适配（`mistral-conversations`、`bedrock-converse-stream` 等），或需要账号/区域/部署名等额外参数，或仅提供账号授权。提供可选 OAuth 不妨碍其个人 API Key 路径单独接入。",
		"- `google-generative-ai` 的 pi-ai 适配器拒绝自定义 `fetch`，要纳入受控出网需要自研传输层，不能直接开启。",
		"- 接入新协议时，必须同时补：协议适配、合成响应测试、二次验证与共享限额复用、“真实供应商验收”单独取证。",
		"",
	].join("\n");
}

export function writeCoverage(document = modelCatalogDocument) {
	writeFileSync(coverageDocPath, renderCoverage(document), "utf8");
	return coverageDocPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const path = writeCoverage();
	console.log(`wrote ${path}`);
}
