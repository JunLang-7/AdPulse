// 合成 Anthropic Messages SSE；只用于适配层测试，不表示真实供应商验收。
export function anthropicReply(content: string, stopReason = "end_turn", terminal = true): Response {
	const events: Array<[string, unknown]> = [
		["message_start", {
			type: "message_start",
			message: {
				id: "msg_synthetic", type: "message", role: "assistant", model: "synthetic",
				content: [], stop_reason: null, stop_sequence: null,
				usage: { input_tokens: 12, output_tokens: 0 },
			},
		}],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["ping", { type: "ping" }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content.slice(0, 5) } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content.slice(5) } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 9 } }],
	];
	if (terminal) events.push(["message_stop", { type: "message_stop" }]);
	return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
