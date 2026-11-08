// 验收记录渲染与落盘。
// 每行必须带证据来源标签；只有 platform-real 行可支撑真机验收勾选。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { EVIDENCE_NOTES, iconOf } from "./checks.mjs";

const escapeCell = (value) => String(value ?? "").replace(/\|/g, "\\|");

/** `<UTC yyyy-MM-dd-HHmm>-<suffix>.md`，与既有记录命名一致。 */
export function recordFileName(now = new Date(), suffix = "feishu-e2e") {
	const stamp = now.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
	return `${stamp}-${suffix}.md`;
}

/**
 * @param {{
 *   title: string,
 *   generator: string,
 *   subtitle?: string[],
 *   meta?: Array<[string, string]>,
 *   results?: Array<{ title: string, status: string, detail?: string, evidence: string }>,
 *   manualItems?: Array<{ title: string, mode: string }>,
 *   footerLines?: string[],
 *   notices?: string[],
 * }} options
 */
export function renderRecord(options) {
	const {
		title,
		generator,
		subtitle = [],
		meta = [],
		results = [],
		manualItems = [],
		footerLines = [],
		notices = [],
	} = options;

	const metaRows = meta.map(([key, value]) => `| ${key} | ${value} |`).join("\n");
	const checkRows = results
		.map(
			(item) =>
				`| ${escapeCell(item.title)} | ${iconOf(item.status)} ${item.status} | ${item.evidence} | ${escapeCell(item.detail)} |`,
		)
		.join("\n");
	const manualRows = manualItems
		.map(
			(item) =>
				`| ${escapeCell(item.title)} | ${item.mode} | 待人工填写 | 待人工填写 | 待人工填写 | 待人工填写 |`,
		)
		.join("\n");
	const legend = Object.entries(EVIDENCE_NOTES)
		.map(([level, note]) => `- \`${level}\`：${note}。`)
		.join("\n");

	return `# ${title}

> 由 ${generator} 生成。自动检查只覆盖可脚本化的部分，**不能替代真机验收**；
> 请按 [feishu-e2e.md](../feishu-e2e.md) 逐项执行手工步骤并回填下表。提交前复核全文已脱敏。
${subtitle.map((line) => `>\n> ${line}`).join("\n")}
## 元信息

| 项 | 值 |
| --- | --- |
${metaRows}

## 自动自检

| 检查 | 结果 | 来源 | 判定依据（已脱敏） |
| --- | --- | --- | --- |
${checkRows}

证据来源分级；只有 \`platform-real\` 可勾选真机验收项：

${legend}

未通过项的原因与处理：待人工填写。

## 验收项与执行方式

| 验收项 | 执行方式 | 实际结果 | 时延 / 时间戳 | 证据（脱敏） | 遗留限制 |
| --- | --- | --- | --- | --- | --- |
${manualRows}

## 未覆盖与阻塞

- [ ] 缺凭据或环境引起的阻塞：待填写
- [ ] 未覆盖的验收项：待填写
${notices.map((line) => `- ${line}`).join("\n")}
## 结论

${footerLines.join("\n")}
`;
}

/**
 * 落盘。同名文件默认不覆盖，必须显式 force。
 * @returns {string} 绝对路径，或已存在时返回空串
 */
export function writeRecord(directory, fileName, content, options = {}) {
	const { force = false, log = console.log } = options;
	const file = resolve(directory, fileName);
	if (existsSync(file) && !force) {
		log(`\n记录已存在，未覆盖：${file}（加 --force 覆盖）`);
		return "";
	}
	mkdirSync(directory, { recursive: true });
	writeFileSync(file, content);
	log(`\n已写入验收记录：${file}`);
	return file;
}
