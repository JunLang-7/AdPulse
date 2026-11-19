import assert from "node:assert/strict";
import test from "node:test";
import {
	barkChannel,
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
	const calls = [];
	const fetcher = (async (url, init) => {
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
