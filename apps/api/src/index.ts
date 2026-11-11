import { AuthenticationService } from "@adpluse/core";
import { fromEnvironment, runWorker } from "@adpluse/runtime";
import { FeishuIdentityProvider } from "./feishu-auth.js";
import { createApi } from "./server.js";

const required = (name: string): string => {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
};
const publicOrigin = required("PUBLIC_ORIGIN");
const applicationId = required("FEISHU_APP_ID");
const applicationSecret = required("FEISHU_APP_SECRET");
const tenantId = required("FEISHU_TENANT_KEY");
const runtime = await fromEnvironment();
const controller = new AbortController();
const server = createApi(runtime, {
	service: new AuthenticationService(runtime.storage),
	provider: new FeishuIdentityProvider({
		applicationId,
		applicationSecret,
		tenantId,
	}),
	publicOrigin,
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
