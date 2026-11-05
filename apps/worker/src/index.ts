import { fromEnvironment, runWorker } from "@adpluse/runtime";

if (!process.env.DATABASE_URL)
	throw new Error("standalone worker requires shared PostgreSQL storage");
const runtime = await fromEnvironment();
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
await runWorker(runtime.worker, controller.signal);
await runtime.close();
