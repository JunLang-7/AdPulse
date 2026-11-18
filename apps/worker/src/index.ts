import { agentReachReadFallback, createSourceService, fromEnvironment, runSources, runUserSources, runWorker } from "@adpluse/runtime";

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
]);
await runtime.close();
