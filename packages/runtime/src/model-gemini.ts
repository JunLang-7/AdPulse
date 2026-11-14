// Gemini（google-generative-ai）受控传输（#86 §4.4）。
// pi-ai 1.5.0 的 Google 适配器明确拒绝自定义 fetch，无法把请求纳入本项目的受控出网，
// 因此这一种协议由本模块直接构造 REST 流式请求；其余协议仍走 pi-ai 适配器。
//
// 约束与其他协议一致：只发一次请求、固定端点、超时、线缆响应大小上限、
// 密钥只放在 x-goog-api-key 头里（不进 URL，避免进入代理日志）。

export const geminiRequestTimeoutMs = 12_000;
export const geminiMaxWireBytes = 512 * 1024;
const maxGeminiText = 16 * 1024;
const modelIdPattern = /^[A-Za-z0-9._~-]{1,160}$/u;

export interface GeminiRoute {
	baseUrl: string;
	modelId: string;
	apiKey: string;
}

export interface GeminiTextResult {
	text: string;
	/** 归一化后的结束原因；只有 "stop" 代表可用结果。 */
	stopReason: "stop" | "length" | "blocked" | "other";
}

export function isGeminiModelId(modelId: string): boolean {
	return modelIdPattern.test(modelId);
}

/** Gemini 的流式端点；model id 已限制字符集，避免拼出别的路径。 */
export function geminiEndpoint(baseUrl: string, modelId: string): string {
	return `${baseUrl}/models/${modelId}:streamGenerateContent?alt=sse`;
}

export function geminiRequestBody(input: { systemPrompt: string; brief: string; maxOutputTokens: number }) {
	return JSON.stringify({
		contents: [{ role: "user", parts: [{ text: input.brief }] }],
		systemInstruction: { parts: [{ text: input.systemPrompt }] },
		generationConfig: {
			temperature: 0,
			maxOutputTokens: input.maxOutputTokens,
			responseMimeType: "application/json",
		},
	});
}

function mapFinishReason(reason: unknown): GeminiTextResult["stopReason"] {
	if (typeof reason !== "string") return "other";
	if (reason === "STOP") return "stop";
	if (reason === "MAX_TOKENS") return "length";
	if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(reason)) return "blocked";
	return "other";
}

interface ChunkShape {
	candidates?: { content?: { parts?: { text?: unknown; thought?: unknown }[] }; finishReason?: unknown }[];
	promptFeedback?: { blockReason?: unknown };
}

/**
 * 只接受 `alt=sse` 的 data 行；任何非 JSON、缺少候选、被判停、超长或超时都返回 null，
 * 调用方据此失败关闭，不重试、不降级到别的协议。
 */
export async function requestGeminiText(input: GeminiRoute & {
	systemPrompt: string;
	brief: string;
	maxOutputTokens: number;
	fetchImpl: typeof fetch;
	timeoutMs?: number;
	maxWireBytes?: number;
}): Promise<GeminiTextResult | null> {
	if (!isGeminiModelId(input.modelId)) return null;
	const key = input.apiKey.trim();
	if (!key) return null;
	const endpoint = geminiEndpoint(input.baseUrl, input.modelId);
	const maxWireBytes = input.maxWireBytes ?? geminiMaxWireBytes;
	let response: Response;
	try {
		response = await input.fetchImpl(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				"x-goog-api-key": key,
			},
			body: geminiRequestBody(input),
			redirect: "error",
			signal: AbortSignal.timeout(input.timeoutMs ?? geminiRequestTimeoutMs),
		});
	} catch {
		return null;
	}
	if (!response.ok || !response.body) return null;
	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	let buffer = "";
	let bytes = 0;
	let text = "";
	let stopReason: GeminiTextResult["stopReason"] | undefined;
	let blocked = false;
	const consume = (line: string): void => {
		if (!line.startsWith("data:")) return;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") return;
		let chunk: ChunkShape;
		try {
			chunk = JSON.parse(payload) as ChunkShape;
		} catch {
			throw new Error("invalid gemini chunk");
		}
		if (chunk.promptFeedback?.blockReason) blocked = true;
		const candidate = chunk.candidates?.[0];
		for (const part of candidate?.content?.parts ?? []) {
			if (part.thought === true || typeof part.text !== "string") continue;
			text += part.text;
			if (text.length > maxGeminiText) throw new Error("gemini text too large");
		}
		if (candidate?.finishReason !== undefined) stopReason = mapFinishReason(candidate.finishReason);
	};
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxWireBytes) return null;
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				consume(buffer.slice(0, index).replace(/\r$/u, ""));
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) consume(buffer.replace(/\r$/u, ""));
	} catch {
		return null;
	} finally {
		await reader.cancel().catch(() => {});
	}
	if (blocked) return { text: "", stopReason: "blocked" };
	if (!text) return null;
	return { text, stopReason: stopReason ?? "other" };
}
