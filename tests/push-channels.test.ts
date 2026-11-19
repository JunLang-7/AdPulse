import assert from "node:assert/strict";
import test from "node:test";
import {
	barkChannel,
	feishuInstantChannel,
	ntfyChannel,
	composeInstantPush,
	pushChannelsFromEnvironment,
	pushChannelGuide,
	wecomChannel,
} from "../packages/runtime/dist/index.js";

const recorder = (options: { status?: number; throws?: boolean } = {}) => {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		if (options.throws) throw new Error("network down");
		return new Response("{}", { status: options.status ?? 200 });
	}) as typeof fetch;
	return { calls, fetcher };
};

test("ntfy：POST {server}/{topic}，标题与跳转放 header，正文为 body", async () => {
	const { calls, fetcher } = recorder();
	const channel = ntfyChannel({ server: "https://ntfy.sh", topic: "adpulse-test", fetcher });
	assert.equal(channel.configured, true);
	const result = await channel.send({ title: "标题", body: "正文", url: "https://example.com/x" });
	assert.deepEqual(result, { channel: "ntfy", label: "ntfy（跨平台）", status: "ok", detail: null });
	assert.equal(calls[0]?.url, "https://ntfy.sh/adpulse-test");
	assert.equal(calls[0]?.init?.method, "POST");
	const headers = calls[0]?.init?.headers as Record<string, string>;
	assert.equal(headers.title, "标题");
	assert.equal(headers.click, "https://example.com/x");
	assert.equal(calls[0]?.init?.body, "正文");
});

test("ntfy：未配 topic 时不发请求，如实报 not_configured", async () => {
	const { calls, fetcher } = recorder();
	const channel = ntfyChannel({ fetcher });
	assert.equal(channel.configured, false);
	const result = await channel.send({ title: "t", body: "b" });
	assert.equal(result.status, "not_configured");
	assert.match(result.detail ?? "", /NTFY_TOPIC/);
	assert.equal(calls.length, 0, "未配置不得发请求");
});

test("Bark：POST {server}/push，JSON 含 device_key/title/body/group", async () => {
	const { calls, fetcher } = recorder();
	const channel = barkChannel({ server: "https://api.day.app", deviceKey: "KEY123", fetcher });
	const result = await channel.send({ title: "标题", body: "正文" });
	assert.equal(result.status, "ok");
	assert.equal(calls[0]?.url, "https://api.day.app/push");
	const payload = JSON.parse(String(calls[0]?.init?.body));
	assert.equal(payload.device_key, "KEY123");
	assert.equal(payload.title, "标题");
	assert.equal(payload.body, "正文");
	assert.equal(payload.group, "AdPulse");
});

test("Bark：4xx 如实报失败（不伪装成功），提示检查密钥", async () => {
	const { fetcher } = recorder({ status: 400 });
	const channel = barkChannel({ deviceKey: "BAD", fetcher });
	const result = await channel.send({ title: "t", body: "b" });
	assert.equal(result.status, "failed");
	assert.match(result.detail ?? "", /400/);
	assert.match(result.detail ?? "", /BARK_KEY/);
});

test("网络异常：渠道报 failed 并带可读原因", async () => {
	const { fetcher } = recorder({ throws: true });
	const ntfy = await ntfyChannel({ topic: "t", fetcher }).send({ title: "t", body: "b" });
	assert.equal(ntfy.status, "failed");
	assert.match(ntfy.detail ?? "", /网络不可达|超时/);
	const bark = await barkChannel({ deviceKey: "k", fetcher }).send({ title: "t", body: "b" });
	assert.equal(bark.status, "failed");
});

test("环境变量组装：国内渠道在前，未配置的也列出（便于界面提示）", () => {
	const channels = pushChannelsFromEnvironment({ NTFY_TOPIC: "topic-a", WECOM_WEBHOOK: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x" });
	assert.deepEqual(channels.map((c) => c.channel), ["wecom", "dingtalk", "ntfy", "bark"]);
	assert.equal(channels[0]?.configured, true, "企微已配且优先");
	assert.equal(channels[1]?.configured, false, "钉钉未配");
	assert.equal(channels[2]?.configured, true, "ntfy 已配");
	assert.equal(channels[3]?.configured, false, "Bark 未配");
	assert.match(pushChannelGuide("wecom"), /WECOM_WEBHOOK/);
	assert.match(pushChannelGuide("dingtalk"), /DINGTALK_WEBHOOK/);
	assert.match(pushChannelGuide("bark"), /BARK_KEY/);
	assert.match(pushChannelGuide("ntfy"), /NTFY_TOPIC/);
});

test("企微：errcode 非 0 时如实报失败（HTTP 200 也可能业务失败）", async () => {
	const fetcher = (async () =>
		new Response(JSON.stringify({ errcode: 45009, errmsg: "api freq out of limit" }), { status: 200 })) as typeof fetch;
	const channel = wecomChannel({ webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x", fetcher });
	const result = await channel.send({ title: "t", body: "b" });
	assert.equal(result.status, "failed");
	assert.match(result.detail ?? "", /45009/);
	assert.match(result.detail ?? "", /freq/);
});

test("企微：markdown 内容包含标题、正文与跳转链接", async () => {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
	}) as typeof fetch;
	const channel = wecomChannel({ webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x", fetcher });
	const result = await channel.send({ title: "即时推送", body: "第一行\n第二行", url: "http://localhost:5174/market-events" });
	assert.equal(result.status, "ok");
	const payload = JSON.parse(String(calls[0]?.init?.body));
	assert.equal(payload.msgtype, "markdown");
	assert.match(payload.markdown.content, /\*\*即时推送\*\*/);
	assert.match(payload.markdown.content, /第一行/);
	assert.match(payload.markdown.content, /localhost:5174/);
});

test("飞书：未确认单聊地址时不发请求，提示去确认", async () => {
	const { calls, fetcher } = recorder();
	const channel = feishuInstantChannel({ appId: "cli_x", appSecret: "s", receiveId: undefined, fetcher });
	assert.equal(channel.configured, false);
	const result = await channel.send({ title: "t", body: "b" });
	assert.equal(result.status, "not_configured");
	assert.match(result.detail ?? "", /确认飞书单聊地址/);
	assert.equal(calls.length, 0);
});

test("飞书：先取 tenant_access_token，再发 open_id 文本消息", async () => {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		if (String(url).includes("tenant_access_token"))
			return new Response(JSON.stringify({ code: 0, tenant_access_token: "tok-1", expire: 7200 }), { status: 200 });
		return new Response(JSON.stringify({ code: 0, data: { message_id: "om_1" } }), { status: 200 });
	}) as typeof fetch;
	const channel = feishuInstantChannel({ appId: "cli_x", appSecret: "sec", receiveId: "ou_abc", fetcher });
	assert.equal(channel.configured, true);
	const result = await channel.send({ title: "标题", body: "正文", url: "http://localhost:5174/market-events" });	assert.deepEqual(result, { channel: "feishu", label: "飞书单聊", status: "ok", detail: null });
	assert.equal(calls.length, 2, "一次取 token、一次发消息");
	const sendCall = calls[1]!;
	assert.match(sendCall.url, /im\/v1\/messages\?receive_id_type=open_id/);
	const body = JSON.parse(String(sendCall.init?.body));
	assert.equal(body.receive_id, "ou_abc");
	assert.equal(body.msg_type, "interactive", "即时推送要发卡片，不是纯文本");
	const card = JSON.parse(body.content);
	assert.equal(card.header.title.content, "标题");
	assert.equal(card.header.template, "blue");
	assert.match(card.elements[0].text.content, /正文/);
	// 有 url 时补一个跳转按钮，但不带任何决策动作。
	const actionBlock = card.elements.find((element: { tag: string }) => element.tag === "action");
	assert.ok(actionBlock, "带链接时应附跳转按钮");
	assert.equal(actionBlock.actions[0].url, "http://localhost:5174/market-events");
	assert.equal(actionBlock.actions[0].text.content, "在控制台查看");
	assert.equal(JSON.stringify(card).includes("actionRef"), false, "展示卡不应含决策交互");
	const headers = sendCall.init?.headers as Record<string, string>;
	assert.equal(headers.authorization, "Bearer tok-1");
});

test("飞书：token 缓存复用，不每次重复鉴权", async () => {
	let tokenCalls = 0;
	const fetcher = (async (url: string | URL | Request) => {
		if (String(url).includes("tenant_access_token")) {
			tokenCalls += 1;
			return new Response(JSON.stringify({ code: 0, tenant_access_token: "tok", expire: 7200 }), { status: 200 });
		}
		return new Response(JSON.stringify({ code: 0 }), { status: 200 });
	}) as typeof fetch;
	const channel = feishuInstantChannel({ appId: "cli", appSecret: "s", receiveId: "ou_x", fetcher });
	await channel.send({ title: "a", body: "b" });
	await channel.send({ title: "a", body: "b" });
	assert.equal(tokenCalls, 1, "第二次应复用缓存");
});

test("飞书：业务错误码非 0 时如实报失败", async () => {
	const fetcher = (async (url: string | URL | Request) => {
		if (String(url).includes("tenant_access_token"))
			return new Response(JSON.stringify({ code: 0, tenant_access_token: "tok", expire: 7200 }), { status: 200 });
		return new Response(JSON.stringify({ code: 230002, msg: "open_id not exist" }), { status: 200 });
	}) as typeof fetch;
	const channel = feishuInstantChannel({ appId: "cli", appSecret: "s", receiveId: "ou_bad", fetcher });
	const result = await channel.send({ title: "t", body: "b" });
	assert.equal(result.status, "failed");
	assert.match(result.detail ?? "", /230002/);
});

test("飞书：鉴权失败时报失败，不尝试发消息", async () => {
	let sendCalls = 0;
	const fetcher = (async (url: string | URL | Request) => {
		if (String(url).includes("tenant_access_token"))
			return new Response(JSON.stringify({ code: 10014, msg: "app secret invalid" }), { status: 200 });
		sendCalls += 1;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	const channel = feishuInstantChannel({ appId: "cli", appSecret: "bad", receiveId: "ou_x", fetcher });
	const result = await channel.send({ title: "t", body: "b" });
	assert.equal(result.status, "failed");
	assert.match(result.detail ?? "", /10014/);
	assert.equal(sendCalls, 0, "鉴权失败不继续发消息");
});

test("composeInstantPush：无已确认事件时明确说明，不假装有内容", () => {
	const message = composeInstantPush({ eventTitles: [], taskCount: 0, now: new Date("2026-11-19T07:16:00Z") });
	assert.match(message.body, /没有已确认的市场事件/);
	assert.match(message.body, /手动触发 11月19日 15:16/);
	assert.match(message.body, /不是定时汇总/, "要和定时汇总区分开");
});

test("composeInstantPush：列出事件标题并对超出部分计数", () => {
	const titles = Array.from({ length: 7 }, (_, index) => `事件${index + 1}`);
	const message = composeInstantPush({ eventTitles: titles, taskCount: 2, now: new Date() });
	assert.match(message.body, /已确认事件 7 条/);
	assert.match(message.body, /· 事件1/);
	assert.doesNotMatch(message.body, /· 事件6/);
	assert.match(message.body, /还有 2 条/);
	assert.match(message.body, /关联推广任务 2 个/);
});
