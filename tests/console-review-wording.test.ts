// 审核验收补充（问题五：分口径衡量）：比较原因文案不得把互动量写成咨询。
import assert from "node:assert/strict";
import test from "node:test";
import { reviewReasonLabels } from "../apps/console/src/views/adpulse/tasks/review-display.ts";

test("比较原因文案对达人/种草口径不使用「咨询」措辞", () => {
	// 同一张原因表现在同时服务三种投放方式：写死「咨询」会把互动量说成咨询。
	const codes = [
		"ATTRIBUTION_MISMATCH",
		"CALLBACK_PENDING",
		"CALLBACK_UNKNOWN",
		"VALUE_MISSING",
		"VALUE_NULL",
		"VALUE_INVALID",
		"RULE_MINIMUMS_MISSING",
		"SAMPLE_BELOW_MINIMUM",
		"ZERO_DENOMINATOR",
	] as const;
	for (const code of codes) {
		assert.doesNotMatch(reviewReasonLabels[code], /咨询/, `${code} 不应对所有口径写「咨询」`);
		assert.match(reviewReasonLabels[code], /结果/, `${code} 应使用中性口径词`);
	}
	// 口径相关的中性词之外，仍要保留明确的「不能直接比较」含义。
	assert.match(reviewReasonLabels.PLACEMENT_TYPE_MISMATCH, /不同投放方式/);
});
