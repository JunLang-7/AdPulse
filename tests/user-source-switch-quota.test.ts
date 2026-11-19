import assert from "node:assert/strict";
import test from "node:test";
import {
	SourceLeadService,
	UserSourceService,
	type SourceFetcher,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

/**
 * #190：换站回退的两个 P1。
 * 1) 坏站不能每个槽位都换站（换站固定两次搜索，会吃光全站额度）。
 * 2) 换站后旧条目要能区分归属，不能和新站条目混在一起说不清。
 */

function fakeFetcher(map: Record<string, { status: number; body: string }>): SourceFetcher {
	return {
		async fetchText(url: string) {
			const hit = map[url];
			if (!hit) throw new Error(`unexpected fetch: ${url}`);
			return { status: hit.status, bytes: hit.body.length, body: hit.body };
		},
	};
}

const EMPTY_SITE = {
	"https://shop.example.com/robots.txt": { status: 404, body: "not found" },
	"https://shop.example.com/": { status: 200, body: "<html><a href=\"/about\">关于我们</a></html>" },
};

const NEWS_HTML = `<html><body>
<a href="/news/2026-11-18">集团发布年度新品 2026年11月18日</a>
<a href="/news/2026-11-10">集团完成产业升级 2026年11月10日</a>
</body></html>`;

const ALTERNATE_SITE = {
	"https://www.example.com/robots.txt": { status: 404, body: "not found" },
	"https://www.example.com/about/news": { status: 200, body: NEWS_HTML },
};

test("坏站连续失败 3 次后不再换站，成功一次即清零", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "示例集团",
		listUrl: "https://shop.example.com/",
		subject: { kind: "brand", name: "示例集团" },
	}, "2026-11-19T00:00:00.000Z");

	let discoveries = 0;
	const discoverSites = async () => {
		discoveries += 1;
		return [];
	};

	// 前三次：允许换站（每次都会尝试）。
	for (let attempt = 1; attempt <= 3; attempt++) {
		const result = await service.refresh("owner-1", source.id, fakeFetcher(EMPTY_SITE), `2026-11-19T0${attempt}:00:00.000Z`, {
			discoverSites,
			fetcherFor: () => fakeFetcher({}),
		});
		assert.equal(result.outcome, "failed");
		assert.equal(discoveries, attempt, `第 ${attempt} 次仍应尝试换站`);
	}

	// 第四次：连续失败 3 次后暂停换站，并如实说明原因。
	const fourth = await service.refresh("owner-1", source.id, fakeFetcher(EMPTY_SITE), "2026-11-19T04:00:00.000Z", {
		discoverSites,
		fetcherFor: () => fakeFetcher({}),
	});
	assert.equal(fourth.outcome, "failed");
	assert.equal(discoveries, 3, "连续失败达到阈值后不应再消耗搜索额度换站");
	assert.match(fourth.reason ?? "", /暂停自动换站/);

	const [stored] = await service.list("owner-1");
	assert.equal(stored?.failureCount, 4);

	// 退避窗口内仍不换站（同一天再刷也不该再花两次搜索）。
	const stillSuppressed = await service.refresh("owner-1", source.id, fakeFetcher(EMPTY_SITE), "2026-11-19T05:00:00.000Z", {
		discoverSites,
		fetcherFor: () => fakeFetcher({}),
	});
	assert.equal(stillSuppressed.outcome, "failed");
	assert.equal(discoveries, 3, "退避窗口内不应再次消耗搜索额度");

	// 窗口过期（24h 后）允许再试一次：站点修好后要能自动恢复。
	const recovered = await service.refresh("owner-1", source.id, fakeFetcher(EMPTY_SITE), "2026-11-20T06:00:00.000Z", {
		discoverSites: async () => {
			discoveries += 1;
			return [{ host: "www.example.com", listUrl: "https://www.example.com/about/news" }];
		},
		fetcherFor: (host) => host === "www.example.com" ? fakeFetcher(ALTERNATE_SITE) : fakeFetcher({}),
	});
	assert.equal(recovered.outcome, "ok");
	assert.equal(recovered.created, 2);
	const [afterSuccess] = await service.list("owner-1");
	assert.equal(afterSuccess?.failureCount, 0, "成功后失败计数必须清零");
	assert.equal(afterSuccess?.host, "www.example.com");
});

test("换站后条目记下采集站点，旧站条目也保留自己的站点", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "示例集团",
		listUrl: "https://shop.example.com/",
		subject: { kind: "brand", name: "示例集团" },
	}, "2026-11-19T00:00:00.000Z");

	// 先让原站采到 1 条：条目应记上 shop.example.com。
	const oldSite = {
		"https://shop.example.com/robots.txt": { status: 404, body: "not found" },
		"https://shop.example.com/": { status: 200, body:
			"<html><body><a href=\"/news/2026-11-01\">商城站的旧消息 2026年11月1日</a></body></html>" },
	};
	const first = await service.refresh("owner-1", source.id, fakeFetcher(oldSite), "2026-11-19T01:00:00.000Z", {});
	assert.equal(first.outcome, "ok");
	assert.equal(first.created, 1);

	const leads = new SourceLeadService(storage);
	const before = await leads.list("owner-1");
	assert.equal(before.leads.length, 1);
	assert.equal(before.leads[0]?.sourceHost, "shop.example.com");

	// 换站成功：新条目属于新站，旧条目仍在但带着自己的站点，可区分。
	const swapped = await service.refresh("owner-1", source.id, fakeFetcher({}), "2026-11-19T02:00:00.000Z", {
		discoverSites: async () => [{ host: "www.example.com", listUrl: "https://www.example.com/about/news" }],
		fetcherFor: (host) => host === "www.example.com" ? fakeFetcher(ALTERNATE_SITE) : fakeFetcher({}),
	});
	assert.equal(swapped.outcome, "ok");
	assert.equal(swapped.created, 2);

	const after = await leads.list("owner-1");
	assert.equal(after.leads.length, 3, "旧条目保留，不因换站被删除");
	const hosts = new Set(after.leads.map((lead) => lead.sourceHost));
	assert.deepEqual(hosts, new Set(["shop.example.com", "www.example.com"]));
	const [storedSource] = await service.list("owner-1");
	assert.equal(storedSource?.host, "www.example.com");
});

test("采不到时先走站内搜索兜底，命中后不再触发换站", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "示例集团",
		listUrl: "https://shop.example.com/",
		subject: { kind: "brand", name: "示例集团" },
	}, "2026-11-19T00:00:00.000Z");

	let discoveries = 0;
	let searches = 0;
	const result = await service.refresh("owner-1", source.id, fakeFetcher(EMPTY_SITE), "2026-11-19T01:00:00.000Z", {
		searchFallback: async () => {
			searches += 1;
			return [{ title: "集团新闻：发布年度新品", url: "https://shop.example.com/news/2026-11-18" }];
		},
		discoverSites: async () => {
			discoveries += 1;
			return [];
		},
		fetcherFor: () => fakeFetcher({}),
	});
	assert.equal(searches, 1, "应先花一次额度做站内搜索");
	assert.equal(discoveries, 0, "搜索命中后不应再触发两次搜索的换站");
	assert.equal(result.outcome, "ok");
	assert.ok(result.created >= 1);
});
