import { AuthenticationService } from "@adpluse/core";
import { agentReachReadFallback, createSourceService, fromEnvironment, runDiscoveryLeads, runRealTimePushLoop, runSources, runUserSources, runWorker, UserSiteFetcher } from "@adpluse/runtime";
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
// 受限来源采集（#41/#39）：默认关闭；SOURCES_ENABLED=1 时才在 API 进程内按槽位轮询，
// 这样试点不必再单独部署一个 worker 进程。SOURCE_TICK_MS 仅用于测试/演练。
const sourcesLoop =
	process.env.SOURCES_ENABLED === "1"
		? Promise.all([
				runSources(createSourceService(runtime.storage), controller.signal, {
					...(process.env.SOURCE_TICK_MS ? { tickMs: Number(process.env.SOURCE_TICK_MS) } : {}),
				}),
				// 用户自加站点与内置来源共用槽位；各自独立锁定，互不阻塞。
				runUserSources(runtime.storage, controller.signal, {
					...(process.env.SOURCE_TICK_MS ? { tickMs: Number(process.env.SOURCE_TICK_MS) } : {}),
					...(process.env.AGENT_REACH_BIN ? { readFallback: agentReachReadFallback(process.env.AGENT_REACH_BIN) } : {}),
					fetcherFor: (host: string) => new UserSiteFetcher([host]),
					discoverSites: runtime.discoverAlternates,
					// 便宜的站内搜索优先于换站（一次额度 vs 两次）。
					searchFallback: runtime.searchUserSource,
				}),
			])
		: Promise.resolve();
// 实时推送：设置里开了「实时推送」的用户，新确认事件立即推到手机；与日汇总平行。
const realTimePushLoop = runRealTimePushLoop(runtime.storage, controller.signal, {
	env: process.env,
	...(process.env.REALTIME_PUSH_TICK_MS ? { tickMs: Number(process.env.REALTIME_PUSH_TICK_MS) } : {}),
});
// 定时发现（#222）：每天 08:00 对每个已登记企业官网跑一轮站内索引搜索，
// 新结果进未核验线索并自动排初判 job；默认关闭，DISCOVERY_SCHEDULE_ENABLED=1 才启用。
const discoveryLoop =
	process.env.DISCOVERY_SCHEDULE_ENABLED === "1"
		? runDiscoveryLeads(runtime.storage, controller.signal, {
				enabled: true,
				...(process.env.SOURCE_TICK_MS ? { tickMs: Number(process.env.SOURCE_TICK_MS) } : {}),
				search: runtime.searchUserSource,
			})
		: Promise.resolve();
let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	controller.abort();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await Promise.all([loop, sourcesLoop, realTimePushLoop, discoveryLoop]);
	await runtime.close();
}
process.on("SIGTERM", () => {
	void stop();
});
process.on("SIGINT", () => {
	void stop();
});
