import assert from "node:assert/strict";
import test from "node:test";

import { platformLabel } from "../apps/console/src/views/auth/platform-label.ts";

test("platform label: 已知平台映射为产品名，未知平台不编造", () => {
	assert.equal(platformLabel("feishu"), "飞书");
	assert.equal(platformLabel("Feishu"), "飞书");
	assert.equal(platformLabel("lark"), "飞书");
	assert.equal(platformLabel("dingtalk"), "钉钉");
	assert.equal(platformLabel("wecom"), "企业微信");
	assert.equal(platformLabel("weixin"), "企业微信");
	// 未登记的平台原样显示，便于发现新平台而不是静默显示错误名称。
	assert.equal(platformLabel("slack"), "slack");
	assert.equal(platformLabel("  "), null);
	assert.equal(platformLabel(undefined), null);
});
