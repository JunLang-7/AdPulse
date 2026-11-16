// 重新生成 Harness 参考快照（#86 §4.3）：人工更新参考提交时，
// 先用 gh api 下载该提交中的 provider-data.generated.ts，再运行本脚本。
// 生成与测试都不联网，快照是可复核的仓库内证据。
//
// 用法：
//   gh api "repos/deepseek-ai/deepseek-harness/contents/packages/llm/llm-pi-ai/src/provider-data.generated.ts?ref=<commit>" \
//     --jq '.content' | base64 -d > /tmp/provider-data.generated.ts
//   node scripts/capture-harness-provider-data.mjs /tmp/provider-data.generated.ts \
//     docs/reference/harness-provider-data.json <commit> "<pi-ai range>"

import { readFileSync, writeFileSync } from "node:fs";

const [source, out, commit = "e8f7b93a344964de3dca1ace9e72b6e4d6de87cb", piAiRange = "^1.3.0"] = process.argv.slice(2);
if (!source || !out) {
	console.error("usage: capture-harness-provider-data.mjs <raw> <output> [commit] [pi-ai range]");
	process.exit(2);
}

const text = readFileSync(source, "utf8");
const asJson = (literal) => JSON.parse(literal.replaceAll("'", "\""));
const providers = [];
const entry = /^ {2}'([a-z0-9-]+)': \{ ([^}]*) \},$/gm;
let match;
while ((match = entry.exec(text))) {
	const [, id, body] = match;
	const envMatch = /env: (\[[^\]]*\])/.exec(body);
	if (!envMatch?.[1]) throw new Error(`missing env list for ${id}`);
	const baseUrlEnv = /baseURLEnv: (\[[^\]]*\])/.exec(body);
	const defaultBaseURL = /defaultBaseURL: '([^']*)'/.exec(body);
	providers.push({
		id,
		env: asJson(envMatch[1]),
		...(baseUrlEnv?.[1] ? { baseUrlEnv: asJson(baseUrlEnv[1]) } : {}),
		...(defaultBaseURL?.[1] ? { defaultBaseURL: defaultBaseURL[1] } : {}),
	});
}
if (providers.length === 0) throw new Error("no providers found; check the raw file format");
providers.sort((left, right) => left.id.localeCompare(right.id));
writeFileSync(out, JSON.stringify({
	source: {
		repository: "https://github.com/deepseek-ai/deepseek-harness",
		commit,
		path: "packages/llm/llm-pi-ai/src/provider-data.generated.ts",
		piAiRange,
		note: "由 gen-provider-data 从当时安装的 pi-ai 目录生成；不含模型清单与真实可用性。",
	},
	providers,
}, null, "\t") + "\n", "utf8");
console.log(`wrote ${providers.length} providers to ${out}`);
