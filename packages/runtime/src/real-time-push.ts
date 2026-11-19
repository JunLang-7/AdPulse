// 实时推送：设置里开启后，新出现「依据齐备」的事件立即推到飞书单聊。
// 与日汇总并行：日汇总按 schedule.digestAt 发卡片，这里不发卡片、只发文本摘要。
// 去重靠 settings.realTimePush.watermark：只推「watermark 之后新确认」的事件。
import type { Storage } from "@adpluse/core";
import { composeInstantPush, feishuInstantChannel, pushChannelsFromEnvironment } from "./push-channels.js";

export interface RealTimePushResult {
	/** 本次推送的事件数；0 表示没有新事件，不算失败。 */
	eventCount: number;
	sent: number;
	results: Array<{ channel: string; label: string; status: string; detail: string | null }>;
	reason: string | null;
}

export interface RealTimePushDeps {
	storage: Storage;
	/** 取本人已验证的飞书 open_id；没有就不推。 */
	resolveFeishuOpenId: (userId: string) => Promise<string | null>;
	env?: Record<string, string | undefined>;
	now?: () => Date;
	/** 测试/自定用途：直接指定渠道，绕过环境变量组装。 */
	pushChannelsOverride?: Array<import("./push-channels.js").PushChannel>;
}

/**
 * 对单个用户做一次实时推送检查。
 * 返回 eventCount=0 且 reason=null 表示正常无事可推（不是错误）。
 */
export async function runRealTimePush(
	userId: string,
	deps: RealTimePushDeps,
): Promise<RealTimePushResult> {
	const now = deps.now ?? (() => new Date());
	const env = deps.env ?? process.env;
	const at = now().toISOString();

	const settings = await deps.storage.transaction((tx) => tx.subscriptionSettings.get(userId));
	const realTime = settings?.realTimePush;
	if (!realTime?.enabled)
		return { eventCount: 0, sent: 0, results: [], reason: "real_time_push_disabled" };

	const openId = await deps.resolveFeishuOpenId(userId);
	const feishu = feishuInstantChannel({
		appId: env.FEISHU_APP_ID,
		appSecret: env.FEISHU_APP_SECRET,
		receiveId: openId ?? undefined,
	});
	// 目前只走飞书；其他渠道未接入，不参与发送。
	const channels = (deps.pushChannelsOverride ?? [feishu]).filter((channel) => channel.configured);
	if (channels.length === 0)
		return { eventCount: 0, sent: 0, results: [], reason: "no_push_channel_configured" };

	// 只取水位线之后「新确认」的事件：创建时间在水位线之后，且当前版本依据齐备。
	const watermark = realTime.watermark ?? realTime.enabledAt ?? null;
	const events = (await deps.storage.transaction((tx) => tx.marketEventVersions.all()))
		.filter((version) => version.ownerId === userId && version.candidate.status === "evidence_ready")
		.filter((version) => (watermark ? version.createdAt > watermark : true));
	if (events.length === 0)
		return { eventCount: 0, sent: 0, results: [], reason: null };

	const message = composeInstantPush({
		eventTitles: events.map((version) => version.input.title),
		taskCount: new Set(events.flatMap((version) => version.input.taskRefs.map((ref) => ref.taskId))).size,
		now: now(),
	});
	const results = [];
	for (const channel of channels) results.push(await channel.send(message));
	const sent = results.filter((item) => item.status === "ok").length;

	// 只要有渠道成功就推进水位线，避免同一条事件反复打扰；全失败则保留水位线待下次重试。
	// 水位线取「已推送事件的最大 createdAt」而不是当前时刻：事件时间可能晚于 now（时钟偏差/延迟写入）。
	if (sent > 0 && settings) {
		const advanced = events.reduce((max, version) => (version.createdAt > max ? version.createdAt : max), at);
		await deps.storage.transaction(async (tx) => {
			const current = await tx.subscriptionSettings.get(userId);
			if (!current?.realTimePush?.enabled) return;
			const previous = current.realTimePush.watermark ?? "";
			await tx.subscriptionSettings.put({
				...current,
				version: current.version + 1,
				realTimePush: {
					...current.realTimePush,
					watermark: advanced > previous ? advanced : previous,
				},
			});
		});
	}
	return {
		eventCount: events.length,
		sent,
		results,
		reason: sent === 0 ? "all_channels_failed" : null,
	};
}
