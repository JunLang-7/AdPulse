// 机器人单聊目的地与通知授权：把「能不能主动发、发到哪里」建模成独立状态。
// 平台中立：输入只有已验证身份（来自 #34 的登录绑定），不认识 Feishu/钉钉差异。

import crypto from "node:crypto";
import type { Storage, Transaction } from "./ports/storage.js";
import type {
	NotificationConsent,
	NotificationDestination,
	User,
} from "./state/model.js";
import type { VerifiedIdentity } from "./authentication.js";

/** 业务侧可区分的失败原因；边界层据此映射状态码，不猜。 */
export class NotificationError extends Error {
	constructor(
		readonly reason:
			| "identity_not_verified"
			| "destination_conflict"
			| "destination_not_found"
			| "consent_not_granted"
			| "user_unavailable",
		message: string,
	) {
		super(message);
		this.name = "NotificationError";
	}
}

export interface NotificationStatus {
	/** 目的地本身：地址是否已验证。与授权无关。 */
	destination: {
		id: string;
		platform: string;
		applicationId: string;
		tenantId: string;
		idType: string;
		externalId: string;
		status: NotificationDestination["status"];
		verifiedAt: string;
	} | null;
	/** 授权状态：撤销后目的地仍在，但不再允许主动发送。 */
	consent: {
		status: NotificationConsent["status"];
		grantedAt: string;
		revokedAt?: string;
	} | null;
	/** 唯一出口：登录绑定有效 && 目的地已验证 && 授权 active。 */
	canSendProactive: boolean;
}

const validValue = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 512 &&
	!/[\u0000-\u001f]/.test(value);

const validIdentity = (identity: VerifiedIdentity): boolean =>
	validValue(identity?.platform) &&
	validValue(identity?.applicationId) &&
	validValue(identity?.tenantId) &&
	validValue(identity?.idType) &&
	validValue(identity?.externalId);

const sameScope = (
	destination: NotificationDestination,
	identity: VerifiedIdentity,
): boolean =>
	destination.platform === identity.platform &&
	destination.applicationId === identity.applicationId &&
	destination.tenantId === identity.tenantId &&
	destination.idType === identity.idType &&
	destination.externalId === identity.externalId;

const consentId = (userId: string, destinationId: string): string =>
	`${userId}:${destinationId}`;

/** 目的地只能由本人当前已验证的身份产生：不接收前端传来的 externalId。 */
async function requireActiveUser(
	tx: Transaction,
	userId: string,
): Promise<User> {
	const user = await tx.users.get(userId);
	if (!user || user.status !== "active")
		throw new NotificationError("user_unavailable", "user unavailable");
	const bindings = await tx.identityBindings.all();
	if (!bindings.some((binding) => binding.userId === userId && binding.status === "active"))
		throw new NotificationError("identity_not_verified", "identity not verified");
	return user;
}

export class NotificationService {
	constructor(
		private storage: Storage,
		private now: () => string = () => new Date().toISOString(),
		private id: () => string = () => crypto.randomUUID(),
	) {}

	/**
	 * 用当前会话已验证的身份确认单聊目的地。重复确认同一作用域是幂等的；
	 * 换成另一个作用域属首期不支持的换绑，直接拒绝。
	 */
	async verifyDestination(
		userId: string,
		identity: VerifiedIdentity,
	): Promise<NotificationDestination> {
		if (!validIdentity(identity))
			throw new NotificationError("identity_not_verified", "identity not verified");
		return this.storage.transaction(async (tx) => {
			await requireActiveUser(tx, userId);
			const bindings = await tx.identityBindings.all();
			const ownBinding = bindings.find(
				(binding) =>
					binding.userId === userId &&
					binding.status === "active" &&
					binding.platform === identity.platform &&
					binding.applicationId === identity.applicationId &&
					binding.tenantId === identity.tenantId &&
					binding.idType === identity.idType &&
					binding.externalId === identity.externalId,
			);
			// 只接受本人当前已验证的作用域，避免用别人的 open_id 建目的地。
			if (!ownBinding)
				throw new NotificationError("identity_not_verified", "identity not verified");

			const all = await tx.notificationDestinations.all();
			const mine = all.filter((item) => item.userId === userId);
			const existing = mine.find((item) => sameScope(item, identity));
			if (existing) return existing;

			// 首期每人一个目的地：换成新作用域属换绑，不在本 Issue 范围。
			if (mine.length > 0)
				throw new NotificationError(
					"destination_conflict",
					"destination already verified for another identity scope",
				);
			// 防御性检查：正常数据下绑定作用域唯一，走不到这里；
			// 一旦绑定数据被手工改坏，也不能静默把同一作用域挂到两个人身上。
			if (all.some((item) => sameScope(item, identity)))
				throw new NotificationError(
					"destination_conflict",
					"destination scope belongs to another user",
				);

			const destination: NotificationDestination = {
				id: this.id(),
				userId,
				platform: identity.platform,
				applicationId: identity.applicationId,
				tenantId: identity.tenantId,
				idType: identity.idType,
				externalId: identity.externalId,
				status: "verified",
				verifiedAt: this.now(),
			};
			await tx.notificationDestinations.put(destination);
			return destination;
		});
	}

	/** 授权主动通知：必须是本人已验证的目的地。 */
	async grantConsent(
		userId: string,
		destinationId: string,
	): Promise<NotificationConsent> {
		return this.storage.transaction(async (tx) => {
			await requireActiveUser(tx, userId);
			const destination = await tx.notificationDestinations.get(destinationId);
			if (!destination || destination.userId !== userId || destination.status !== "verified")
				throw new NotificationError("destination_not_found", "destination not found");
			const id = consentId(userId, destinationId);
			const existing = await tx.notificationConsents.get(id);
			if (existing?.status === "active") return existing;
			const consent: NotificationConsent = {
				id,
				userId,
				destinationId,
				status: "active",
				grantedAt: this.now(),
			};
			await tx.notificationConsents.put(consent);
			return consent;
		});
	}

	/** 撤销授权：不删除目的地，也不注销账号。 */
	async revokeConsent(
		userId: string,
		destinationId: string,
	): Promise<NotificationConsent> {
		return this.storage.transaction(async (tx) => {
			const id = consentId(userId, destinationId);
			const existing = await tx.notificationConsents.get(id);
			if (!existing || existing.userId !== userId)
				throw new NotificationError("consent_not_granted", "consent not granted");
			if (existing.status === "revoked") return existing;
			const consent: NotificationConsent = {
				...existing,
				status: "revoked",
				revokedAt: this.now(),
			};
			await tx.notificationConsents.put(consent);
			return consent;
		});
	}

	/** 状态查询：供辅助设置页与验收脚本断言状态机。 */
	async status(userId: string): Promise<NotificationStatus> {
		return this.storage.transaction(async (tx) => {
			const destinations = (
				await tx.notificationDestinations.all()
			).filter((item) => item.userId === userId);
			const destination = destinations[0] ?? null;
			const consent = destination
				? await tx.notificationConsents.get(consentId(userId, destination.id))
				: null;
			return {
				destination: destination
					? {
							id: destination.id,
							platform: destination.platform,
							applicationId: destination.applicationId,
							tenantId: destination.tenantId,
							idType: destination.idType,
							externalId: destination.externalId,
							status: destination.status,
							verifiedAt: destination.verifiedAt,
						}
					: null,
				consent: consent
					? {
							status: consent.status,
							grantedAt: consent.grantedAt,
							...(consent.revokedAt ? { revokedAt: consent.revokedAt } : {}),
						}
					: null,
				canSendProactive: await canSendProactiveIn(tx, userId),
			};
		});
	}

	/** 投递前的唯一判断；worker 与用例共用，避免各自实现一套。 */
	async canSendProactive(userId: string): Promise<boolean> {
		return this.storage.transaction((tx) => canSendProactiveIn(tx, userId));
	}
}

async function canSendProactiveIn(
	tx: Transaction,
	userId: string,
): Promise<boolean> {
	const user = await tx.users.get(userId);
	if (!user || user.status !== "active") return false;
	const destinations = (
		await tx.notificationDestinations.all()
	).filter((item) => item.userId === userId && item.status === "verified");
	const destination = destinations[0];
	if (!destination) return false;
	// 身份绑定必须仍然有效：失效即抑制，不依赖日常清理。
	const bindings = await tx.identityBindings.all();
	const bound = bindings.some(
		(binding) =>
			binding.userId === userId &&
			binding.status === "active" &&
			binding.platform === destination.platform &&
			binding.applicationId === destination.applicationId &&
			binding.tenantId === destination.tenantId &&
			binding.idType === destination.idType &&
			binding.externalId === destination.externalId,
	);
	if (!bound) return false;
	const consent = await tx.notificationConsents.get(
		consentId(userId, destination.id),
	);
	return consent?.status === "active";
}
