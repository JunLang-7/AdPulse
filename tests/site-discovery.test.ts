import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
	pickCompanySite,
	resolveNewsListPage,
	discoverCompanySite,
} from "../packages/runtime/dist/index.js";
import type { SourceFetcher } from "../packages/core/dist/index.js";

const fakeBin = resolve("agent-reach");

const result = (items: unknown): string =>
	JSON.stringify({ schema_version: 1, ok: true, channel: "web", action: "search", backend: "exa", items });

test("pickCompanySite：排除门户/百科，同 host 新闻 URL 优先，分数排序", () => {
	const pick = pickCompanySite([
		{ title: "某企业_百度百科", url: "https://baike.baidu.com/item/某企业" },
		{ title: "某企业新闻中心", url: "https://www.some-shandong.com/xwzx/list.html" },
		{ title: "某企业 - 首页", url: "https://www.some-shandong.com/" },
		{ title: "某企业报道 - 搜狐", url: "https://www.sohu.com/a/123" },
		{ title: "不合法条目", url: "not-a-url" },
	]);
	assert.ok(pick);
	assert.equal(pick.host, "www.some-shandong.com");
	assert.match(pick.listUrl, /xwzx/);
	assert.equal(pickCompanySite([
		{ title: "只有门户", url: "https://www.zhihu.com/question/1" },
	]), null, "全是门户时返回 null，不猜");
});

test("resolveNewsListPage：站内锚文本含新闻词则跳到列表页；原 URL 已是新闻页则原样", async () => {
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			return {
				status: 200,
				bytes: 100,
				body: `<a href="/about">关于我们</a><a href="/xwzx/list.html">新闻中心</a>`,
			};
		},
	};
	const fromHome = await resolveNewsListPage({ host: "www.some-shandong.com", listUrl: "https://www.some-shandong.com/" }, fetcher);
	assert.equal(fromHome, "https://www.some-shandong.com/xwzx/list.html");
	const direct = await resolveNewsListPage({ host: "www.some-shandong.com", listUrl: "https://www.some-shandong.com/news" }, fetcher);
	assert.equal(direct, "https://www.some-shandong.com/news", "本身已是新闻路径不再二次跳");
});

test("discoverCompanySite：搜索→挑站→定位列表页；没配 AGENT_REACH_BIN 明确报错", async () => {
	await assert.rejects(
		discoverCompanySite("某企业", undefined, {}),
		/AGENT_REACH_BIN/,
	);

	const calls: string[][] = [];
	const runReach = async (_executable: string, args: string[]) => {
		calls.push(args);
		return { stdout: result([
			{ title: "某企业官网首页", url: "https://www.jd-example.com/" },
			{ title: "门户转载", url: "https://www.sohu.com/a/9" },
		]), exitCode: 0 };
	};
	const fetcher: SourceFetcher = {
		async fetchText() {
			return { status: 200, bytes: 50, body: `<a href="/news/index.html">新闻动态</a>` };
		},
	};
	const site = await discoverCompanySite("某 企业", fakeBin, { runReach, fetcher });
	assert.deepEqual(calls[0]?.slice(0, 4), ["web", "search", "某 企业 官网", "--backend"]);
	assert.equal(site.host, "www.jd-example.com");
	assert.equal(site.listUrl, "https://www.jd-example.com/news/index.html");
	assert.match(site.via, /官网首页/);

	const upstream = async () => ({
		stdout: JSON.stringify({ schema_version: 1, ok: false, channel: "web", action: "search", backend: null, items: [], error: { code: "RATE_LIMITED" } }),
		exitCode: 0,
	});
	await assert.rejects(
		discoverCompanySite("某企业", fakeBin, { runReach: upstream }),
		/RATE_LIMITED/,
	);
});
