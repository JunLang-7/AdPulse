// 实时推送的轮询循环：每 30 秒检查一次「开了实时推送」的用户，有新确认事件就推。
// 不放进 worker 的批次调度：实时推送是另一条通道，失败只记日志、不影响日汇总。
import type { Storage } from "@adpluse/core";
import { runRealTimePush } from "./real-time-push.js";

/** 轮询间隔：用户要求 5 秒内到达，3 秒一跳留出调度与网络余量。 */
const TICK_MS = 3_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
		if (signal.aborted) finish();
	});
}

export interface RealTimePushLoopOptions {
	tickMs?: number;
	now?: () => Date;
	env?: Record<string, string | undefined>;
}

/**
 * 常驻循环：只为「订阅设置里开了实时推送」的用户工作。
 * 单用户失败不影响其他用户；没有可送通道时静默跳过（设置项里能看到原因）。
 */
export async function runRealTimePushLoop(
	storage: Storage,
	signal: AbortSignal,
	options: RealTimePushLoopOptions = {},
): Promise<void> {
	const tickMs = options.tickMs ?? TICK_MS;
	const env = options.env ?? process.env;
	while (!signal.aborted) {
		try {
			const settings = await storage.transaction((tx) => tx.subscriptionSettings.all());
			const enabled = settings.filter((row) => row.realTimePush?.enabled);
			for (const row of enabled) {
				if (signal.aborted) break;
				try {
					await storage.runExclusive(`rtpush:${row.userId}`, () =>
						runRealTimePush(row.userId, {
							storage,
							env,
							...(options.now ? { now: options.now } : {}),
							resolveFeishuOpenId: async (userId) => {
								const destinations = await storage.transaction((tx) =>
									tx.notificationDestinations.listByOwner(userId),
								);
								const verified = destinations.find((item) => item.status === "verified");
								return verified ? verified.externalId : null;
							},
						}),
					);
				} catch {
					// 单用户失败只跳过本轮，下轮再试；不打断其他人的推送。
				}
			}
		} catch {
			// 读取设置失败（如数据库抖动）不退出循环。
		}
		await sleep(tickMs, signal);
	}
}
