// 审核验收补充（问题四：主动发现）：覆盖此前未校验的输入边界与刷新频率。
import assert from "node:assert/strict";
import test from "node:test";
import {
	DiscoveryLeadError,
	DiscoveryLeadService,
	UserSourceError,
	UserSourceService,
	type SourceFetcher,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const candidate = (url: string, title = "某集团发布经营数据公告") => ({
	title,
	url,
	indexedPublishedAt: null as string | null,
});

async function leadFixture(now = "2026-11-18T00:00:00.000Z") {
	const storage = new MemoryStorage();
	const service = new DiscoveryLeadService(storage);
	const result = await service.persist("owner-1", {
		sourceKey: "user:source-1",
		topic: "经营动态",
		provider: "agent-reach/xiaohongshu",
		query: "某集团 新闻",
		subject: { kind: "brand", name: "某集团" },
		candidates: [candidate("https://sd-example.com/news/a.html")],
	}, now);
	assert.equal(result.created, 1);
	const [lead] = await service.list("owner-1");
	assert.ok(lead);
	return { storage, service, lead, now };
}

test("接受线索时拒绝不存在的日期（2026-02-30 不能通过日校验）", async () => {
	const { service, lead, now } = await leadFixture();
	await assert.rejects(
		service.accept("owner-1", lead.id, { operator: "owner-1", correctedPublishedAt: "2026-02-30" }, now),
		(error: unknown) => error instanceof DiscoveryLeadError && error.status === 400,
	);
	// 合法日期仍可接受。
	const accepted = await service.accept("owner-1", lead.id, { operator: "owner-1", correctedPublishedAt: "2026-11-18" }, now);
	assert.equal(accepted.status, "accepted");
});

test("暂存线索时丢弃无效的索引日期，不把任意字符串写进条目", async () => {
	const storage = new MemoryStorage();
	const service = new DiscoveryLeadService(storage);
	await service.persist("owner-1", {
		sourceKey: "user:source-1",
		topic: "经营动态",
		provider: "agent-reach/exa",
		query: "q",
		subject: null,
		candidates: [{ title: "某集团发布公告", url: "https://sd-example.com/news/a.html", indexedPublishedAt: "上周三" }],
	}, "2026-11-18T00:00:00.000Z");
	const [lead] = await service.list("owner-1");
	assert.equal(lead?.indexedPublishedAt, null, "非法日期按未知处理，不原样落库");
});

test("同一站点短时间内重复刷新被冷却拦截，避免对第三方站点连打请求", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "山东某集团",
		listUrl: "https://sd-example.com/news",
		subject: { kind: "brand", name: "山东某集团" },
	}, "2026-11-18T00:00:00.000Z");
	const fetcher: SourceFetcher = {
		async fetchText(url: string) {
			if (url.endsWith("/robots.txt")) return { status: 200, bytes: 0, body: "User-agent: *\nAllow: /\n" };
			return { status: 200, bytes: 0, body: "<html><body></body></html>" };
		},
	};
	// 第一次刷新失败（无条目），但仍计入冷却起点。
	await service.refresh("owner-1", source.id, fetcher, "2026-11-18T00:01:00.000Z");
	await assert.rejects(
		service.refresh("owner-1", source.id, fetcher, "2026-11-18T00:02:00.000Z"),
		(error: unknown) => error instanceof UserSourceError && error.status === 429,
	);
	// 冷却结束后允许再次刷新。
	const later = await service.refresh("owner-1", source.id, fetcher, "2026-11-18T00:11:00.000Z");
	assert.equal(later.outcome, "failed");
});
