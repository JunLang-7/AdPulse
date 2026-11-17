import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SOURCE_DEFINITIONS, SOURCE_KEYS } from "../packages/core/dist/index.js";

// 来源登记表与 allowlist 必须同步：新增站点却忘了登记（或反过来）都应该在 CI 失败。
const registry = readFileSync(new URL("../docs/sources/registry.md", import.meta.url), "utf8");
/** 只解析「已登记来源」小节，避免把别处的 `| \`purged\` |` 之类当成来源行。 */
const registered = registry.slice(
	registry.indexOf("## 2. 已登记来源"),
	registry.indexOf("## 3."),
);
const rows = [...registered.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((match) => match[1]!);
const registeredRow = (key: string): string | undefined =>
	registered.split("\n").find((row) => row.startsWith(`| \`${key}\` |`));

test("来源登记表：与 SOURCE_DEFINITIONS 双向一致，且每行含站点事实", () => {
	assert.deepEqual([...rows].sort(), [...SOURCE_KEYS].sort(), "登记表与 allowlist 的 key 集合必须相同");
	assert.equal(new Set(rows).size, rows.length, "同一来源不得重复登记");

	for (const key of SOURCE_KEYS) {
		const definition = SOURCE_DEFINITIONS[key]!;
		const line = registeredRow(key);
		assert.ok(line, `${key} 在登记表中缺少一行`);
		for (const expected of [definition.label, definition.listUrl, definition.allowedHosts[0]!, definition.subject.name]) {
			assert.ok(line!.includes(expected), `${key} 的登记行缺少「${expected}」`);
		}
		assert.match(line!, /仅标题 \+ 链接/, `${key} 必须声明只取标题与链接`);
		assert.ok(
			line!.includes(String(definition.dailyRequestLimit)),
			`${key} 的每日请求上限应与 SOURCE_DEFINITIONS（${definition.dailyRequestLimit}）一致`,
		);
	}
});

test("来源登记表：把未签核与依据缺失写在结论位，而不是声称已获授权", () => {
	assert.match(registry, /本表是\*\*登记\*\*，不是合规结论/, "必须声明登记不等于合规结论");
	assert.match(registry, /Gate 0 法务\/合规签核（#41） \| \*\*未签核\*\*/, "必须显式记录 Gate 0 未签核");
	assert.match(registry, /条款原文快照[^|]*\| \*\*未入库\*\*/, "必须记录条款原文快照缺失");
	assert.match(registry, /不得称已授权/, "必须写明对外表述边界");
});
