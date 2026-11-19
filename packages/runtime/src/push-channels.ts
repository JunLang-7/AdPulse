// 即时推送渠道：飞书（复用项目已有的 InfoCard 渲染器，保持卡片格式与日汇总一致）。
// 其他渠道实现保留但不对外暴露。
import { validateInfoCard, type InfoCard } from "@adpluse/core";
import { toFeishuCard } from "@adpluse/channels";
import type { Storage } from "@adpluse/core";

export interface PushMessage {
	title: string;
	body: string;
	/** 点击跳转地址（控制台详情页）。 */
	url?: string;
	/** 可选的完整信息卡：给了就用它渲染，与日汇总同一种卡片。 */
	card?: InfoCard;
}

export type PushChannelStatus = "ok" | "not_configured" | "failed";

export type PushChannelId = "bark" | "ntfy" | "wecom" | "dingtalk" | "feishu";

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

/**
 * 飞书即时推送的卡片：**直接复用项目已有的 InfoCard 渲染器**（与日汇总同一种卡）。
 * 使用前会跑 validateInfoCard：它要求每条带来源、限长度与条数，
 * 所以无来源的内容根本发不出去——这是项目既有的证据纪律，不在这里绕开。
 * 与决策卡的区别：没有任何 callback/actionRef，点按钮只跳控制台。
 */
export function toFeishuInstantCard(message: PushMessage): Record<string, unknown> {
	if (!message.card) throw new Error("instant push requires an InfoCard");
	validateInfoCard(message.card);
	// toFeishuCard 的 InfoCard 分支只读 delivery.card，不碰 actions。
	return toFeishuCard({ card: message.card, actions: [] } as never);
}

/**
 * 飞书即时推送：复用应用 tenant_access_token，发**卡片消息**到你的单聊。
 * 收件人用登录身份绑定的 open_id（与日汇总同一个，不需额外配置）。
 * 它和日汇总的区别：不经过批次调度，事件一确认就自动发。
 */
export function feishuInstantChannel(options: {
	appId?: string | undefined;
	appSecret?: string | undefined;
	/** 已验证的飞书 open_id；未给出时该渠道视为未配置。 */
	receiveId?: string | undefined;
	fetcher?: typeof fetch;
}): PushChannel {
	const appId = options.appId?.trim() ?? "";
	const appSecret = options.appSecret?.trim() ?? "";
	const receiveId = options.receiveId?.trim() ?? "";
	const fetcher = options.fetcher ?? fetch;
	// token 缓存：飞书 token 有效期 2 小时，提前 5 分钟刷新。
	let cached: { value: string; expiresAt: number } | undefined;
	const accessToken = async (): Promise<string> => {
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		const response = await fetcher("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
			signal: AbortSignal.timeout(10_000),
		});
		const payload = (await response.json().catch(() => null)) as
			| { code?: number; tenant_access_token?: string; expire?: number }
			| null;
		if (!payload || payload.code !== 0 || !payload.tenant_access_token)
			throw new Error(`飞书鉴权失败（code ${payload?.code ?? "unknown"}）`);
		cached = {
			value: payload.tenant_access_token,
			expiresAt: Date.now() + Math.max(60, (payload.expire ?? 7200) - 300) * 1000,
		};
		return cached.value;
	};
	return {
		channel: "feishu",
		label: "飞书单聊",
		configured: Boolean(appId && appSecret && receiveId),
		async send(message) {
			if (!appId || !appSecret)
				return { channel: "feishu", label: "飞书单聊", status: "not_configured", detail: "未配置 FEISHU_APP_ID / FEISHU_APP_SECRET" };
			if (!receiveId)
				return { channel: "feishu", label: "飞书单聊", status: "not_configured", detail: "尚未在订阅页确认飞书单聊地址" };
			try {
				const token = await accessToken();
				const response = await postWithRetry(fetcher, "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify({
						receive_id: receiveId,
						msg_type: "interactive",
						content: JSON.stringify(toFeishuInstantCard(message)),
					}),
					signal: AbortSignal.timeout(10_000),
				});
				const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
				if (!response.ok || (payload && typeof payload.code === "number" && payload.code !== 0))
					return {
						channel: "feishu",
						label: "飞书单聊",
						status: "failed",
						detail: `飞书返回 ${payload?.code ?? response.status}：${payload?.msg ?? ""}`,
					};
				return { channel: "feishu", label: "飞书单聊", status: "ok", detail: null };
			} catch (error) {
				return {
					channel: "feishu",
					label: "飞书单聊",
					status: "failed",
					detail: error instanceof Error ? error.message.slice(0, 120) : "飞书请求失败",
				};
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
		case "feishu":
			return "在订阅页完成「确认单聊地址」后即可用；与日汇总共用同一个飞书单聊";
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

/** 渲染器只接受 https 链接（安全约束）；非 https 时不带跳转，而不是让整张卡发不出去。 */
function httpsOnly(url: string | null | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

/** 组装即时推送内容：复用项目已有的 InfoCard 结构，与日汇总卡片同形。 */
export function composeInstantPush(input: {
	events: Array<{
		title: string;
		type?: string | undefined;
		subjectName?: string | undefined;
		eventTime?: string | null | undefined;
		url?: string | undefined;
		publishedAt?: string | null | undefined;
	}>;
	taskCount: number;
	now: Date;
	/** 控制台跳转地址。 */
	consoleUrl?: string;
}): PushMessage {
	const beijing = new Date(input.now.getTime() + 8 * 3_600_000);
	const stamp = `${beijing.getUTCMonth() + 1}月${beijing.getUTCDate()}日 ${String(beijing.getUTCHours()).padStart(2, "0")}:${String(beijing.getUTCMinutes()).padStart(2, "0")}`;
	const titles = input.events.slice(0, 5).filter((event) => Boolean(event.url));

	if (titles.length === 0) {
		// 无事件或无来源链接：不发卡片（validateInfoCard 要求每条有来源，不伪造）。
		return {
			title: "AdPulse 即时推送",
			body: `目前没有可推送的已确认事件（${stamp}）`,
		};
	}

	const card: InfoCard = {
		title: "AdPulse 即时推送",
		intro: `已确认事件 ${input.events.length} 条${input.taskCount > 0 ? `，关联推广任务 ${input.taskCount} 个` : ""}`,
		items: titles.map((event) => {
			const link = httpsOnly(event.url);
			return {
				title: event.title,
				summary: [event.type, event.subjectName, event.eventTime ? `事件时间 ${event.eventTime}` : "事件时间未知"]
					.filter(Boolean)
					.join(" · "),
				relevance: event.subjectName ? `你关注的对象：${event.subjectName}` : "未确定",
				sources: [{ label: event.subjectName ?? "原文", url: event.url!, publishedAt: event.publishedAt ?? null }],
				...(link ? { detailUrl: link } : {}),
			};
		}),
		...(input.events.length > 5 ? { footer: `另有 ${input.events.length - 5} 条未展开` } : {}),
		...(httpsOnly(input.consoleUrl) ? { detailUrl: httpsOnly(input.consoleUrl)! } : {}),
	};

	// 纯文本退给非飞书渠道用；飞书走 card。
	const body = [
		`已确认事件 ${input.events.length} 条：`,
		...titles.map((event) => `· ${event.title}`),
		...(input.events.length > 5 ? [`· 还有 ${input.events.length - 5} 条`] : []),
		`（手动触发 ${stamp}，不是定时汇总）`,
	].join("\n");
	return { title: "AdPulse 即时推送", body, ...(input.consoleUrl ? { url: input.consoleUrl } : {}), card };
}

export type { Storage };
