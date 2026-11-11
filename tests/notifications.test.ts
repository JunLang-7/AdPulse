import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
	AuthenticationService,
	NotificationError,
	NotificationService,
	type PlatformIdentity,
} from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identityOf = (externalId: string): PlatformIdentity => ({
	platform: "feishu",
	applicationId: "cli_test",
	tenantId: "tenant-a",
	idType: "open_id",
	externalId,
});
const clock = { value: "2026-01-01T00:00:00.000Z" };
const now = () => clock.value;

async function setup() {
	const storage = new MemoryStorage();
	const auth = new AuthenticationService(storage);
	const notifications = new NotificationService(storage, now);
	const login = (externalId: string, token: string) =>
		auth.createWebSession(identityOf(externalId), hash(token), now());
	const first = await login("ou-a", "a".repeat(43));
	const second = await login("ou-b", "b".repeat(43));
	return {
		storage,
		auth,
		notifications,
		first,
		second,
		identity: { a: identityOf("ou-a"), b: identityOf("ou-b") },
	};
}

test("destination: 只能由本人已验证身份确认，重复确认幂等", async () => {
	const { notifications, first, identity } = await setup();
	const created = await notifications.verifyDestination(first.userId, identity.a);
	assert.equal(created.userId, first.userId);
	assert.equal(created.status, "verified");
	assert.equal(created.externalId, "ou-a");

	const again = await notifications.verifyDestination(first.userId, identity.a);
	assert.equal(again.id, created.id, "重复确认同一作用域应幂等");

	const status = await notifications.status(first.userId);
	assert.equal(status.destination?.id, created.id);
	assert.equal(status.consent, null);
	assert.equal(status.canSendProactive, false, "未授权不得主动发送");
});

test("destination: 换作用域与他人作用域都被拒绝", async () => {
	const { notifications, first, second, identity, storage } = await setup();
	await notifications.verifyDestination(first.userId, identity.a);

	// 未绑定到自己的作用域：先拒绝在建目的地之前。
	await assert.rejects(
		() => notifications.verifyDestination(first.userId, identityOf("ou-a2")),
		(error: unknown) =>
			error instanceof NotificationError && error.reason === "identity_not_verified",
	);
	// 同一用户存在第二个已验证作用域时，换绑被拒（首期每人一个目的地）。
	await storage.transaction((tx) =>
		tx.identityBindings.put({
			id: "binding-a2",
			...identityOf("ou-a2"),
			userId: first.userId,
			status: "active",
			verifiedAt: clock.value,
		}),
	);
	await assert.rejects(
		() => notifications.verifyDestination(first.userId, identityOf("ou-a2")),
		(error: unknown) =>
			error instanceof NotificationError && error.reason === "destination_conflict",
	);
	// 别人的作用域不能被认领：B 拿 A 的 open_id 建目的地必须失败。
	// 绑定作用域唯一，所以这里在「绑定不属于自己」处就被拦下。
	await assert.rejects(
		() => notifications.verifyDestination(second.userId, identity.a),
		(error: unknown) =>
			error instanceof NotificationError && error.reason === "identity_not_verified",
	);
	// 用未绑定到自己的作用域也不行。
	await assert.rejects(
		() => notifications.verifyDestination(second.userId, identityOf("ou-unknown")),
		(error: unknown) =>
			error instanceof NotificationError && error.reason === "identity_not_verified",
	);
});

test("consent: 授权/撤销/恢复与主动发送闸门", async () => {
	const { notifications, first, identity } = await setup();
	const destination = await notifications.verifyDestination(first.userId, identity.a);

	const granted = await notifications.grantConsent(first.userId, destination.id, 0);
	assert.equal(granted.status, "active");
	assert.equal(granted.version, 1);
	assert.equal(await notifications.canSendProactive(first.userId), true);

	clock.value = "2026-01-01T01:00:00.000Z";
	const revoked = await notifications.revokeConsent(first.userId, destination.id, granted.version);
	assert.equal(revoked.version, 2);
	assert.equal(revoked.status, "revoked");
	assert.equal(revoked.revokedAt, clock.value);
	assert.equal(
		await notifications.canSendProactive(first.userId),
		false,
		"撤销后不得主动发送",
	);
	// 撤销不等于注销：目的地与用户都还在。
	const status = await notifications.status(first.userId);
	assert.equal(status.destination?.id, destination.id);
	assert.equal(status.consent?.status, "revoked");

	// 旧请求重放（携旧版本）不得把撤销重新打开。
	await assert.rejects(
		() => notifications.grantConsent(first.userId, destination.id, granted.version),
		(error: unknown) =>
			error instanceof NotificationError && error.reason === "consent_conflict",
	);
	assert.equal(await notifications.canSendProactive(first.userId), false);
	// 显式恢复需带当前版本。
	const restored = await notifications.grantConsent(
		first.userId,
		destination.id,
		revoked.version,
	);
	assert.equal(restored.status, "active");
	assert.equal(restored.version, 3);
	assert.equal(await notifications.canSendProactive(first.userId), true);
});

test("consent: 不能替他人授权或撤销", async () => {
	const { notifications, first, second, identity, storage } = await setup();
	const destination = await notifications.verifyDestination(first.userId, identity.a);
	await assert.rejects(
		() => notifications.grantConsent(second.userId, destination.id, 0),
		(error: unknown) =>
			error instanceof NotificationError && error.reason === "destination_not_found",
	);
	const granted = await notifications.grantConsent(first.userId, destination.id, 0);
	await assert.rejects(
		() => notifications.revokeConsent(second.userId, granted.destinationId, granted.version),
		(error: unknown) =>
			error instanceof NotificationError && error.reason === "consent_not_granted",
	);
	assert.equal(await notifications.canSendProactive(first.userId), true);
	assert.equal(await notifications.canSendProactive(second.userId), false);
	const all = await storage.transaction((tx) => tx.notificationConsents.all());
	assert.equal(all.length, 1, "跨用户授权不应产生记录");
});

test("canSendProactive: 身份绑定撤销或用户停用后抑制", async () => {
	const { notifications, first, identity, storage } = await setup();
	const destination = await notifications.verifyDestination(first.userId, identity.a);
	await notifications.grantConsent(first.userId, destination.id, 0);
	assert.equal(await notifications.canSendProactive(first.userId), true);

	await storage.transaction(async (tx) => {
		const bindings = (await tx.identityBindings.all()).filter(
			(item) => item.userId === first.userId,
		);
		for (const binding of bindings)
			await tx.identityBindings.put({ ...binding, status: "revoked" });
	});
	assert.equal(
		await notifications.canSendProactive(first.userId),
		false,
		"绑定撤销后必须抑制投递",
	);

	await storage.transaction(async (tx) => {
		const user = await tx.users.get(first.userId);
		if (user) await tx.users.put({ ...user, status: "disabled" });
	});
	assert.equal(await notifications.canSendProactive(first.userId), false);
});

test("destination: 失效后重新验证可恢复，且不顺带恢复已撤销的授权", async () => {
	const { notifications, first, identity, storage } = await setup();
	const destination = await notifications.verifyDestination(first.userId, identity.a);
	await notifications.grantConsent(first.userId, destination.id, 0);
	await notifications.revokeConsent(first.userId, destination.id, 1);
	assert.equal(await notifications.canSendProactive(first.userId), false);

	// 目的地失效（当前无自动失效路径，按将来的排查/失效处理直接置状态）。
	clock.value = "2026-01-01T02:00:00.000Z";
	await storage.transaction(async (tx) => {
		const current = await tx.notificationDestinations.get(destination.id);
		if (current)
			await tx.notificationDestinations.put({ ...current, status: "invalidated" });
	});
	assert.equal((await notifications.status(first.userId)).destination?.status, "invalidated");

	// 本人绑定仍然有效时，重新确认应恢复为 verified。
	const reverified = await notifications.verifyDestination(first.userId, identity.a);
	assert.equal(reverified.id, destination.id, "恢复应复用原记录，不新建目的地");
	assert.equal(reverified.status, "verified");
	assert.equal(reverified.verifiedAt, clock.value);

	// 授权状态独立：之前撤销的授权不能被这次重验顺带恢复。
	const status = await notifications.status(first.userId);
	assert.equal(status.consent?.status, "revoked");
	assert.equal(status.canSendProactive, false);

	// 显式重新授权后才可主动发送（版本需匹配当前撤销后的值）。
	const current = await notifications.status(first.userId);
	await notifications.grantConsent(
		first.userId,
		destination.id,
		current.consent?.version ?? 0,
	);
	assert.equal(await notifications.canSendProactive(first.userId), true);
});

test("destination: 失效但绑定已撤销时不能靠重验恢复", async () => {
	const { notifications, first, identity, storage } = await setup();
	const destination = await notifications.verifyDestination(first.userId, identity.a);
	await storage.transaction(async (tx) => {
		const current = await tx.notificationDestinations.get(destination.id);
		if (current)
			await tx.notificationDestinations.put({ ...current, status: "invalidated" });
		const bindings = (await tx.identityBindings.all()).filter(
			(item) => item.userId === first.userId,
		);
		for (const binding of bindings)
			await tx.identityBindings.put({ ...binding, status: "revoked" });
	});
	await assert.rejects(
		() => notifications.verifyDestination(first.userId, identity.a),
		(error: unknown) =>
			error instanceof NotificationError && error.reason === "identity_not_verified",
	);
});

test("consent: 地址失效后仍能直接撤销，不必先重新确认", async () => {
	const { notifications, first, identity, storage } = await setup();
	const destination = await notifications.verifyDestination(first.userId, identity.a);
	const granted = await notifications.grantConsent(first.userId, destination.id, 0);
	assert.equal(await notifications.canSendProactive(first.userId), true);

	// 地址失效（触发条件留待 PR4），此时闸门已关闭。
	await storage.transaction(async (tx) => {
		const current = await tx.notificationDestinations.get(destination.id);
		if (current)
			await tx.notificationDestinations.put({ ...current, status: "invalidated" });
	});
	assert.equal(await notifications.canSendProactive(first.userId), false);

	// 关键：可以直接撤销，不需要先「重新确认地址」恢复发送资格。
	const revoked = await notifications.revokeConsent(
		first.userId,
		destination.id,
		granted.version,
	);
	assert.equal(revoked.status, "revoked");
	assert.equal(await notifications.canSendProactive(first.userId), false);

	// 失效地址上不能直接授权：必须先重新确认。
	await assert.rejects(
		() => notifications.grantConsent(first.userId, destination.id, revoked.version),
		(error: unknown) =>
			error instanceof NotificationError && error.reason === "destination_not_found",
	);
});
