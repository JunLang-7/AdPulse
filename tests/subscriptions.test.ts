import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
	DEFAULT_SCHEDULE,
	SubscriptionError,
	SubscriptionService,
} from "../packages/core/dist/index.js";
import type {
	SubscriptionSettings,
	Task,
	TaskVersion,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";

const setup = () => {
	const storage = new MemoryStorage();
	let clock = Date.parse("2026-11-10T01:00:00.000Z");
	const service = new SubscriptionService(storage, () =>
		new Date(clock).toISOString(),
	);
	const tick = (ms = 1000) => {
		clock += ms;
		return new Date(clock).toISOString();
	};
	return { storage, service, tick };
};

/** 造一个本人任务，返回任务 id；label 取当前版本 product。 */
const seedTask = async (
	storage: MemoryStorage,
	ownerId: string,
	product: string,
): Promise<string> => {
	const at = new Date().toISOString();
	const task: Task = {
		id: randomUUID(),
		ownerId,
		currentVersion: 1,
		createdAt: at,
	};
	const version: TaskVersion = {
		id: randomUUID(),
		taskId: task.id,
		version: 1,
		product,
		strategy: {
			objective: "leads",
			audience: [],
			channels: {},
			sellingPoints: [],
		},
		observation: {},
		rules: {},
		createdAt: at,
	};
	await storage.transaction(async (tx) => {
		await tx.tasks.put(task);
		await tx.taskVersions.put(version);
	});
	return task.id;
};

test("subscription: 未配置时默认关闭且版本为 0，不伪造可投递", async () => {
	const { service } = setup();
	const view = await service.view("user-a");
	assert.equal(view.settings.version, 0);
	assert.equal(view.settings.proactiveEnabled, false, "首次默认关闭");
	assert.deepEqual(view.settings.schedule, DEFAULT_SCHEDULE);
	assert.equal(view.settings.enabledAt, undefined);
	assert.equal(
		"updatedAt" in view.settings,
		false,
		"从未保存过配置就不返回更新时间（契约里是可缺省的 date-time，不能用空串假冒）",
	);
	assert.deepEqual(view.targets, []);
});

test("subscription: 启用写入版本并记录启用时间，关闭保留地址无关的配置", async () => {
	const { service, tick } = setup();
	const enabled = await service.updateSettings("user-a", {
		expectedVersion: 0,
		proactiveEnabled: true,
	});
	assert.equal(enabled.settings.version, 1);
	assert.equal(enabled.settings.proactiveEnabled, true);
	assert.ok(enabled.settings.enabledAt);
	assert.equal(enabled.settings.disabledAt, undefined);

	tick();
	const disabled = await service.updateSettings("user-a", {
		expectedVersion: 1,
		proactiveEnabled: false,
	});
	assert.equal(disabled.settings.version, 2, "每次写入都推进同一个版本");
	assert.equal(disabled.settings.proactiveEnabled, false);
	assert.ok(disabled.settings.disabledAt);
	assert.equal(disabled.settings.enabledAt, enabled.settings.enabledAt);
});

test("subscription: 旧版本写入被拒，不覆盖后来者", async () => {
	const { service } = setup();
	await service.updateSettings("user-a", {
		expectedVersion: 0,
		proactiveEnabled: true,
	});
	await assert.rejects(
		service.updateSettings("user-a", {
			expectedVersion: 0,
			proactiveEnabled: false,
		}),
		(error: unknown) =>
			error instanceof SubscriptionError &&
			error.reason === "subscription_conflict",
		"旧 expectedVersion 必须 409",
	);
	const view = await service.view("user-a");
	assert.equal(view.settings.proactiveEnabled, true, "后来的启用不能被旧请求撤销");
	assert.equal(view.settings.version, 1);

	await assert.rejects(
		service.updateSettings("user-a", { expectedVersion: 1.5 }),
		(error: unknown) =>
			error instanceof SubscriptionError &&
			error.reason === "subscription_conflict",
	);
	await assert.rejects(
		service.updateSettings("user-a", {} as never),
		(error: unknown) =>
			error instanceof SubscriptionError &&
			error.reason === "subscription_conflict",
		"缺少 expectedVersion 不能当作 0",
	);
});

test("subscription: 时段校验（格式、免打扰跨零点、汇总不得落在免打扰内）", async () => {
	const { service } = setup();
	for (const schedule of [
		{ ...DEFAULT_SCHEDULE, digestAt: "9:30" },
		{ ...DEFAULT_SCHEDULE, quietStart: "24:00" },
		{ ...DEFAULT_SCHEDULE, quietEnd: "22:00" },
		{ ...DEFAULT_SCHEDULE, digestAt: "23:00" },
		{ ...DEFAULT_SCHEDULE, digestAt: "07:59" },
	]) {
		await assert.rejects(
			service.updateSettings("user-a", { expectedVersion: 0, schedule }),
			(error: unknown) =>
				error instanceof SubscriptionError &&
				error.reason === "invalid_schedule",
			`应拒绝 ${JSON.stringify(schedule)}`,
		);
	}
	// 时区必须显式给出且只能是 Asia/Shanghai：不替调用方改写成北京时间。
	for (const timezone of [undefined, "UTC", "asia/shanghai", "Asia/Shanghai "]) {
		await assert.rejects(
			service.updateSettings("user-a", {
				expectedVersion: 0,
				schedule: { ...DEFAULT_SCHEDULE, timezone } as never,
			}),
			(error: unknown) =>
				error instanceof SubscriptionError &&
				error.reason === "invalid_schedule",
			`应拒绝 timezone=${String(timezone)}`,
		);
	}
	// 被拒的写入不推进版本，也不落库。
	const untouched = await service.view("user-a");
	assert.equal(untouched.settings.version, 0);
	assert.equal("updatedAt" in untouched.settings, false);

	// 免打扰 22:00–08:00 跨零点：09:30 合法，07:30 不合法。
	const ok = await service.updateSettings("user-a", {
		expectedVersion: 0,
		schedule: { ...DEFAULT_SCHEDULE, quietStart: "23:00", quietEnd: "06:00" },
	});
	assert.equal(ok.settings.schedule.quietStart, "23:00");
	assert.equal(ok.settings.schedule.timezone, "Asia/Shanghai", "时区固定");
});

test("subscription: 只能关注本人任务，他人任务按不存在处理", async () => {
	const { storage, service } = setup();
	const mine = await seedTask(storage, "user-a", "护眼台灯");
	const other = await seedTask(storage, "user-b", "别人的产品");

	const added = await service.addTarget("user-a", {
		expectedVersion: 0,
		kind: "task",
		refId: mine,
		categories: ["effect", "event"],
		scope: "task_only",
	});
	assert.equal(added.targets.length, 1);
	assert.equal(added.targets[0]?.label, "护眼台灯", "label 取任务当前版本");
	assert.equal(added.settings.version, 1, "关注列表与开关共用版本");

	await assert.rejects(
		service.addTarget("user-a", {
			expectedVersion: 1,
			kind: "task",
			refId: other,
			categories: ["effect"],
			scope: "task_only",
		}),
		(error: unknown) =>
			error instanceof SubscriptionError &&
			error.reason === "target_not_found",
		"他人任务不能关注，且不确认其存在性",
	);
});

test("subscription: 品牌/竞品是本人录入名称，同名重复被拒、不同用户互不影响", async () => {
	const { service } = setup();
	const first = await service.addTarget("user-a", {
		expectedVersion: 0,
		kind: "competitor",
		label: "  某某  灯饰  ",
		sourceUrl: "https://example.com/evidence",
		categories: ["event"],
		scope: "include_general",
	});
	assert.equal(first.targets[0]?.label, "某某  灯饰", "去掉首尾空白");
	assert.equal(first.targets[0]?.kindLabel, "竞品");
	assert.equal(first.targets[0]?.sourceUrl, "https://example.com/evidence");

	await assert.rejects(
		service.addTarget("user-a", {
			expectedVersion: 1,
			kind: "competitor",
			// 大小写与多余空格规范化后同名。
			label: "某某 灯饰",
			categories: ["event"],
			scope: "include_general",
		}),
		(error: unknown) =>
			error instanceof SubscriptionError &&
			error.reason === "duplicate_target",
	);
	// 同名的品牌与竞品是两个对象，不冲突。
	await service.addTarget("user-a", {
		expectedVersion: 1,
		kind: "brand",
		label: "某某 灯饰",
		categories: ["event"],
		scope: "task_only",
	});
	// 其他用户录同名不受影响。
	const otherView = await service.addTarget("user-b", {
		expectedVersion: 0,
		kind: "competitor",
		label: "某某 灯饰",
		categories: ["event"],
		scope: "task_only",
	});
	assert.equal(otherView.targets.length, 1);
});

test("subscription: 输入校验（类别、范围、名称、来源链接）", async () => {
	const { storage, service } = setup();
	const task = await seedTask(storage, "user-a", "护眼台灯");
	const bad = [
		{ categories: [], scope: "task_only" },
		{ categories: ["unknown"], scope: "task_only" },
		{ categories: ["effect"], scope: "everywhere" },
	];
	for (const [index, item] of bad.entries()) {
		await assert.rejects(
			service.addTarget("user-a", {
				expectedVersion: 0,
				kind: "task",
				refId: task,
				...item,
			} as never),
			(error: unknown) =>
				error instanceof SubscriptionError &&
				error.reason === "invalid_target",
			`应拒绝第 ${index} 组`,
		);
	}
	await assert.rejects(
		service.addTarget("user-a", {
			expectedVersion: 0,
			kind: "brand",
			categories: ["event"],
			scope: "task_only",
		}),
		(error: unknown) =>
			error instanceof SubscriptionError &&
			error.reason === "invalid_target",
		"品牌必须给名称",
	);
	await assert.rejects(
		service.addTarget("user-a", {
			expectedVersion: 0,
			kind: "brand",
			label: "某某",
			sourceUrl: "javascript:alert(1)",
			categories: ["event"],
			scope: "task_only",
		}),
		(error: unknown) =>
			error instanceof SubscriptionError &&
			error.reason === "invalid_target",
		"来源链接必须是 http(s)",
	);
	// 重复类别去重而不是报错。
	const view = await service.addTarget("user-a", {
		expectedVersion: 0,
		kind: "task",
		refId: task,
		categories: ["effect", "effect", "event"],
		scope: "task_only",
	});
	assert.deepEqual(view.targets[0]?.categories, ["effect", "event"]);
});

test("subscription: 对象退订与类别退订可区分，恢复后不丢配置", async () => {
	const { service } = setup();
	const added = await service.addTarget("user-a", {
		expectedVersion: 0,
		kind: "brand",
		label: "某某灯饰",
		categories: ["effect", "event", "evidence"],
		scope: "include_general",
	});
	const id = added.targets[0]?.id as string;

	// 类别退订：从该对象上移除类别，对象仍在。
	const narrowed = await service.updateTarget("user-a", id, {
		expectedVersion: 1,
		categories: ["event"],
	});
	assert.deepEqual(narrowed.targets[0]?.categories, ["event"]);
	assert.equal(narrowed.targets[0]?.status, "active");

	// 对象退订：muted 但保留配置。
	const muted = await service.updateTarget("user-a", id, {
		expectedVersion: 2,
		status: "muted",
	});
	assert.equal(muted.targets[0]?.status, "muted");
	assert.deepEqual(muted.targets[0]?.categories, ["event"]);

	const restored = await service.updateTarget("user-a", id, {
		expectedVersion: 3,
		status: "active",
		scope: "task_only",
	});
	assert.equal(restored.targets[0]?.status, "active");
	assert.equal(restored.targets[0]?.scope, "task_only");
	assert.equal(restored.settings.version, 4);
});

test("subscription: 他人对象不能被修改，且不泄露存在性", async () => {
	const { service } = setup();
	const added = await service.addTarget("user-a", {
		expectedVersion: 0,
		kind: "brand",
		label: "某某灯饰",
		categories: ["event"],
		scope: "task_only",
	});
	const id = added.targets[0]?.id as string;

	await assert.rejects(
		service.updateTarget("user-b", id, { expectedVersion: 0, status: "muted" }),
		(error: unknown) =>
			error instanceof SubscriptionError &&
			error.reason === "target_not_found",
	);
	await assert.rejects(
		service.updateTarget("user-b", randomUUID(), {
			expectedVersion: 0,
			status: "muted",
		}),
		(error: unknown) =>
			error instanceof SubscriptionError &&
			error.reason === "target_not_found",
		"不存在的 id 与他人 id 返回同一错误",
	);
	// 他人的改动不会推进 user-a 的版本。
	const view = await service.view("user-a");
	assert.equal(view.settings.version, 1);
	assert.equal(view.targets[0]?.status, "active");
});

test("subscription: 两名用户配置相互隔离，重启（新实例）后一致", async () => {
	const { storage, service } = setup();
	const mine = await seedTask(storage, "user-a", "护眼台灯");
	await service.addTarget("user-a", {
		expectedVersion: 0,
		kind: "task",
		refId: mine,
		categories: ["effect"],
		scope: "task_only",
	});
	await service.updateSettings("user-a", {
		expectedVersion: 1,
		proactiveEnabled: true,
	});
	await service.addTarget("user-b", {
		expectedVersion: 0,
		kind: "brand",
		label: "别家品牌",
		categories: ["event"],
		scope: "include_general",
	});

	// 新实例读同一个存储：不依赖进程内缓存。
	const reopened = new SubscriptionService(storage);
	const a = await reopened.view("user-a");
	const b = await reopened.view("user-b");
	assert.equal(a.settings.proactiveEnabled, true);
	assert.equal(a.settings.version, 2);
	assert.deepEqual(
		a.targets.map((item) => item.label),
		["护眼台灯"],
	);
	assert.equal(b.settings.proactiveEnabled, false, "另一用户仍是默认关闭");
	assert.deepEqual(
		b.targets.map((item) => item.label),
		["别家品牌"],
	);
});

test("subscription: 存储层保留内部字段，视图不外泄 userId", async () => {
	const { storage, service } = setup();
	const added = await service.addTarget("user-a", {
		expectedVersion: 0,
		kind: "brand",
		label: "某某灯饰",
		categories: ["event"],
		scope: "task_only",
	});
	const stored = (await storage.transaction((tx) =>
		tx.subscriptionTargets.all(),
	)) as Array<{ userId: string }>;
	assert.equal(stored[0]?.userId, "user-a");
	const settings = (await storage.transaction((tx) =>
		tx.subscriptionSettings.all(),
	)) as SubscriptionSettings[];
	assert.equal(settings[0]?.id, "user-a");
	assert.equal("userId" in (added.targets[0] as object), false, "视图不返回 userId");
});
