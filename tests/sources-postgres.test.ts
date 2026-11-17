import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
	SOURCE_DEFINITIONS,
	SourceService,
	type FetchedResource,
	type SourceFetcher,
	SourceLeadService,
} from "../packages/core/dist/index.js";
import { PostgresStorage } from "../packages/storage/dist/index.js";

// #39 要求采集器在 PostgreSQL 上的证据：并发单例、失败不改条目、重试恢复、条目去重与游标。
const skip = !process.env.TEST_DATABASE_URL;
const KEY = "weichai_news";
const definition = SOURCE_DEFINITIONS[KEY]!;

// 与 tests/sources.test.ts 相同的容器形状（采集器对条目容器与路径有断言）。
const listHtml = (titles: string[]): string => `<div class="media-list">${titles
	.map((title, index) => `<a href="/group/weichai/cn/media-hub/news2/important-news/202611042112578664${index}/index.html">${title}</a><span class="date">2026-11-0${index + 1}</span>`)
	.join("")}</div>`;

const ok = (titles: string[]): FetchedResource => {
	const body = listHtml(titles);
	return { status: 200, bytes: body.length, body };
};

class ScriptedFetcher implements SourceFetcher {
	private readonly pages: Array<FetchedResource | Error>;
	constructor(pages: Array<FetchedResource | Error>) {
		this.pages = pages;
	}
	public calls = 0;
	async fetchText(): Promise<FetchedResource> {
		const page = this.pages[Math.min(this.calls, this.pages.length - 1)]!;
		this.calls += 1;
		if (page instanceof Error) throw page;
		return page;
	}
}

/** 一次性 schema：只在本文件内可见，避免与其他 PG 用例互相干扰。 */
async function schemaStorage() {
	const url = process.env.TEST_DATABASE_URL!;
	const { Pool } = createRequire(new URL("../packages/storage/package.json", import.meta.url))("pg") as {
		Pool: new (options: { connectionString: string; options?: string }) => ConstructorParameters<typeof PostgresStorage>[0];
	};
	const schema = `sources_pg_${randomUUID().replaceAll("-", "")}`;
	const admin = new Pool({ connectionString: url }) as unknown as {
		query(sql: string): Promise<unknown>; end(): Promise<void>;
	};
	await admin.query(`CREATE SCHEMA ${schema}`);
	const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
	const storage = new PostgresStorage(pool);
	await storage.initialize();
	return {
		storage,
		async close() {
			await storage.close();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		},
	};
}

test("PostgreSQL 采集：并发 sync 只有一方真正执行，另一方被单例拒绝", { skip }, async () => {
	const db = await schemaStorage();
	try {
		const fetcher = new ScriptedFetcher([ok(["物流集团与港口签署协议", "新品发布会在济南举行", "斩获年度动力系统奖"])]);
		const service = new SourceService(db.storage, fetcher, { enabled: true });
		const at = "2026-11-17T00:00:00.000Z";
		const results = await Promise.all([
			service.sync(KEY, at, { trigger: "manual" }),
			service.sync(KEY, at, { trigger: "manual" }),
		]);
		const ran = results.filter((result) => result.acquired);
		const skipped = results.filter((result) => !result.acquired);
		assert.equal(ran.length, 1, "同一来源同一时刻只允许一次采集");
		assert.equal(skipped.length, 1);
		assert.equal(skipped[0]?.outcome, "skipped");
		assert.equal(skipped[0]?.reason, "another worker holds the source lock");
		const runs = await db.storage.transaction((tx) => tx.sourceRuns.all());
		assert.equal(runs.length, 1, "被拒绝的一方不写运行记录");
		assert.equal(runs[0]?.outcome, "ok");
	} finally {
		await db.close();
	}
});

test("PostgreSQL 采集：失败不改动已有条目，重试后恢复更新", { skip }, async () => {
	const db = await schemaStorage();
	try {
		const at = "2026-11-17T00:00:00.000Z";
		const base = ["物流集团与港口签署战略合作协议", "新品发布会在济南顺利举行", "斩获年度动力系统创新大奖"];
		const first = new SourceService(db.storage, new ScriptedFetcher([ok(base)]), { enabled: true });
		const created = await first.sync(KEY, at, { trigger: "manual" });
		assert.equal(created.outcome, "ok");
		assert.equal(created.created, 3);
		const before = await db.storage.transaction((tx) => tx.sourceItems.all());

		// 抓取失败：不改动任何条目，只记录失败。
		const failing = new SourceService(db.storage, new ScriptedFetcher([new Error("network")]), { enabled: true });
		const failed = await failing.sync(KEY, "2026-11-17T01:00:00.000Z", { trigger: "manual" });
		assert.notEqual(failed.outcome, "ok");
		const afterFailure = await db.storage.transaction((tx) => tx.sourceItems.all());
		assert.deepEqual(afterFailure, before, "失败不得修改条目");

		// 重试成功：新条目入库，旧条目仍在（不重复、不丢失）。
		const retry = new SourceService(db.storage, new ScriptedFetcher([ok([...base, "新增一条产品发布消息"])]), { enabled: true });
		const recovered = await retry.sync(KEY, "2026-11-17T02:00:00.000Z", { trigger: "manual" });
		assert.equal(recovered.outcome, "ok");
		assert.equal(recovered.created, 1, "只新增缺的那条");
		const final = await db.storage.transaction((tx) => tx.sourceItems.all());
		assert.equal(final.length, 4);
		assert.equal(final.filter((row) => row.status === "active").length, 4);
	} finally {
		await db.close();
	}
});

test("PostgreSQL 采集：purged 条目不复活，线索与状态按本人开关返回", { skip }, async () => {
	const db = await schemaStorage();
	try {
		const at = "2026-11-17T00:00:00.000Z";
		const titles = ["即将下架的合作公告内容", "保留的行业观察标题二", "保留的行业观察标题三"];
		const service = new SourceService(db.storage, new ScriptedFetcher([ok(titles)]), { enabled: true });
		await service.sync(KEY, at, { trigger: "manual" });
		const items = await db.storage.transaction((tx) => tx.sourceItems.all());
		assert.equal(items.length, 3);
		await service.purge(KEY, "2026-11-17T01:00:00.000Z");

		// 同一标题再次出现也不得复活（命中即跳过并计数）。
		const again = new SourceService(db.storage, new ScriptedFetcher([ok(titles)]), { enabled: true });
		const result = await again.sync(KEY, "2026-11-17T02:00:00.000Z", { trigger: "manual" });
		assert.equal(result.skippedPurged, 3);
		const after = await db.storage.transaction((tx) => tx.sourceItems.all());
		assert.ok(after.every((row) => row.status === "purged"));

		// 状态接口只返回已开启来源；未开启时为空。
		const leads = new SourceLeadService(db.storage);
		const ownerId = randomUUID();
		assert.deepEqual(await leads.status(ownerId), []);
		assert.deepEqual((await leads.list(ownerId)).leads, []);
	} finally {
		await db.close();
	}
});
