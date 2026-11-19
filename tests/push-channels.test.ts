import assert from "node:assert/strict";
import test from "node:test";
import {
	feishuInstantChannel,
	toFeishuInstantCard,
	composeInstantPush,
	pushChannelGuide,
} from "../packages/runtime/dist/index.js";
import type { InfoCard } from "../packages/core/dist/index.js";

/** 一条最小合法 InfoCard：validateInfoCard 要求每条都有来源。 */
const sampleCard = (): InfoCard => ({
	title: "AdPulse 即时推送",
	items: [
		{
			title: "海尔新品发布",
			summary: "产品发布 · 海尔",
			relevance: "你关注的对象：海尔",
			sources: [{ label: "海尔", url: "https://www.haier.com/news/1.shtml", publishedAt: "2026-11-19" }],
		},
	],
});

const message = (overrides: Record<string, unknown> = {}) => ({
	title: "AdPulse 即时推送",
	body: "正文",
	card: sampleCard(),
	...overrides,
});

const feishuFetcher = (options: { sendBody?: unknown; sendStatus?: number; tokenCode?: number } = {}) => {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		if (String(url).includes("tenant_access_token")) {
			const code = options.tokenCode ?? 0;
			return new Response(
				JSON.stringify(code === 0
					? { code: 0, tenant_access_token: "tok-1", expire: 7200 }
					: { code, msg: "app secret invalid" }),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify(options.sendBody ?? { code: 0, data: { message_id: "om_1" } }), {
			status: options.sendStatus ?? 200,
		});
	}) as typeof fetch;
	return { calls, fetcher };
};

test("飞书：未确认单聊地址时不发请求，提示去确认", async () => {
	const { calls, fetcher } = feishuFetcher();
	const channel = feishuInstantChannel({ appId: "cli_x", appSecret: "s", receiveId: undefined, fetcher });
	assert.equal(channel.configured, false);
	const result = await channel.send(message());
	assert.equal(result.status, "not_configured");
	assert.match(result.detail ?? "", /确认飞书单聊地址/);
	assert.equal(calls.length, 0);
});

test("飞书：先取 tenant_access_token，再发 InfoCard 卡片（JSON 2.0）", async () => {
	const { calls, fetcher } = feishuFetcher();
	const channel = feishuInstantChannel({ appId: "cli_x", appSecret: "sec", receiveId: "ou_abc", fetcher });
	assert.equal(channel.configured, true);
	const result = await channel.send(message({ url: "http://localhost:5174/market-events" }));
	assert.deepEqual(result, { channel: "feishu", label: "飞书单聊", status: "ok", detail: null });
	assert.equal(calls.length, 2, "一次取 token、一次发消息");

	const sendCall = calls[1]!;
	assert.match(sendCall.url, /im\/v1\/messages\?receive_id_type=open_id/);
	const body = JSON.parse(String(sendCall.init?.body));
	assert.equal(body.receive_id, "ou_abc");
	assert.equal(body.msg_type, "interactive", "即时推送发卡片");
	const card = JSON.parse(body.content);
	// 与 feishuRenderer.toInfoCard 完全同形
	assert.equal(card.schema, "2.0");
	assert.ok(card.body, "内容在 body.elements，不是顶层 elements");
	assert.equal(card.header.template, "turquoise", "与日汇总汇总卡同配色");
	assert.equal(JSON.stringify(card).includes("actionRef"), false);
	assert.equal(JSON.stringify(card).includes("callback"), false, "展示卡无回调行为");
	const headers = sendCall.init?.headers as Record<string, string>;
	assert.equal(headers.authorization, "Bearer tok-1");
});

test("飞书：token 缓存复用，不每次重复鉴权", async () => {
	const { calls, fetcher } = feishuFetcher();
	const channel = feishuInstantChannel({ appId: "cli", appSecret: "s", receiveId: "ou_x", fetcher });
	await channel.send(message());
	await channel.send(message());
	const tokenCalls = calls.filter((call) => call.url.includes("tenant_access_token")).length;
	assert.equal(tokenCalls, 1, "第二次应复用缓存");
});

test("飞书：业务错误码非 0 时如实报失败", async () => {
	const { fetcher } = feishuFetcher({ sendBody: { code: 230002, msg: "open_id not exist" } });
	const channel = feishuInstantChannel({ appId: "cli", appSecret: "s", receiveId: "ou_bad", fetcher });
	const result = await channel.send(message());
	assert.equal(result.status, "failed");
	assert.match(result.detail ?? "", /230002/);
});

test("飞书：鉴权失败时报失败，不尝试发消息", async () => {
	const { calls, fetcher } = feishuFetcher({ tokenCode: 10014 });
	const channel = feishuInstantChannel({ appId: "cli", appSecret: "bad", receiveId: "ou_x", fetcher });
	const result = await channel.send(message());
	assert.equal(result.status, "failed");
	assert.match(result.detail ?? "", /10014/);
	assert.equal(calls.filter((call) => call.url.includes("/im/v1/messages")).length, 0, "鉴权失败不继续发消息");
});

test("飞书：缺 InfoCard 时拒绝发送，不退回无来源的自由文本", async () => {
	const { calls, fetcher } = feishuFetcher();
	const channel = feishuInstantChannel({ appId: "cli", appSecret: "s", receiveId: "ou_x", fetcher });
	const result = await channel.send({ title: "t", body: "b" });
	assert.equal(result.status, "failed");
	assert.match(result.detail ?? "", /InfoCard/);
	assert.equal(calls.filter((call) => call.url.includes("/im/v1/messages")).length, 0);
});

test("toFeishuInstantCard：直出项目既有 InfoCard 渲染结果", () => {
	const card = toFeishuInstantCard({
		title: "AdPulse 即时推送",
		body: "b",
		card: {
			...sampleCard(),
			intro: "已确认事件 1 条",
			detailUrl: "https://example.com/market-events",
		},
	});
	assert.equal(card.schema, "2.0");
	const body = (card.body as { elements: Array<Record<string, unknown>> }).elements;
	const serialized = JSON.stringify(body);
	assert.match(serialized, /已确认事件 1 条/, "含 intro");
	assert.match(serialized, /海尔新品发布/, "含条目标题");
	assert.match(serialized, /来源：海尔/, "含来源标注（渲染器只显示来源与时间，不展示裸 URL）");
	assert.match(serialized, /管理订阅/, "卡片底部有管理入口");
	assert.equal(JSON.stringify(card).includes("actionRef"), false);
});

test("toFeishuInstantCard：条目无来源时被 validateInfoCard 拦下（证据纪律）", () => {
	const broken: InfoCard = {
		title: "即时推送",
		items: [{ title: "无来源事件", summary: "摘要", relevance: "未确定", sources: [] }],
	};
	assert.throws(() => toFeishuInstantCard({ title: "t", body: "b", card: broken }), /source/);
});

test("composeInstantPush：无可推送事件时不给卡片（不造假内容）", () => {
	const result = composeInstantPush({ events: [], taskCount: 0, now: new Date("2026-11-19T07:16:00Z") });
	assert.equal(result.card, undefined);
	assert.match(result.body, /没有可推送的已确认事件/);
	assert.match(result.body, /11月19日 15:16/);
});

test("composeInstantPush：无原文链接的事件不进卡（卡片要求带来源）", () => {
	const result = composeInstantPush({
		events: [{ title: "没有链接的事件", type: "announcement", subjectName: "海尔" }],
		taskCount: 0,
		now: new Date(),
	});
	assert.equal(result.card, undefined, "没来源就不发卡，不伪造来源");
});

test("composeInstantPush：事件组卡用项目既有 InfoCard 结构", () => {
	const events = Array.from({ length: 7 }, (_, index) => ({
		title: `事件${index + 1}`,
		type: "product_launch",
		subjectName: "海尔",
		eventTime: "2026-11-19",
		url: `https://www.haier.com/news/${index + 1}.shtml`,
		publishedAt: "2026-11-19",
	}));
	const result = composeInstantPush({
		events,
		taskCount: 2,
		now: new Date(),
		consoleUrl: "https://example.com/market-events",
	});
	assert.ok(result.card);
	assert.equal(result.card.items.length, 5, "卡内最多 5 条（与日汇总一致）");
	assert.match(result.card.intro ?? "", /已确认事件 7 条/);
	assert.match(result.card.intro ?? "", /关联推广任务 2 个/);
	assert.match(result.card.footer ?? "", /另有 2 条未展开/);
	const first = result.card.items[0]!;
	assert.match(first.summary, /product_launch/);
	assert.match(first.relevance, /海尔/);
	assert.equal(first.sources[0]?.url, "https://www.haier.com/news/1.shtml");
	assert.equal(result.card.detailUrl, "https://example.com/market-events");
});

test("composeInstantPush：http 链接不带 detailUrl（渲染器只接受 https）", () => {
	const result = composeInstantPush({
		events: [
			{
				title: "http 来源的事件",
				subjectName: "海尔",
				url: "http://www.haier.com/news/1.shtml",
				publishedAt: "2026-11-19",
			},
		],
		taskCount: 0,
		now: new Date(),
		consoleUrl: "http://localhost:5174/market-events",
	});
	assert.ok(result.card, "仍有卡（来源本身可以是 http）");
	assert.equal(result.card.items[0]?.detailUrl, undefined, "非 https 不设跳转，避免渲染器抛错");
	assert.equal(result.card.detailUrl, undefined, "consoleUrl 也要 https 才带");
	// 证明卡片能真的渲染出来（不抛 https 错误）
	assert.equal(toFeishuInstantCard(result).schema, "2.0");
});

test("渠道指引：只保留飞书的说明", () => {
	assert.match(pushChannelGuide("feishu"), /确认单聊地址/);
});
