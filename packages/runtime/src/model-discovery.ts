// 模型发现（#86 §4.4 的可选便利项）：只在用户显式点击时，用一次性候选密钥
// 读取供应商的模型列表。不是任意 URL 抓取，也不把“列出了模型”当成生成能力验证。
// 只有已接通受控传输的协议才允许发现；Google 适配器拒绝自定义 fetch，故不开放。

import type { ModelConnectionProtocol } from "@adpluse/core";
import { createModelEgressFetch } from "./model-egress.js";

export const modelDiscoveryMaxModels = 100;
const discoveryTimeoutMs = 10_000;
const maxDiscoveryBytes = 256 * 1024;
const modelIdPattern = /^[\x21-\x7e]{1,160}$/;

export interface ModelDiscoveryInput {
	baseUrl: string;
	protocol: ModelConnectionProtocol;
	apiKey: string;
}

/** 发现与调用共用同一条路由能力；未接通的协议不得单独开放发现。 */
export function isDiscoveryProtocolWired(protocol: ModelConnectionProtocol): boolean {
	return protocol === "openai-completions" || protocol === "openai-responses";
}

/**
 * 读取 `${baseUrl}/models`。失败、超时、非 2xx、非法 JSON 一律返回 null：
 * 调用方提示“无法获取列表”，用户仍可手动填 Model ID。
 */
export async function discoverModels(
	input: ModelDiscoveryInput,
	fetchImpl: typeof fetch = createModelEgressFetch(),
): Promise<string[] | null> {
	const key = input.apiKey.trim();
	if (!key || !isDiscoveryProtocolWired(input.protocol)) return null;
	try {
		const response = await fetchImpl(`${input.baseUrl}/models`, {
			method: "GET",
			headers: { authorization: `Bearer ${key}`, accept: "application/json" },
			signal: AbortSignal.timeout(discoveryTimeoutMs),
		});
		if (!response.ok) return null;
		const text = await response.text();
		if (text.length > maxDiscoveryBytes) return null;
		const body: unknown = JSON.parse(text);
		if (typeof body !== "object" || body === null || !("data" in body)) return null;
		const data = (body as { data: unknown }).data;
		if (!Array.isArray(data)) return null;
		const models = new Set<string>();
		for (const item of data) {
			if (typeof item !== "object" || item === null) continue;
			const id = (item as { id?: unknown }).id;
			if (typeof id !== "string") continue;
			const trimmed = id.trim();
			if (!modelIdPattern.test(trimmed)) continue;
			models.add(trimmed);
			if (models.size >= modelDiscoveryMaxModels) break;
		}
		return [...models];
	} catch {
		return null;
	}
}
