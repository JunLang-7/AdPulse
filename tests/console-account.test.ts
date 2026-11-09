import assert from "node:assert/strict";
import test from "node:test";

import {
	describeIdentity,
	formatSessionExpiry,
	maskIdentifier,
	maskScope,
} from "../apps/console/src/views/adpulse/account/account-display.ts";

test("account display: 标识脱敏保留头尾，缺失时不编造", () => {
	assert.equal(maskIdentifier("ou_83d5b9c8f1a2fd49"), "ou_83d5b***fd49");
	assert.equal(maskIdentifier("short"), "sh***");
	assert.equal(maskIdentifier(undefined), "—");
	assert.equal(maskScope("1988073b70d7da57"), "…da57");
	assert.equal(maskScope(undefined), "—");
	assert.equal(maskScope("ab"), "***");
});

test("account display: 会话到期按本地时间格式化，跨日显示月日", () => {
	const now = new Date(2026, 10, 9, 10, 0);
	assert.equal(
		formatSessionExpiry(new Date(2026, 10, 9, 14, 32).toISOString(), now),
		"今天 14:32 到期",
	);
	assert.equal(
		formatSessionExpiry(new Date(2026, 11, 1, 9, 5).toISOString(), now),
		"12-01 09:05 到期",
	);
	assert.equal(formatSessionExpiry(undefined, now), null);
	assert.equal(formatSessionExpiry("not-a-date", now), null);
});

test("account display: 身份摘要不把完整标识铺到界面上", () => {
	const summary = describeIdentity({
		platform: "feishu",
		applicationId: "cli_aa672e57b6785ce2",
		tenantId: "1988073b70d7da57",
		idType: "open_id",
		externalId: "ou_83d5b9c8f1a2fd49",
	});
	assert.equal(summary.title, "飞书 · ou_83d5b***fd49");
	assert.equal(summary.scope, "租户 …da57 · 应用 …5ce2");
	assert.ok(!summary.title.includes("83d5b9c8f1a2fd49"));
	assert.deepEqual(describeIdentity(undefined), {
		title: "未绑定外部身份",
		scope: "—",
	});
});
