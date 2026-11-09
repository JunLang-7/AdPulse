import assert from "node:assert/strict";
import test from "node:test";

import {
	describeNotificationStatus,
	maskExternalId,
	notificationPlatformLabel,
	type NotificationStatusLike,
} from "../apps/console/src/views/adpulse/settings/notifications/notification-view.ts";

const destination = {
	platform: "feishu",
	externalId: "ou_83d5b9c8f1a2fd49",
	status: "verified" as const,
};

test("notification view: 未确认地址时只提供确认动作", () => {
	const view = describeNotificationStatus({
		destination: null,
		consent: null,
		canSendProactive: false,
	});
	assert.equal(view.destination, null);
	assert.deepEqual(view.actions.map((a) => a.kind), ["verify"]);
});

test("notification view: 已确认未授权时按 version=0 开启", () => {
	const view = describeNotificationStatus({
		destination,
		consent: null,
		canSendProactive: false,
	});
	assert.equal(view.destination?.maskedId, "ou_83d5b***fd49");
	assert.deepEqual(view.actions, [
		{ kind: "grant", label: "开启主动提醒", expectedVersion: 0 },
	]);
});

test("notification view: 已授权时只能撤销，且带当前版本", () => {
	const view = describeNotificationStatus({
		destination,
		consent: { status: "active", version: 3 },
		canSendProactive: true,
	});
	assert.deepEqual(view.actions, [
		{ kind: "revoke", label: "撤销主动提醒", expectedVersion: 3 },
	]);
	assert.equal(view.warning, undefined);
});

test("notification view: 已授权但闸门关闭时必须给出警告", () => {
	const view = describeNotificationStatus({
		destination,
		consent: { status: "active", version: 1 },
		canSendProactive: false,
	});
	assert.match(view.warning ?? "", /绑定|身份/);
});

test("notification view: 撤销后说明不影响登录，并允许重新开启", () => {
	const view = describeNotificationStatus({
		destination,
		consent: { status: "revoked", version: 2 },
		canSendProactive: false,
	});
	assert.match(view.detail, /不影响登录/);
	assert.deepEqual(view.actions, [
		{ kind: "grant", label: "重新开启", expectedVersion: 2 },
	]);
});

test("notification view: 地址失效但授权仍 active 时必须能直接撤销", () => {
	const view = describeNotificationStatus({
		destination: { ...destination, status: "invalidated" },
		consent: { status: "active", version: 5 },
		canSendProactive: false,
	});
	assert.deepEqual(view.actions, [
		{ kind: "verify", label: "重新确认地址" },
		{ kind: "revoke", label: "撤销主动提醒", expectedVersion: 5 },
	]);
	assert.match(view.detail, /不会发送/);
	assert.match(view.detail, /直接撤销/);
	assert.match(view.warning ?? "", /不会发送/);
});

test("notification view: 地址失效且无有效授权时只提供重新确认", () => {
	const withoutConsent = describeNotificationStatus({
		destination: { ...destination, status: "invalidated" },
		consent: null,
		canSendProactive: false,
	});
	assert.deepEqual(withoutConsent.actions.map((a) => a.kind), ["verify"]);
	const revoked = describeNotificationStatus({
		destination: { ...destination, status: "invalidated" },
		consent: { status: "revoked", version: 2 },
		canSendProactive: false,
	});
	assert.deepEqual(revoked.actions.map((a) => a.kind), ["verify"]);
});

test("notification view: 地址失效时先重新确认，不自动恢复授权", () => {
	const view = describeNotificationStatus({
		destination: { ...destination, status: "invalidated" },
		consent: { status: "revoked", version: 4 },
		canSendProactive: false,
	});
	assert.deepEqual(view.actions.map((a) => a.kind), ["verify"]);
	assert.match(view.detail, /不会自动恢复/);
});

test("notification view: 平台名与标识脱敏", () => {
	assert.equal(notificationPlatformLabel("feishu"), "飞书");
	assert.equal(notificationPlatformLabel("wecom"), "企业微信");
	assert.equal(notificationPlatformLabel("slack"), "slack");
	assert.equal(notificationPlatformLabel(undefined), "外部账号");
	assert.equal(maskExternalId("ou_83d5b9c8f1a2fd49"), "ou_83d5b***fd49");
	assert.equal(maskExternalId("short"), "sh***");
	assert.equal(maskExternalId(undefined), "—");
});
