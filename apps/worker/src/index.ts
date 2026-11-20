import { agentReachReadFallback, createSourceService, fromEnvironment, runDiscoveryLeads, runSources, runUserSources, runWorker } from "@adpluse/runtime";

if (!process.env.DATABASE_URL)
	throw new Error("standalone worker requires shared PostgreSQL storage");
const runtime = await fromEnvironment();
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
const sources = createSourceService(runtime.storage);
await Promise.all([
	runWorker(runtime.worker, controller.signal),
	// Returns immediately when SOURCES_ENABLED is not 1.
	runSources(sources, controller.signal),
	runUserSources(runtime.storage, controller.signal, {
		...(process.env.AGENT_REACH_BIN ? { readFallback: agentReachReadFallback(process.env.AGENT_REACH_BIN) } : {}),
	}),
	// 定时发现（#222）：默认关闭；DISCOVERY_SCHEDULE_ENABLED=1 时每天 08:00 对
	// 已登记企业官网跑一轮站内索引搜索，新结果进未核验线索并自动排初判 job。
	runDiscoveryLeads(runtime.storage, controller.signal, {
		enabled: process.env.DISCOVERY_SCHEDULE_ENABLED === "1",
		search: runtime.searchUserSource,
	}),
]);
await runtime.close();
