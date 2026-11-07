import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStorage } from "../packages/storage/dist/memory.js";
import { isPublicAddress } from "../packages/runtime/dist/index.js";
import {
	SOURCE_DEFINITIONS,
	SourceFetchError,
	SourceService,
	contentHash,
	isWithinItemBounds,
	normalizeItemUrl,
	parseListPage,
	parseRobots,
	robotsAllows,
	shanghaiDay,
	type FetchedResource,
	type SourceFetcher,
} from "../packages/core/dist/index.js";

const NOW = "2026-11-07T04:00:00.000Z";
const weichai = SOURCE_DEFINITIONS.weichai_news;
const haier = SOURCE_DEFINITIONS.haier_news;
if (!weichai || !haier) throw new Error("source definitions missing");

const WEICHAI_LIST = `<div class="media-list">
	<a href="/group/weichai/cn/media-hub/news2/important-news/2026110421125786644/index.html">
		潍柴集团与中国电建水电十局签署战略合作协议
	</a>
	<span class="date">2026-11-04</span>
	<a href="/group/weichai/cn/media-hub/news2/important-news/2026110421125743322/index.html">双星闪耀 潍柴斩获十佳商用车动力系统</a>
	<span class="date">2026-11-04</span>
	<a href="/group/weichai/cn/media-hub/news2/important-news/2026110408281575480/index.html">山东重工集团举办2026年投资者开放日</a>
	<span class="date">2026-11-03</span>
	<a href="/group/weichai/cn/about/">关于我们</a>
</div>`;

const HAIER_LIST = `<ul class="news-list">
	<li>
		<a href="/about_haier/xinwen/20261106_296220.shtml"><img src="cover.png" alt="" /></a>
		<a href="/about_haier/xinwen/20261106_296220.shtml">全部上榜 海尔智家获数智化转型创新成果奖</a>
		<p class="aidesc">内容由AI智能生成</p>
		<span class="date">2026-11-05</span>
	</li>
	<li>
		<a href="/about_haier/xinwen/20261105_296192.shtml">海尔厨电麦浪套系上新</a>
		<span class="date">2026-11-03</span>
	</li>
	<li>
		<a href="/about_haier/xinwen/20261105_296191.shtml">海尔智家完成对法罗力东南亚股权收购</a>
		<span class="date">2026-11-03</span>
	</li>
	<li>
		<a href="/about_haier/xinwen/20261013_295502.shtml">内容由AI智能生成</a>
		<span class="date">2026-10-13</span>
	</li>
</ul>`;

class FakeFetcher implements SourceFetcher {
	calls: string[] = [];
	private pages: Record<string, FetchedResource | Error>;
	constructor(pages: Record<string, FetchedResource | Error>) {
		this.pages = pages;
	}
	async fetchText(url: string): Promise<FetchedResource> {
		this.calls.push(url);
		const page = this.pages[url];
		if (page instanceof Error) throw page;
		if (!page) return { status: 404, bytes: 0, body: "" };
		return page;
	}
}

const listOf = (body: string): FetchedResource => ({
	status: 200,
	bytes: body.length,
	body,
});

const service = (storage: MemoryStorage, fetcher: SourceFetcher) =>
	new SourceService(storage, fetcher, { enabled: true });

test("normalizeItemUrl drops query and fragment and rejects foreign hosts", () => {
	assert.equal(
		normalizeItemUrl(
			"/group/weichai/cn/media-hub/news2/important-news/2026110421125786644/index.html?utm_source=x#top",
			weichai.listUrl,
			weichai.allowedHosts,
		),
		"https://www.weichai.com/group/weichai/cn/media-hub/news2/important-news/2026110421125786644/index.html",
	);
	assert.equal(
		normalizeItemUrl("https://evil.example/x", weichai.listUrl, weichai.allowedHosts),
		null,
	);
	assert.equal(
		normalizeItemUrl("javascript:alert(1)", weichai.listUrl, weichai.allowedHosts),
		null,
	);
});

test("parseListPage extracts titles and list dates only", () => {
	const items = parseListPage(weichai, WEICHAI_LIST, NOW);
	assert.equal(items.length, 3);
	assert.deepEqual(
		items.map((item) => item.title),
		[
			"潍柴集团与中国电建水电十局签署战略合作协议",
			"双星闪耀 潍柴斩获十佳商用车动力系统",
			"山东重工集团举办2026年投资者开放日",
		],
	);
	// List date 2026-11-04 at Asia/Shanghai midnight, not the URL timestamp.
	assert.equal(items[0]?.publishedAt, "2026-11-03T16:00:00.000Z");
});

test("parseListPage skips image-only anchors and AI summary text", () => {
	const items = parseListPage(haier, HAIER_LIST, NOW);
	assert.deepEqual(
		items.map((item) => item.title),
		[
			"全部上榜 海尔智家获数智化转型创新成果奖",
			"海尔厨电麦浪套系上新",
			"海尔智家完成对法罗力东南亚股权收购",
		],
	);
	assert.ok(items.every((item) => !item.title.includes("AI")));
	assert.equal(items.length, 3);
	assert.ok(isWithinItemBounds(haier, items.length));
});

test("repeated URLs with different queries collapse into one item", () => {
	const html = `${HAIER_LIST}
		<a href="/about_haier/xinwen/20261105_296192.shtml?from=home">海尔厨电麦浪套系上新</a>
		<span>2026-11-03</span>`;
	assert.equal(parseListPage(haier, html, NOW).length, 3);
});

test("missing or future dates stay unknown", () => {
	const html = `<a href="/about_haier/xinwen/20261109_1.shtml">未来日期的稿件</a>
		<span>2027-01-01</span>
		<a href="/about_haier/xinwen/20261109_2.shtml">没有日期的稿件</a>`;
	const items = parseListPage(haier, html, NOW);
	assert.equal(items[0]?.publishedAt, null);
	assert.equal(items[1]?.publishedAt, null);
});

test("robots rules honour longest match and Allow priority", () => {
	const rules = parseRobots(
		[
			"User-agent: GPTBot",
			"Disallow: /",
			"",
			"User-agent: *",
			"Disallow: /about_haier/",
			"Allow: /about_haier/xinwen/",
			"Crawl-delay: 2",
		].join("\n"),
	);
	assert.equal(robotsAllows(rules, "/about_haier/xinwen/"), true);
	assert.equal(robotsAllows(rules, "/about_haier/other/"), false);
	assert.equal(rules.crawlDelayMs, 2000);
});

test("collection is disabled unless explicitly enabled", async () => {
	const storage = new MemoryStorage();
	const disabled = new SourceService(storage, new FakeFetcher({}), {
		enabled: false,
	});
	await assert.rejects(() => disabled.sync("weichai_news", NOW), /disabled/);
});

test("a successful run stores metadata, snapshots and a complete run", async () => {
	const storage = new MemoryStorage();
	const fetcher = new FakeFetcher({
		"https://www.weichai.com/robots.txt": { status: 404, bytes: 0, body: "" },
		[weichai.listUrl]: listOf(WEICHAI_LIST),
	});
	const result = await service(storage, fetcher).sync("weichai_news", NOW);
	assert.equal(result.outcome, "ok");
	assert.equal(result.created, 3);
	const items = await service(storage, fetcher).listItems("weichai_news");
	assert.equal(items.length, 3);
	assert.ok(items.every((item) => item.contentScope === "title_link_only"));
	const snapshot = await storage.transaction(async (tx) =>
		(await tx.sourceSnapshots.all()).length,
	);
	assert.equal(snapshot, 3);
	const runs = await storage.transaction(async (tx) => tx.sourceRuns.all());
	assert.equal(runs[0]?.snapshotComplete, true);
	assert.equal(runs[0]?.robotsState, "absent");
});

test("a failed parse never mutates existing items", async () => {
	const storage = new MemoryStorage();
	const good = new FakeFetcher({
		"https://www.weichai.com/robots.txt": { status: 404, bytes: 0, body: "" },
		[weichai.listUrl]: listOf(WEICHAI_LIST),
	});
	await service(storage, good).sync("weichai_news", NOW);

	const broken = new FakeFetcher({
		"https://www.weichai.com/robots.txt": { status: 200, bytes: 10, body: "" },
		[weichai.listUrl]: listOf("<div>redesigned layout</div>"),
	});
	const result = await service(storage, broken).sync(
		"weichai_news",
		"2026-11-07T05:00:00.000Z",
	);
	assert.equal(result.outcome, "parse_failed");
	const items = await service(storage, broken).listItems("weichai_news");
	assert.equal(items.length, 3);
	assert.ok(items.every((item) => item.status === "active"));
});

test("403 stops the source without touching items", async () => {
	const storage = new MemoryStorage();
	const fetcher = new FakeFetcher({
		"https://www.haier.com/robots.txt": { status: 404, bytes: 0, body: "" },
		[haier.listUrl]: { status: 403, bytes: 0, body: "" },
	});
	const result = await service(storage, fetcher).sync("haier_news", NOW);
	assert.equal(result.outcome, "stopped");
	assert.match(result.reason ?? "", /403/);
});

test("a transport failure is recorded without inventing items", async () => {
	const storage = new MemoryStorage();
	const fetcher = new FakeFetcher({
		"https://www.haier.com/robots.txt": { status: 404, bytes: 0, body: "" },
		[haier.listUrl]: new SourceFetchError("too_large", "response exceeds limit"),
	});
	const result = await service(storage, fetcher).sync("haier_news", NOW);
	assert.equal(result.outcome, "http_error");
	assert.match(result.reason ?? "", /too_large/);
	assert.equal((await service(storage, fetcher).listItems("haier_news")).length, 0);
});

test("robots disallow stops before the list page is requested", async () => {
	const storage = new MemoryStorage();
	const fetcher = new FakeFetcher({
		"https://www.weichai.com/robots.txt": {
			status: 200,
			bytes: 20,
			body: "User-agent: *\nDisallow: /group/",
		},
		[weichai.listUrl]: listOf(WEICHAI_LIST),
	});
	const result = await service(storage, fetcher).sync("weichai_news", NOW);
	assert.equal(result.outcome, "stopped");
	assert.equal(fetcher.calls.length, 1);
});

test("daily quota blocks further runs", async () => {
	const storage = new MemoryStorage();
	const fetcher = new FakeFetcher({
		"https://www.weichai.com/robots.txt": { status: 404, bytes: 0, body: "" },
		[weichai.listUrl]: listOf(WEICHAI_LIST),
	});
	const svc = service(storage, fetcher);
	// 6 requests/day = 5 list runs + 1 robots.txt fetch.
	for (let index = 0; index < 5; index++) {
		const stamp = `2026-11-07T0${index}:00:00.000Z`;
		assert.equal((await svc.sync("weichai_news", stamp)).outcome, "ok");
	}
	const blocked = await svc.sync("weichai_news", "2026-11-07T07:00:00.000Z");
	assert.equal(blocked.outcome, "blocked");
	assert.match(blocked.reason ?? "", /quota/);
});

test("purge clears content and blocks re-ingestion", async () => {
	const storage = new MemoryStorage();
	const fetcher = new FakeFetcher({
		"https://www.weichai.com/robots.txt": { status: 404, bytes: 0, body: "" },
		[weichai.listUrl]: listOf(WEICHAI_LIST),
	});
	const svc = service(storage, fetcher);
	await svc.sync("weichai_news", NOW);
	const purged = await svc.purge("weichai_news", NOW);
	assert.equal(purged, 3);
	const afterPurge = await svc.listItems("weichai_news");
	assert.ok(afterPurge.every((item) => item.status === "purged" && item.title === ""));
	assert.equal(SourceService.visible(afterPurge).length, 0);

	const again = await svc.sync("weichai_news", "2026-11-07T05:00:00.000Z");
	assert.equal(again.skippedPurged, 3);
	assert.equal(again.created, 0);
	assert.equal(SourceService.visible(await svc.listItems("weichai_news")).length, 0);
});

test("title corrections are timestamped and counted separately", async () => {
	const storage = new MemoryStorage();
	const first = new FakeFetcher({
		"https://www.weichai.com/robots.txt": { status: 404, bytes: 0, body: "" },
		[weichai.listUrl]: listOf(WEICHAI_LIST),
	});
	await service(storage, first).sync("weichai_news", NOW);
	const corrected = WEICHAI_LIST.replace(
		"双星闪耀 潍柴斩获十佳商用车动力系统",
		"双星闪耀 潍柴斩获十佳商用车动力系统（更正）",
	);
	const second = new FakeFetcher({
		"https://www.weichai.com/robots.txt": { status: 200, bytes: 10, body: "" },
		[weichai.listUrl]: listOf(corrected),
	});
	await service(storage, second).sync("weichai_news", "2026-11-07T05:00:00.000Z");
	const items = await service(storage, second).listItems("weichai_news");
	const changed = items.find((item) => item.title.endsWith("（更正）"));
	assert.equal(changed?.titleUpdatedAt, "2026-11-07T05:00:00.000Z");
	const untouched = items.find((item) => !item.title.endsWith("（更正）"));
	assert.equal(untouched?.titleUpdatedAt, null);
});

test("concurrent runs on one source are skipped, not duplicated", async () => {
	const storage = new MemoryStorage();
	const fetcher = new FakeFetcher({
		"https://www.weichai.com/robots.txt": { status: 404, bytes: 0, body: "" },
		[weichai.listUrl]: listOf(WEICHAI_LIST),
	});
	const svc = service(storage, fetcher);
	const [first, second] = await Promise.all([
		svc.sync("weichai_news", NOW),
		svc.sync("weichai_news", NOW),
	]);
	assert.equal([first.outcome, second.outcome].filter((item) => item === "skipped").length, 1);
});

test("content hash is stable and excludes body text", () => {
	const items = parseListPage(weichai, WEICHAI_LIST, NOW);
	const first = items[0];
	assert.ok(first);
	assert.equal(contentHash(first), contentHash({ ...first, title: first.title }));
	assert.notEqual(contentHash(first), contentHash({ ...first, title: "其他" }));
});

test("shanghaiDay follows the Beijing calendar", () => {
	assert.equal(shanghaiDay("2026-11-07T15:59:00.000Z"), "2026-11-07");
	assert.equal(shanghaiDay("2026-11-07T16:01:00.000Z"), "2026-11-08");
});

test("SSRF guard rejects loopback, private, CGNAT and metadata ranges", () => {
	for (const address of [
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.9",
		"192.168.1.1",
		"169.254.169.254",
		"100.100.100.200",
		"0.0.0.0",
		"::1",
		"fe80::1",
		"fd00::1",
		"::ffff:10.0.0.1",
	])
		assert.equal(isPublicAddress(address), false, address);
	assert.equal(isPublicAddress("8.8.8.8"), true);
	assert.equal(isPublicAddress("2400:3200::1"), true);
});
