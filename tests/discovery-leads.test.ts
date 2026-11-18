import assert from "node:assert/strict";
import test from "node:test";
import {
	DiscoveryLeadError,
	DiscoveryLeadService,
	type DiscoveryLeadInput,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const input = (overrides: Partial<DiscoveryLeadInput> = {}): DiscoveryLeadInput => ({
	sourceKey: "haier_news",
	topic: "products",
	provider: "agent-reach/exa",
	query: "site:www.haier.com 海尔 新品发布",
	subject: { kind: "brand", name: "海尔" },
	candidates: [
		{ title: "海尔发布新一代冰箱", url: "https://www.haier.com/about_haier/xinwen/20260102_123.shtml?tracking=1#top", indexedPublishedAt: "2026-01-02" },
		{ title: "海尔年度品牌活动", url: "https://www.haier.com/about_haier/xinwen/20260103_124.shtml", indexedPublishedAt: null },
	],
	...overrides,
});

test("persist：入库待审核线索，归一化 URL 去重，query/subject 保留", async () => {
	const storage = new MemoryStorage();
	const service = new DiscoveryLeadService(storage);
	const result = await service.persist("owner-1", input(), "2026-01-05T00:00:00.000Z");
	assert.deepEqual(result, { created: 2, skipped: 0 });

	const leads = await service.list("owner-1");
	assert.equal(leads.length, 2);
	assert.ok(leads.every((l) => l.status === "pending" && l.verification === "unverified"));
	const withQuery = leads.find((l) => l.url.includes("tracking=1"))!;
	assert.equal(withQuery.dedupKey, "https://www.haier.com/about_haier/xinwen/20260102_123.shtml");
	assert.equal(withQuery.subject?.name, "海尔");
	assert.equal(withQuery.query, "site:www.haier.com 海尔 新品发布");
});

test("persist：跳过已收集条目与已存在线索，不覆盖不复活", async () => {
	const storage = new MemoryStorage();
	const service = new DiscoveryLeadService(storage);
	await service.persist("owner-1", input(), "2026-01-05T00:00:00.000Z");

	// 已存在线索（重复 URL）应被跳过
	const dup = await service.persist("owner-1", input(), "2026-01-06T00:00:00.000Z");
	assert.deepEqual(dup, { created: 0, skipped: 2 });

	// 已作为 source item 入库的 URL 也应被跳过
	await storage.transaction(async (tx) => {
		await tx.sourceItems.put({
			id: "haier_news:existing", sourceKey: "haier_news",
			itemKey: "https://www.haier.com/about_haier/xinwen/20260102_123.shtml",
			title: "已有条目", itemUrl: "https://www.haier.com/about_haier/xinwen/20260102_123.shtml",
			publishedAt: "2026-01-02", firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z",
			titleUpdatedAt: null, contentScope: "title_link_only", status: "active",
		});
	});
	const afterItem = await service.persist("owner-1", input(), "2026-01-07T00:00:00.000Z");
	assert.deepEqual(afterItem, { created: 0, skipped: 2 });
});

test("accept：生成 source item、修正日期、写审计；重复接受返回 409", async () => {
	const storage = new MemoryStorage();
	const service = new DiscoveryLeadService(storage);
	await service.persist("owner-1", input(), "2026-01-05T00:00:00.000Z");
	const [lead] = await service.list("owner-1", { status: "pending" });

	const accepted = await service.accept("owner-1", lead!.id, {
		operator: "ops@example",
		correctedPublishedAt: "2026-01-01",
	}, "2026-01-06T00:00:00.000Z");
	assert.equal(accepted.status, "accepted");
	assert.equal(accepted.reviewedBy, "ops@example");
	assert.match(accepted.convertedItemId ?? "", /^haier_news:/);

	const item = await storage.transaction((tx) => tx.sourceItems.get(accepted.convertedItemId!));
	assert.equal(item?.title, lead!.title);
	assert.equal(item?.publishedAt, "2026-01-01");
	assert.equal(item?.status, "active");

	await assert.rejects(
		service.accept("owner-1", lead!.id, { operator: "ops@example" }, "2026-01-07T00:00:00.000Z"),
		DiscoveryLeadError,
	);
});

test("reject：记录理由，同 URL 不再重新出现", async () => {
	const storage = new MemoryStorage();
	const service = new DiscoveryLeadService(storage);
	await service.persist("owner-1", input(), "2026-01-05T00:00:00.000Z");
	const [lead] = await service.list("owner-1", { status: "pending" });

	const rejected = await service.reject("owner-1", lead!.id, {
		operator: "ops@example", reason: "非官方发布",
	}, "2026-01-06T00:00:00.000Z");
	assert.equal(rejected.status, "rejected");
	assert.equal(rejected.reviewReason, "非官方发布");

	// 拒绝后的 URL 不再重复入库（整批都被跳过）
	const again = await service.persist("owner-1", input(), "2026-01-07T00:00:00.000Z");
	assert.deepEqual(again, { created: 0, skipped: 2 });
});

test("keep：保留供查后可再次处理；越权/不存在返回 404", async () => {
	const storage = new MemoryStorage();
	const service = new DiscoveryLeadService(storage);
	await service.persist("owner-1", input(), "2026-01-05T00:00:00.000Z");
	const [lead] = await service.list("owner-1", { status: "pending" });

	const kept = await service.keep("owner-1", lead!.id, { operator: "ops@example" }, "2026-01-06T00:00:00.000Z");
	assert.equal(kept.status, "kept");

	const accepted = await service.accept("owner-1", lead!.id, { operator: "ops@example" }, "2026-01-07T00:00:00.000Z");
	assert.equal(accepted.status, "accepted");

	await assert.rejects(
		service.reject("owner-2", lead!.id, { operator: "other" }, "2026-01-08T00:00:00.000Z"),
		(e: DiscoveryLeadError) => e.status === 404,
	);
});
