// 合成 Responses SSE；只用于适配层测试，不表示真实供应商验收。
export function responsesReply(content: string, status = "completed", terminal = true): Response {
	const item = {
		id: "msg_synthetic", type: "message", role: "assistant", status: "completed",
		content: [{ type: "output_text", text: content, annotations: [] }],
	};
	const response = { id: "resp_synthetic", status, output: [item], incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null };
	const events: Record<string, unknown>[] = [
		{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: content.slice(0, 5) },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: content.slice(5) },
		{ type: "response.output_item.done", output_index: 0, item },
	];
	if (terminal) events.push({ type: `response.${status}`, response });
	return new Response(events.map((event, sequence_number) =>
		`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
