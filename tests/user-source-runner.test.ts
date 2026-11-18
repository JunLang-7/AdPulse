import assert from "node:assert/strict";
import test from "node:test";
import {
	UserSourceService,
	type SourceFetcher,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { runUserSources } from "../packages/runtime/dist/index.js";

const LIST_HTML = `
<html><body>
<a href="/news/2026/1118/a.html">该企业 2026年11月18日 发布年度经营计划</a>
<a href="/news/2026/1117/b.html">该企业举行供应商大会并签署合作协议</a>
</body></html>`;

const fakeFetcher = (): SourceFetcher & { listFetches: number } => {
	let listFetches = 0;
	return {
		get listFetches() {
			return listFetches;
		},
		async fetchText(url: string) {
			if (url.endsWith("/robots.txt")) return { status: 404, bytes: 9, body: "not found" };
			listFetches += 1;
			return { status: 200, bytes: LIST_HTML.length, body: LIST_HTML };
		},
	};
};

test("用户站点调度：同槽位只采一次，下个槽位自动重采；停用站点不采", async () => {
	const storage = new MemoryStorage();
	const service = new UserSourceService(storage);
	const source = await service.add("owner-1", {
		label: "测试企业",
		listUrl: "https://runner-example.com/news",
		subject: { kind: "brand", name: "测试企业" },
	}, "2026-11-18T08:00:00.000Z");

	// now() 从北京时间 09:05 开始：最近槽位是 08:00，lastRefreshAt 为空 → 启动即补采。
	let clock = Date.parse("2026-11-18T01:05:00.000Z");
	const fetcher = fakeFetcher();
	let fetcher2: ReturnType<typeof fakeFetcher> | null = null;
	const controller = new AbortController();
	const loop = runUserSources(storage, controller.signal, {
		tickMs: 30,
		now: () => new Date(clock).toISOString(),
		fetcherFor: (host) => {
			assert.equal(host, "runner-example.com");
			return (fetcher2 ??= fetcher);
		},
	});

	const waitFor = async (check: () => Promise<boolean>, label: string): Promise<void> => {
		for (let attempt = 0; attempt < 250; attempt += 1) {
			if (await check()) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.fail(label);
	};
	try {
		const items = () => storage.transaction(async (tx) =>
			(await tx.sourceItems.all()).filter((row) => row.sourceKey.startsWith("user:")),
		);
		await waitFor(() => items().then((rows) => rows.length === 2), "第一个槽位应采集出 2 条");

		// 同一槽位内推进 30 秒：不重复采集。
		const afterFirst = fetcher2!.listFetches;
		clock += 30_000;
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.equal(fetcher2!.listFetches, afterFirst, "同槽位不重复抓列表页");

		// 推进到下一个槽位（北京时间 12:00 之后）：自动重采，同 URL 只更新。
		clock += 5 * 3_600_000;
		await waitFor(async () => fetcher2!.listFetches > afterFirst, "下个槽位应自动重采");
		const rows = await items();
		assert.equal(rows.length, 2, "重采不新建条目");
	} finally {
		controller.abort();
		await loop;
	}

	// 停用后不再采集：直接改状态模拟人工停用。
	await storage.transaction(async (tx) => {
		const current = await tx.userSources.get(source.id);
		if (current) await tx.userSources.put({ ...current, status: "stopped" });
	});
	const before = fetcher2!.listFetches;
	clock += 6 * 3_600_000;
	const second = runUserSources(storage, controller.signal, {
		tickMs: 30,
		now: () => new Date(clock).toISOString(),
		fetcherFor: () => fetcher2!,
	});
	await new Promise((resolve) => setTimeout(resolve, 150));
	controller.abort();
	await second;
	assert.equal(fetcher2!.listFetches, before, "停用站点不产生任何请求");
});
