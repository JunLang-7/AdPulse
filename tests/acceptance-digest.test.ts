import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStorage } from "../packages/storage/dist/index.js";
import {
	SYNTHETIC_LOGICAL_KEY,
	TEST_MARKER,
	UsageError,
	enqueueSynthetic,
	formatRecords,
	parseArgs,
	readRecords,
	redactId,
	resolveOwnerId,
	syntheticItemInput,
} from "../scripts/acceptance/digest.mjs";
import { mask } from "../scripts/acceptance/redact.mjs";

const settings = (userId: string, overrides: Record<string, unknown> = {}) => ({
	id: userId,
	userId,
	version: 3,
	proactiveEnabled: true,
	schedule: {
		timezone: "Asia/Shanghai",
		digestAt: "09:30",
		quietStart: "22:00",
		quietEnd: "08:00",
	},
	updatedAt: "2026-11-13T00:00:00.000Z",
	...overrides,
});

const seedUser = async (
	storage: MemoryStorage,
	options: { userId: string; openId?: string; enabled?: boolean },
) => {
	await storage.transaction(async (tx) => {
		await tx.users.put({
			id: options.userId,
			status: "active",
			createdAt: "2026-11-13T00:00:00.000Z",
		});
		await tx.subscriptionSettings.put(
			settings(options.userId, {
				proactiveEnabled: options.enabled ?? true,
			}) as never,
		);
		if (options.openId)
			await tx.identityBindings.put({
				id: `binding-${options.userId}`,
				platform: "feishu",
				applicationId: "cli_test",
				tenantId: "tenant-a",
				idType: "open_id",
				externalId: options.openId,
				userId: options.userId,
				status: "active",
				verifiedAt: "2026-11-13T00:00:00.000Z",
			});
	});
};

test("验收工具: 参数必须显式、写入合成数据要额外确认", () => {
	assert.throws(() => parseArgs([]), UsageError, "缺少命令必须报错");
	assert.throws(
		() => parseArgs(["enqueue", "--owner-id", "u1"]),
		/--confirm-synthetic/,
		"没有确认不许写合成数据",
	);
	assert.throws(
		() => parseArgs(["status", "--revision", "0"]),
		/--revision/,
	);
	assert.throws(
		() => parseArgs(["status", "--owner-id", "u1", "--open-id", "ou_x"]),
		/只能给一个/,
	);
	assert.throws(() => parseArgs(["status", "--nope"]), /未知选项/);

	const parsed = parseArgs([
		"enqueue",
		"--owner-id",
		"u1",
		"--revision",
		"2",
		"--title",
		"成本变化",
		"--confirm-synthetic",
	]);
	assert.equal(parsed.command, "enqueue");
	assert.equal(parsed.ownerId, "u1");
	assert.equal(parsed.revision, 2);
	assert.equal(parsed.title, "成本变化");
	assert.equal(parsed.confirmSynthetic, true);
});

test("验收工具: 合成条目固定标记与逻辑键，按 revision 幂等", async () => {
	const first = syntheticItemInput();
	assert.ok(first.title.startsWith(TEST_MARKER), "标题必须带测试标记");
	assert.ok(first.summary.includes(TEST_MARKER));
	assert.ok(first.relevance.includes(TEST_MARKER));
	assert.equal(first.logicalKey, SYNTHETIC_LOGICAL_KEY, "逻辑键固定，重复执行只更新一行");
	assert.equal(first.revision, 1);
	assert.deepEqual(syntheticItemInput({ revision: 3 }).revision, 3);
	// 已经带标记的标题不会重复加。
	assert.equal(
		syntheticItemInput({ title: `${TEST_MARKER}已标记` }).title,
		`${TEST_MARKER}已标记`,
	);
	assert.throws(() => syntheticItemInput({ title: "  " }), UsageError);
});

test("验收工具: 按 open_id 反查用户，歧义或缺失时明确失败", async () => {
	const storage = new MemoryStorage();
	await seedUser(storage, { userId: "user-a", openId: "ou_owner" });
	assert.equal(await resolveOwnerId(storage, { openId: "ou_owner" }), "user-a");
	assert.equal(await resolveOwnerId(storage, { ownerId: "user-a" }), "user-a");
	await assert.rejects(
		() => resolveOwnerId(storage, { openId: "ou_missing" }),
		/没有有效的身份绑定/,
	);
	await assert.rejects(() => resolveOwnerId(storage, {}), /需要 --owner-id 或 --open-id/);
	await assert.rejects(
		() => resolveOwnerId(storage, { ownerId: "user-missing" }),
		/不存在或已停用/,
	);
});

test("验收工具: 关闭推送时拒绝写入，开启后写入并透出批次状态", async () => {
	const storage = new MemoryStorage();
	await seedUser(storage, { userId: "user-off", enabled: false });
	await assert.rejects(
		() => enqueueSynthetic(storage, "user-off"),
		/未开启主动提醒/,
	);

	await seedUser(storage, { userId: "user-on" });
	const first = await enqueueSynthetic(storage, "user-on");
	assert.equal(first.result.outcome, "queued");
	assert.equal(first.result.item?.status, "queued");
	assert.equal(first.settingsVersion, 3, "批次使用写入时的订阅配置版本");
	assert.equal(first.result.item?.title, `${TEST_MARKER}成本波动示例`);

	const again = await enqueueSynthetic(storage, "user-on");
	assert.equal(again.result.outcome, "duplicate", "同一 revision 不重复排队");
	assert.equal(again.result.item?.id, first.result.item?.id);

	const rev2 = await enqueueSynthetic(storage, "user-on", { revision: 2 });
	assert.equal(rev2.result.outcome, "queued");
	assert.equal(rev2.result.item?.revision, 2);

	const page = await readRecords(storage, "user-on");
	assert.equal(page.records.length, 1);
	assert.equal(page.records[0]?.itemsSource, "rows");
	assert.equal(page.records[0]?.items[0]?.revision, 2);
});

test("验收工具: 人类可读摘要带标记与投递状态，便于粘贴进记录", () => {
	const page = {
		records: [
			{
				id: "digest:user-on:2026-11-13",
				kind: "digest",
				localDate: "2026-11-13",
				status: "sent",
				scheduledAt: "2026-11-13T01:30:00.000Z",
				sentAt: "2026-11-13T01:30:42.000Z",
				catchUp: true,
				settingsVersion: 3,
				createdAt: "2026-11-13T01:10:00.000Z",
				updatedAt: "2026-11-13T01:30:42.000Z",
				itemsSource: "delivery",
				items: [
					{
						title: `${TEST_MARKER}成本波动示例`,
						summary: "合成内容",
						relevance: "合成关注对象",
						sources: [],
					},
				],
				delivery: { status: "sent", sentAt: "2026-11-13T01:30:42.000Z" },
			},
		],
		nextBefore: null,
	};
	const text = formatRecords(
		page as never,
		new Date("2026-11-13T02:00:00.000Z"),
	);
	assert.match(text, /2026-11-13 sent（当日补发）/);
	assert.match(text, /计划到发送 42s/);
	assert.match(text, /条目 1 条（来源 delivery）\s*·\s*投递 sent/);
	assert.match(text, new RegExp(TEST_MARKER));
	assert.match(text, /不代表用户已读/);
	assert.match(formatRecords({ records: [], nextBefore: null } as never), /没有通知记录/);
	// 输出必须脱敏：不给未脱敏的用户 id。
	assert.ok(!text.includes("user-on"));
});

test("验收工具: 脱敏工具独立于其他脚本输出", () => {
	assert.equal(mask("ou_83d5b5566773de744c628f0d2e8dfd49"), "ou_83d***49");
	assert.equal(mask(undefined), "(缺失)");
});

test("验收工具: 批次/条目 id 里的用户段也要脱敏", () => {
	assert.equal(
		redactId("digest:user-acceptance:2026-11-13", "user-acceptance"),
		"digest:user-a***ce:2026-11-13",
	);
	assert.equal(
		redactId("user-acceptance:acceptance|digest", "user-acceptance"),
		"user-a***ce:acceptance|digest",
	);
	// 不含用户段的 id 原样返回，不制造假脱敏。
	assert.equal(redactId("digest:x:2026-11-13", "user-b"), "digest:x:2026-11-13");
	assert.equal(redactId(undefined, "user-b"), undefined);
});
