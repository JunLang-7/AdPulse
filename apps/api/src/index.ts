import { fromEnvironment, runWorker } from "@adpluse/runtime";
import { createApi } from "./server.js";

const token = process.env.CONSOLE_TOKEN ?? "";
if (token.length < 24)
	throw new Error("CONSOLE_TOKEN must be at least 24 characters");
const runtime = await fromEnvironment();
const controller = new AbortController();
const server = createApi(runtime, {
	token,
	userId: process.env.CONSOLE_USER_ID ?? "operator",
});
server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () => {
	console.log(
		"API ready; use a trusted HTTPS reverse proxy for public webhooks",
	);
	if (process.env.DEMO_MODE === "1")
		console.warn(
			"DEMO MODE: memory is non-durable; demo deliveries do not reach an IM",
		);
});
const loop =
	process.env.EMBED_WORKER === "0"
		? Promise.resolve()
		: runWorker(runtime.worker, controller.signal);
let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	controller.abort();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await loop;
	await runtime.close();
}
process.on("SIGTERM", () => {
	void stop();
});
process.on("SIGINT", () => {
	void stop();
});
