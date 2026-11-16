// 合成 Gemini 流式响应；只用于适配层测试，不表示真实供应商验收。
export function geminiReply(chunks: unknown[], status = 200): Response {
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
		status,
		headers: { "content-type": "text/event-stream" },
	});
}

export function geminiText(content: string, finishReason = "STOP"): Response {
	const middle = Math.ceil(content.length / 2);
	return geminiReply([
		{ candidates: [{ content: { role: "model", parts: [{ text: content.slice(0, middle) }] } }] },
		{
			candidates: [{
				content: { role: "model", parts: [{ text: content.slice(middle) }, { text: "thinking", thought: true }] },
				finishReason,
			}],
			usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
		},
	]);
}
