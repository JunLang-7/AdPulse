import assert from "node:assert/strict";
import test from "node:test";
import {
	createTaskDraftExtractor,
} from "../packages/runtime/dist/task-draft-extractor.js";

const env = { DEEPSEEK_API_KEY: "synthetic-provider-key" };

function providerReply(content: string): Response {
	const chunk = { id: "synthetic-completion", object: "chat.completion.chunk", created: 1, model: "deepseek-flash" };
	const frames = [
		{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
		{ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	];
	const stream = frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n";
	return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

test("渠道阶段只保留合法的投放方式建议，且不编造已确定的投放安排", async () => {
	const prompts: string[] = [];
	const reply = {
		channels: ["微信视频号"],
		recommendations: {
			channels: ["小红书"],
			placementTypes: ["influencer", "seeding", "unknown_type", "influencer", "__proto__"],
		},
	};
	const extract = createTaskDraftExtractor(env, async (input, init) => {
		const sent = new Request(input, init);
		prompts.push((await sent.json()).messages[0].content as string);
		return providerReply(JSON.stringify(reply));
	});
	assert.ok(extract);
	const result = await extract("想做新品试用", "channels");
	assert.deepEqual(result?.recommendations?.placementTypes, ["influencer", "seeding"]);
	assert.deepEqual(new Set(result?.recommendations?.channels), new Set(["小红书", "微信视频号"]));
	// 提示词明确要求把投放方式当作待核对方向，而不是已确定的事实。
	assert.match(prompts[0] ?? "", /placementTypes 只能从 paid_ads/);
	assert.match(prompts[0] ?? "", /待核对的方向建议/);
});

test("模型没有给出投放方式依据时不产生建议", async () => {
	const extract = createTaskDraftExtractor(env, async () =>
		providerReply(JSON.stringify({ recommendations: { placementTypes: ["unknown"] } })));
	assert.ok(extract);
	const result = await extract("想做新品试用", "channels");
	assert.equal(result?.recommendations?.placementTypes, undefined);
});
