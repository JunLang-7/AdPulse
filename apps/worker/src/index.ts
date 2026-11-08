import { createSourceService, fromEnvironment, runSources, runWorker } from "@adpluse/runtime";

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
]);
await runtime.close();
