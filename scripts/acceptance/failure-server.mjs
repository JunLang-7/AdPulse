// 本地故障夹具：只连固定验收库、只监听回环；不提供会话注入，不发送 IM。
import { AuthenticationService } from "../../packages/core/dist/index.js";
import { PostgresStorage } from "../../packages/storage/dist/index.js";
import { runWorker } from "../../packages/runtime/dist/index.js";
import { FeishuIdentityProvider } from "../../apps/api/dist/feishu-auth.js";
import { createApi } from "../../apps/api/dist/server.js";
import { createManagedDocker, pointsAtManagedDb } from "./docker.mjs";
import { createFailureRuntime } from "./failure-runtime.mjs";
import { FAULT_HEADER, FAULT_MARKER } from "./fault-injection.mjs";

const required = (key) => {
	const value = process.env[key]?.trim();
	if (!value) throw new Error(`${key} is required`);
	return value;
};
const databaseUrl = required("DATABASE_URL");
if (!pointsAtManagedDb(databaseUrl)) throw new Error("fault fixture requires 127.0.0.1:5433/adpulse_acceptance");
const config = {
	accountId: process.env.FEISHU_ACCOUNT_ID ?? "feishu-internal",
	appId: required("FEISHU_APP_ID"), appSecret: required("FEISHU_APP_SECRET"),
	tenantKey: required("FEISHU_TENANT_KEY"),
	verificationToken: required("FEISHU_VERIFICATION_TOKEN"), encryptKey: required("FEISHU_ENCRYPT_KEY"),
};
const publicOrigin = required("PUBLIC_ORIGIN");
const docker = createManagedDocker();
const storage = PostgresStorage.connect(databaseUrl);
const controller = new AbortController();
let server;
let loop;
let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	controller.abort();
	if (server?.listening) await new Promise((resolve) => server.close(resolve));
	await loop;
	await storage.close();
	docker.cleanup();
}
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
try {
	docker.ensureDb();
	await docker.waitReady();
	await storage.initialize();
	const runtime = createFailureRuntime(storage, config);
	server = createApi(runtime, {
		service: new AuthenticationService(storage),
		provider: new FeishuIdentityProvider({ applicationId: config.appId, applicationSecret: config.appSecret, tenantId: config.tenantKey }),
		publicOrigin,
	});
	server.prependListener("request", (_req, res) => res.setHeader(FAULT_HEADER, FAULT_MARKER));
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(3301, "127.0.0.1", resolve);
	});
	console.log("Acceptance fault API on 127.0.0.1:3301; outbound always fails locally; real OAuth login required");
	loop = runWorker(runtime.worker, controller.signal);
} catch (error) {
	await stop();
	throw error;
}
