// 即时推送渠道：Bark（iOS）与 ntfy（跨平台）。
// 与日汇总的飞书投递并行：日汇总按订阅时间走，即时推送由用户主动触发。
// 两者都不属于「主动提醒」的授权范畴，因此不受 proactiveEnabled 约束，但内容只取本人数据。
import type { Storage } from "@adpluse/core";

export interface PushMessage {
	title: string;
	body: string;
	/** 点击跳转地址（控制台详情页）。 */
	url?: string;
}

export type PushChannelStatus = "ok" | "not_configured" | "failed";

export type PushChannelId = "bark" | "ntfy" | "wecom" | "dingtalk";

export interface PushChannelResult {
	channel: PushChannelId;
	label: string;
	status: PushChannelStatus;
	detail: string | null;
}

export interface PushChannel {
	channel: PushChannelId;
	label: string;
	/** 是否已配置（未配置时界面提示怎么配）。 */
	configured: boolean;
	send(message: PushMessage): Promise<PushChannelResult>;
}

/** 网络抖动重试：只重试网络层失败，不对 4xx 重试（那是配置问题）。 */
async function postWithRetry(
	fetcher: typeof fetch,
	url: string,
	init: RequestInit,
): Promise<Response> {
	try {
		return await fetcher(url, init);
	} catch {
		// 移动网络/跨域链路会偶发连接超时，隔 400ms 再试一次；仍失败就如实上报。
		await new Promise((resolve) => setTimeout(resolve, 400));
		return await fetcher(url, init);
	}
}

const trimSlash = (value: string): string => value.replace(/\/+$/u, "");

/** Bark：POST {server}/push，JSON 体含 device_key / title / body / group / url。 */
export function barkChannel(options: {
	server?: string | undefined;
	deviceKey?: string | undefined;
	fetcher?: typeof fetch;
}): PushChannel {
	const server = trimSlash(options.server ?? "https://api.day.app");
	const deviceKey = options.deviceKey?.trim() ?? "";
	const fetcher = options.fetcher ?? fetch;
	return {
		channel: "bark",
		label: "Bark（iOS）",
		configured: deviceKey.length > 0,
		async send(message) {
			if (!deviceKey) return { channel: "bark", label: "Bark（iOS）", status: "not_configured", detail: "未配置 BARK_KEY" };
			try {
				const response = await postWithRetry(fetcher, `${server}/push`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						device_key: deviceKey,
						title: message.title,
						body: message.body,
						group: "AdPulse",
						level: "active",
						...(message.url ? { url: message.url } : {}),
					}),
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok) {
					// Bark 的 400/404 多为 device_key 错误；如实回显状态码，不伪装成功。
					return { channel: "bark", label: "Bark（iOS）", status: "failed", detail: `Bark 返回 ${response.status}（检查 BARK_KEY 与 BARK_URL）` };
				}
				return { channel: "bark", label: "Bark（iOS）", status: "ok", detail: null };
			} catch {
				return { channel: "bark", label: "Bark（iOS）", status: "failed", detail: "Bark 请求超时或网络不可达" };
			}
		},
	};
}

/** ntfy：POST {server}/{topic}，标题等放 header，正文为请求体。 */
export function ntfyChannel(options: {
	server?: string | undefined;
	topic?: string | undefined;
	fetcher?: typeof fetch;
}): PushChannel {
	const server = trimSlash(options.server ?? "https://ntfy.sh");
	const topic = options.topic?.trim() ?? "";
	const fetcher = options.fetcher ?? fetch;
	return {
		channel: "ntfy",
		label: "ntfy（跨平台）",
		configured: topic.length > 0,
		async send(message) {
			if (!topic) return { channel: "ntfy", label: "ntfy（跨平台）", status: "not_configured", detail: "未配置 NTFY_TOPIC" };
			try {
				const response = await postWithRetry(fetcher, `${server}/${encodeURIComponent(topic)}`, {
					method: "POST",
					headers: {
						title: message.title,
						priority: "default",
						tags: "chart_with_upwards_trend",
						...(message.url ? { click: message.url } : {}),
					},
					body: message.body,
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok) {
					return { channel: "ntfy", label: "ntfy（跨平台）", status: "failed", detail: `ntfy 返回 ${response.status}（检查 NTFY_TOPIC 与 NTFY_URL）` };
				}
				return { channel: "ntfy", label: "ntfy（跨平台）", status: "ok", detail: null };
			} catch {
				return { channel: "ntfy", label: "ntfy（跨平台）", status: "failed", detail: "ntfy 请求超时或网络不可达" };
			}
		},
	};
}

/**
 * 企业微信群机器人：国内可达、免注册（建群即得 webhook），最稳的演示通道。
 * 注意：群机器人有每分钟 20 条限频，超出会被拒；这里只报错不重提，避免刷屏。
 */
export function wecomChannel(options: { webhook?: string | undefined; fetcher?: typeof fetch }): PushChannel {
	const webhook = options.webhook?.trim() ?? "";
	const fetcher = options.fetcher ?? fetch;
	return {
		channel: "wecom",
		label: "企业微信群机器人",
		configured: /^https:\/\//u.test(webhook),
		async send(message) {
			if (!/^https:\/\//u.test(webhook))
				return { channel: "wecom", label: "企业微信群机器人", status: "not_configured", detail: "未配置 WECOM_WEBHOOK" };
			try {
				// markdown 消息支持换行与链接，比纯文本可读。
				const body = {
					msgtype: "markdown",
					markdown: {
						content: [
							`**${message.title}**`,
							message.body.replace(/\n/gu, "\n> "),
							...(message.url ? [`[在控制台查看](${message.url})`] : []),
						].join("\n> "),
					},
				};
				const response = await postWithRetry(fetcher, webhook, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok)
					return { channel: "wecom", label: "企业微信群机器人", status: "failed", detail: `企微返回 ${response.status}` };
				// 企微即使 HTTP 200 也可能带 errcode，必须读出来判断。
				const payload = (await response.json().catch(() => null)) as { errcode?: number; errmsg?: string } | null;
				if (payload && typeof payload.errcode === "number" && payload.errcode !== 0)
					return { channel: "wecom", label: "企业微信群机器人", status: "failed", detail: `企微错误 ${payload.errcode}：${payload.errmsg ?? ""}` };
				return { channel: "wecom", label: "企业微信群机器人", status: "ok", detail: null };
			} catch {
				return { channel: "wecom", label: "企业微信群机器人", status: "failed", detail: "企微请求超时或网络不可达" };
			}
		},
	};
}

/** 钉钉自定义机器人（关键词或加签模式；只公开关键词/无签场景，避免密钥泄漏到前端）。 */
export function dingtalkChannel(options: { webhook?: string | undefined; fetcher?: typeof fetch }): PushChannel {
	const webhook = options.webhook?.trim() ?? "";
	const fetcher = options.fetcher ?? fetch;
	return {
		channel: "dingtalk",
		label: "钉钉自定义机器人",
		configured: /^https:\/\//u.test(webhook),
		async send(message) {
			if (!/^https:\/\//u.test(webhook))
				return { channel: "dingtalk", label: "钉钉自定义机器人", status: "not_configured", detail: "未配置 DINGTALK_WEBHOOK" };
			try {
				const body = {
					msgtype: "markdown",
					markdown: {
						title: message.title,
						text: [
							`### ${message.title}`,
							message.body.replace(/\n/gu, "\n\n"),
							...(message.url ? [`[在控制台查看](${message.url})`] : []),
						].join("\n\n"),
					},
				};
				const response = await postWithRetry(fetcher, webhook, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok)
					return { channel: "dingtalk", label: "钉钉自定义机器人", status: "failed", detail: `钉钉返回 ${response.status}` };
				const payload = (await response.json().catch(() => null)) as { errcode?: number; errmsg?: string } | null;
				if (payload && typeof payload.errcode === "number" && payload.errcode !== 0)
					return { channel: "dingtalk", label: "钉钉自定义机器人", status: "failed", detail: `钉钉错误 ${payload.errcode}：${payload.errmsg ?? ""}` };
				return { channel: "dingtalk", label: "钉钉自定义机器人", status: "ok", detail: null };
			} catch {
				return { channel: "dingtalk", label: "钉钉自定义机器人", status: "failed", detail: "钉钉请求超时或网络不可达" };
			}
		},
	};
}

export function pushChannelsFromEnvironment(env: Record<string, string | undefined>): PushChannel[] {
	// 国内可达的渠道在前（企微/钉钉），境外渠道（ntfy/Bark）作为补充。
	return [
		wecomChannel({ webhook: env.WECOM_WEBHOOK }),
		dingtalkChannel({ webhook: env.DINGTALK_WEBHOOK }),
		ntfyChannel({ server: env.NTFY_URL, topic: env.NTFY_TOPIC }),
		barkChannel({ server: env.BARK_URL, deviceKey: env.BARK_KEY }),
	];
}

/** 渠道配置指引：界面在未配置时展示，避免用户猜环境变量名。 */
export function pushChannelGuide(channel: PushChannelId): string {
	switch (channel) {
		case "wecom":
			return "在企业微信群 → 群设置 → 群机器人 → 添加后复制 Webhook，写进 .env 的 WECOM_WEBHOOK（最推荐：国内直连、免注册）";
		case "dingtalk":
			return "在钉钉群 → 群设置 → 智能群助手 → 添加机器人（选关键词模式，关键词填 AdPulse），把 Webhook 写进 DINGTALK_WEBHOOK";
		case "bark":
			return "在 .env 设置 BARK_KEY（Bark App 里的 device key）；自建服务再设 BARK_URL，默认 https://api.day.app";
		default:
			return "在 .env 设置 NTFY_TOPIC（自己起一个不易猜的字符串，topic 即密码）；自建服务再设 NTFY_URL，默认 https://ntfy.sh";
	}
}

/** 组装即时推送内容：只取本人已确认事件的摘要，不掺未核对线索。 */
export function composeInstantPush(input: {
	eventTitles: string[];
	taskCount: number;
	now: Date;
}): PushMessage {
	const beijing = new Date(input.now.getTime() + 8 * 3_600_000);
	const stamp = `${beijing.getUTCMonth() + 1}月${beijing.getUTCDate()}日 ${String(beijing.getUTCHours()).padStart(2, "0")}:${String(beijing.getUTCMinutes()).padStart(2, "0")}`;
	const lines: string[] = [];
	if (input.eventTitles.length === 0) {
		lines.push("目前没有已确认的市场事件；先在线索区把线索转成事件并补齐依据。");
	} else {
		lines.push(`已确认事件 ${input.eventTitles.length} 条：`);
		for (const title of input.eventTitles.slice(0, 5)) lines.push(`· ${title}`);
		if (input.eventTitles.length > 5) lines.push(`· 还有 ${input.eventTitles.length - 5} 条`);
	}
	if (input.taskCount > 0) lines.push(`关联推广任务 ${input.taskCount} 个`);
	lines.push(`（手动触发 ${stamp}，不是定时汇总）`);
	return { title: "AdPulse 即时推送", body: lines.join("\n") };
}

export type { Storage };
