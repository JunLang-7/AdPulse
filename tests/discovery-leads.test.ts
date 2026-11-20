import assert from "node:assert/strict";
import test from "node:test";
import {
	DiscoveryLeadError,
	DiscoveryLeadService,
	TaskService,
	type DiscoveryLeadInput,
} from "../packages/core/dist/index.js";
import { taskInput } from "./market-event-fixtures.ts";
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

test("persist：他人私有站点的已采集链接不抑制本人发现；本人自有条目仍去重（PR #223 review）", async () => {
	const storage = new MemoryStorage();
	const service = new DiscoveryLeadService(storage);
	const sharedUrl = "https://www.shared-brand.com/news/2026/first.shtml";

	// 用户 A 已把该链接采进自己的私有站点条目（sourceKey 为 user:*）。
	await storage.transaction(async (tx) => {
		await tx.userSources.put({
			id: "src-a", ownerId: "owner-a", label: "A 的企业", host: "www.shared-brand.com",
			listUrl: "https://www.shared-brand.com/news", subject: { kind: "brand", name: "共享品牌" },
			createdAt: "2026-01-01T00:00:00.000Z", discoveryStartedAt: null, lastRefreshAt: null,
			lastOutcome: null, lastReason: null, status: "active",
		});
		await tx.sourceItems.put({
			id: "user:src-a:1", sourceKey: "user:src-a",
			itemKey: "https://www.shared-brand.com/news/2026/first.shtml",
			title: "A 已采集的条目", itemUrl: "https://www.shared-brand.com/news/2026/first.shtml",
			publishedAt: null, firstSeenAt: "2026-01-02T00:00:00.000Z", lastSeenAt: "2026-01-02T00:00:00.000Z",
			titleUpdatedAt: null, contentScope: "title_link_only", status: "active",
		});
	});

	// 用户 B 独立登记同一官网并首次搜到该链接：应正常入库，不被 A 的私有条目抑制。
	const forB = await service.persist("owner-b", input({
		candidates: [{ title: "B 首次发现", url: sharedUrl, indexedPublishedAt: null }],
	}), "2026-01-05T00:00:00.000Z");
	assert.deepEqual(forB, { created: 1, skipped: 0 });

	// A 自己再发现同一链接：仍被本人的可见条目去重。
	const forA = await service.persist("owner-a", input({
		candidates: [{ title: "A 重复发现", url: sharedUrl, indexedPublishedAt: null }],
	}), "2026-01-06T00:00:00.000Z");
	assert.deepEqual(forA, { created: 0, skipped: 1 });
});

test("persist：每条线索只排一个初判 job，不随任务数放大（PR #223 review）", async () => {
	const storage = new MemoryStorage();
	let seq = 0;
	const tasks = new TaskService(storage, () => "2026-01-05T00:00:00.000Z", () => `task-${++seq}`);
	await tasks.create("owner-1", "task-create", taskInput);
	await tasks.create("owner-1", "task-create", taskInput);
	const service = new DiscoveryLeadService(storage);

	const result = await service.persist("owner-1", input(), "2026-01-05T00:00:00.000Z");
	assert.equal(result.created, 2);
	const jobs = await storage.transaction(async (tx) =>
		(await tx.jobs.all()).filter((job) => job.task.kind === "prepare_signal_assessments"),
	);
	// 两个活跃任务、两条线索：job 数等于线索数，而不是任务数×线索数。
	assert.equal(jobs.length, 2);
	assert.ok(jobs.every((job) => job.task.kind === "prepare_signal_assessments"));
});

test("persist：本人没有活跃任务时不排初判 job（既有语义保持）", async () => {
	const storage = new MemoryStorage();
	const service = new DiscoveryLeadService(storage);
	const result = await service.persist("owner-no-tasks", input(), "2026-01-05T00:00:00.000Z");
	assert.equal(result.created, 2);
	const jobs = await storage.transaction(async (tx) => (await tx.jobs.all()));
	assert.equal(jobs.filter((job) => job.task.kind === "prepare_signal_assessments").length, 0);
});
