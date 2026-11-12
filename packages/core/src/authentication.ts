import { timingSafeEqual } from "node:crypto";
import { cancelDecisionDeliveriesIn } from "./decision-cancellation.js";
import type { IdentityBinding, LoginTransaction, WebSession } from "./state/model.js";
import type { PlatformIdentity } from "./ports/channel.js";
import type { Storage, Transaction } from "./ports/storage.js";

export const LEGACY_WEB_SESSION_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type WebSessionMode = "default" | "remembered";

export const WEB_SESSION_POLICIES = {
	default: { idleMs: 24 * HOUR_MS, absoluteMs: 7 * DAY_MS },
	remembered: { idleMs: 7 * DAY_MS, absoluteMs: 30 * DAY_MS },
} as const satisfies Record<WebSessionMode, { idleMs: number; absoluteMs: number }>;

const validSessionMode = (mode: string): mode is WebSessionMode =>
	mode === "default" || mode === "remembered";
const parseIsoDate = (value: string): number => {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error("invalid session timestamp");
	return timestamp;
};
export const webSessionExpiry = (
	mode: WebSessionMode,
	authenticatedAt: string,
	lastActivityAt: string = authenticatedAt,
): { idleExpiresAt: string; absoluteExpiresAt: string; expiresAt: string } => {
	const authenticated = parseIsoDate(authenticatedAt);
	const activity = parseIsoDate(lastActivityAt);
	if (activity < authenticated) throw new Error("session activity precedes authentication");
	const policy = WEB_SESSION_POLICIES[mode];
	const idleExpiresAt = activity + policy.idleMs;
	const absoluteExpiresAt = authenticated + policy.absoluteMs;
	return {
		idleExpiresAt: new Date(idleExpiresAt).toISOString(),
		absoluteExpiresAt: new Date(absoluteExpiresAt).toISOString(),
		expiresAt: new Date(Math.min(idleExpiresAt, absoluteExpiresAt)).toISOString(),
	};
};

/** Platform-neutral identity contract shared by login and inbound channels. */
export type VerifiedIdentity = PlatformIdentity;

export interface NewLoginTransaction {
	id: string;
	browserBindingHash: string;
	codeVerifier: string;
	returnTo: string;
	createdAt: string;
	expiresAt: string;
	rememberMe?: boolean;
}

export interface AuthenticatedSession {
	userId: string;
	sessionId: string;
	createdAt: string;
	expiresAt: string;
	recentlyVerifiedAt?: string;
	sessionMode?: WebSessionMode;
	authenticatedAt?: string;
	lastActivityAt?: string;
	idleExpiresAt?: string;
	absoluteExpiresAt?: string;
	/** 展示用名称，来自平台返回；缺省时界面自行降级。 */
	displayName?: string;
	/** 该会话所属绑定的身份作用域：边界层据此决定「为谁确认目的地」，不接受客户端传入。 */
	identity?: VerifiedIdentity;
}

const digestPattern = /^[a-f0-9]{64}$/;
const sameDigest = (left: string, right: string): boolean =>
	left.length === right.length &&
	timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
const identityMatches = (
	binding: IdentityBinding,
	identity: VerifiedIdentity,
): boolean =>
	binding.platform === identity.platform &&
	binding.applicationId === identity.applicationId &&
	binding.tenantId === identity.tenantId &&
	binding.idType === identity.idType &&
	binding.externalId === identity.externalId;
const validIdentity = (identity: VerifiedIdentity): boolean =>
	Object.values(identity).every(
		(value) =>
			typeof value === "string" &&
			value.length > 0 &&
			value.length <= 512 &&
			!/[\u0000-\u001f]/.test(value),
	);

/** Recheck inside the business transaction so revocation and execution serialize. */
export async function resolveActiveIdentity(
	tx: Transaction,
	identity: VerifiedIdentity,
): Promise<string | null> {
	if (!validIdentity(identity)) return null;
	const binding = (await tx.identityBindings.all()).find((candidate) =>
		identityMatches(candidate, identity),
	);
	if (!binding || binding.status !== "active") return null;
	const user = await tx.users.get(binding.userId);
	return user?.status === "active" ? user.id : null;
}

const isRetryableConflict = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null || !("code" in error))
		return false;
	const code = String(error.code);
	return code === "23505" || code === "40001" || code === "40P01";
};

/** Platform-neutral identity/session use cases; protocol verification stays at the API boundary. */
export class AuthenticationService {
	constructor(private readonly storage: Storage) {}

	async beginLogin(input: NewLoginTransaction): Promise<void> {
		const createdAt = Date.parse(input.createdAt);
		const expiresAt = Date.parse(input.expiresAt);
		if (
			!digestPattern.test(input.id) ||
			!digestPattern.test(input.browserBindingHash) ||
			input.codeVerifier.length < 43 ||
			input.codeVerifier.length > 128 ||
			input.returnTo.length > 2048 ||
			!input.returnTo.startsWith("/") ||
			input.returnTo.startsWith("//") ||
			input.returnTo.includes("\\") ||
			!Number.isFinite(createdAt) ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= createdAt ||
			(input.rememberMe !== undefined && typeof input.rememberMe !== "boolean")
		)
			throw new Error("invalid login transaction");
		await this.storage.transaction(async (tx) => {
			// Expired transactions no longer need to retain the short-lived PKCE verifier.
			for (const previous of await tx.loginTransactions.all()) {
				if (previous.status === "pending" && previous.expiresAt <= input.createdAt)
					await tx.loginTransactions.put({
						...previous,
						codeVerifier: "",
						status: "expired",
						consumedAt: input.createdAt,
					});
			}
			if (await tx.loginTransactions.get(input.id))
				throw new Error("login transaction collision");
			const transaction: LoginTransaction = {
				...input,
				status: "pending",
				...(input.rememberMe === true ? { rememberMe: true } : {}),
			};
			await tx.loginTransactions.put(transaction);
		});
	}

	/** Atomically consumes a browser-bound, unexpired OAuth transaction exactly once. */
	async consumeLogin(
		id: string,
		browserBindingHash: string,
		now: string,
	): Promise<LoginTransaction | null> {
		if (!digestPattern.test(id) || !digestPattern.test(browserBindingHash)) return null;
		return this.storage.transaction(async (tx) => {
			const transaction = await tx.loginTransactions.get(id);
			if (!transaction || transaction.status !== "pending") return null;
			if (transaction.expiresAt <= now) {
				await tx.loginTransactions.put({
					...transaction,
					codeVerifier: "",
					status: "expired",
					consumedAt: now,
				});
				return null;
			}
			if (!sameDigest(transaction.browserBindingHash, browserBindingHash)) return null;
			const consumed: LoginTransaction = {
				...transaction,
				codeVerifier: "",
				status: "consumed",
				consumedAt: now,
			};
			await tx.loginTransactions.put(consumed);
			return transaction;
		});
	}

	/** Creates the first personal user for a verified scoped identity, or reuses its binding. */
	async createWebSession(
		identity: VerifiedIdentity,
		sessionTokenHash: string,
		now: string,
		displayName?: string,
		mode: WebSessionMode = "default",
	): Promise<AuthenticatedSession> {
		if (!digestPattern.test(sessionTokenHash) || !Number.isFinite(Date.parse(now)))
			throw new Error("invalid session token or timestamp");
		if (!validIdentity(identity)) throw new Error("invalid verified identity");
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.storage.transaction(async (tx) => {
					const existing = (await tx.identityBindings.all()).find((binding) =>
						identityMatches(binding, identity),
					);
					let binding: IdentityBinding;
					let userId: string;
					if (existing) {
						if (existing.status !== "active")
							throw new Error("identity binding unavailable");
						const user = await tx.users.get(existing.userId);
						if (!user || user.status !== "active")
							throw new Error("identity user unavailable");
						// Do not rewrite the binding on every login: concurrent logins would
						// contend on the same row. It records when the binding was established.
						binding = existing;
						userId = user.id;
						// 展示名只在变化时更新，避免普通登录产生不必要的行重写。
						if (displayName && user.displayName !== displayName)
							await tx.users.put({ ...user, displayName });
					} else {
						userId = crypto.randomUUID();
						binding = {
							id: crypto.randomUUID(),
							...identity,
							userId,
							status: "active",
							verifiedAt: now,
						};
						await tx.users.put({
							id: userId,
							status: "active",
							createdAt: now,
							...(displayName ? { displayName } : {}),
						});
						await tx.identityBindings.put(binding);
					}
					const expiry = webSessionExpiry(mode, now);
					const session: AuthenticatedSession = {
						userId,
						sessionId: sessionTokenHash,
						createdAt: now,
						expiresAt: expiry.expiresAt,
						recentlyVerifiedAt: now,
						...(displayName ? { displayName } : {}),
					};
					await tx.webSessions.put({
						id: sessionTokenHash,
						familyId: crypto.randomUUID(),
						userId,
						identityBindingId: binding.id,
						createdAt: session.createdAt,
						expiresAt: session.expiresAt,
						tokenStatus: "current",
						sessionMode: mode,
						authenticatedAt: now,
						recentlyVerifiedAt: now,
						lastActivityAt: now,
						idleExpiresAt: expiry.idleExpiresAt,
						absoluteExpiresAt: expiry.absoluteExpiresAt,
					});
					return session;
				});
			} catch (error) {
				// Concurrent first logins can collide on the scoped-identity unique index
				// or be aborted by serializable conflict detection. Retry outside the
				// failed transaction so the winner's user ID is reused.
				if (!isRetryableConflict(error) || attempt >= 7) throw error;
				await new Promise((resolve) =>
					setTimeout(resolve, 10 + Math.random() * 20 * (attempt + 1)),
				);
			}
		}
	}

	/** Resolves a provider-verified scoped identity to its active internal user. */
	async resolveIdentity(identity: VerifiedIdentity): Promise<string | null> {
		return this.storage.transaction((tx) => resolveActiveIdentity(tx, identity));
	}

	/** Active identity bindings owned by one internal user. */
	async listIdentities(userId: string): Promise<VerifiedIdentity[]> {
		return this.storage.transaction(async (tx) =>
			(await tx.identityBindings.all())
				.filter(
					(binding) =>
						binding.userId === userId && binding.status === "active",
				)
				.map((binding) => ({
					platform: binding.platform,
					applicationId: binding.applicationId,
					tenantId: binding.tenantId,
					idType: binding.idType,
					externalId: binding.externalId,
				})),
		);
	}

	async authenticateSession(
		sessionTokenHash: string,
		now: string,
	): Promise<AuthenticatedSession | null> {
		if (!digestPattern.test(sessionTokenHash)) return null;
		return this.storage.transaction(async (tx) => {
			const session = await tx.webSessions.get(sessionTokenHash);
			if (!session || session.revokedAt || session.expiresAt <= now) return null;
			if (session.tokenStatus === "grace" && session.graceExpiresAt && session.graceExpiresAt <= now) return null;
			if (session.sessionMode && !validSessionMode(session.sessionMode)) return null;
			if (session.sessionMode) {
				const expected = webSessionExpiry(
						session.sessionMode,
						session.authenticatedAt ?? session.createdAt,
						session.lastActivityAt ?? session.authenticatedAt ?? session.createdAt,
				);
				if (
					session.idleExpiresAt !== expected.idleExpiresAt ||
					session.absoluteExpiresAt !== expected.absoluteExpiresAt ||
					session.expiresAt !== expected.expiresAt
				)
					return null;
			}
			const [user, binding] = await Promise.all([
				tx.users.get(session.userId),
				tx.identityBindings.get(session.identityBindingId),
			]);
			if (
				!user ||
				user.status !== "active" ||
				!binding ||
				binding.status !== "active" ||
				binding.userId !== user.id
			)
				return null;
			return {
				userId: user.id,
				sessionId: session.id,
				createdAt: session.createdAt,
				expiresAt: session.expiresAt,
				...(session.recentlyVerifiedAt ? { recentlyVerifiedAt: session.recentlyVerifiedAt } : {}),
				...(session.sessionMode ? { sessionMode: session.sessionMode } : {}),
				...(session.authenticatedAt ? { authenticatedAt: session.authenticatedAt } : {}),
				...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}),
				...(session.idleExpiresAt ? { idleExpiresAt: session.idleExpiresAt } : {}),
				...(session.absoluteExpiresAt ? { absoluteExpiresAt: session.absoluteExpiresAt } : {}),
				...(user.displayName ? { displayName: user.displayName } : {}),
				identity: {
					platform: binding.platform,
					applicationId: binding.applicationId,
					tenantId: binding.tenantId,
					idType: binding.idType,
					externalId: binding.externalId,
				},
			};
		});
	}

	/** Slides the idle expiry for a valid, non-revoked session. Legacy sessions keep their fixed expiry. */
	async touchWebSession(
		sessionTokenHash: string,
		now: string,
	): Promise<AuthenticatedSession | null> {
		if (!digestPattern.test(sessionTokenHash) || !Number.isFinite(Date.parse(now))) return null;
		return this.storage.transaction(async (tx) => {
			const session = await tx.webSessions.get(sessionTokenHash);
			if (!session || session.revokedAt || session.expiresAt <= now) return null;
			const [user, binding] = await Promise.all([
				tx.users.get(session.userId),
				tx.identityBindings.get(session.identityBindingId),
			]);
			if (
				!user ||
				user.status !== "active" ||
				!binding ||
				binding.status !== "active" ||
				binding.userId !== user.id
			)
				return null;

			let updated = session;
			if (session.tokenStatus !== "grace" && session.sessionMode && validSessionMode(session.sessionMode)) {
				const authenticatedAt = session.authenticatedAt ?? session.createdAt;
				const absoluteExpiresAt = session.absoluteExpiresAt ?? session.expiresAt;
				if (Date.parse(absoluteExpiresAt) <= Date.parse(now)) return null;
				const lastActivityAt = session.lastActivityAt ?? authenticatedAt;
				// Throttle writes: at most one idle-extension per minute per session.
				if (Date.parse(now) - Date.parse(lastActivityAt) >= 60_000) {
					const expiry = webSessionExpiry(session.sessionMode, authenticatedAt, now);
					updated = {
						...session,
						lastActivityAt: now,
						idleExpiresAt: expiry.idleExpiresAt,
						absoluteExpiresAt: expiry.absoluteExpiresAt,
						expiresAt: expiry.expiresAt,
					};
					await tx.webSessions.put(updated);
				}
			}
			return {
				userId: user.id,
				sessionId: updated.id,
				createdAt: updated.createdAt,
				expiresAt: updated.expiresAt,
				...(updated.recentlyVerifiedAt ? { recentlyVerifiedAt: updated.recentlyVerifiedAt } : {}),
				...(updated.sessionMode ? { sessionMode: updated.sessionMode } : {}),
				...(updated.authenticatedAt ? { authenticatedAt: updated.authenticatedAt } : {}),
				...(updated.lastActivityAt ? { lastActivityAt: updated.lastActivityAt } : {}),
				...(updated.idleExpiresAt ? { idleExpiresAt: updated.idleExpiresAt } : {}),
				...(updated.absoluteExpiresAt ? { absoluteExpiresAt: updated.absoluteExpiresAt } : {}),
				...(user.displayName ? { displayName: user.displayName } : {}),
				identity: {
					platform: binding.platform,
					applicationId: binding.applicationId,
					tenantId: binding.tenantId,
					idType: binding.idType,
					externalId: binding.externalId,
				},
			};
		});
	}

	async revokeSession(sessionTokenHash: string, now: string): Promise<void> {
		if (!digestPattern.test(sessionTokenHash)) return;
		await this.storage.transaction(async (tx) => {
			const session = await tx.webSessions.get(sessionTokenHash);
			if (!session) return;
			const familyId = session.familyId ?? session.id;
			for (const candidate of await tx.webSessions.all()) {
				if ((candidate.familyId ?? candidate.id) === familyId && !candidate.revokedAt)
					await tx.webSessions.put({ ...candidate, revokedAt: now });
			}
		});
	}

	/** Rotates the current token of a family, preserving absolute expiry and granting a short grace window to the old token. */
	async rotateWebSession(
		currentTokenHash: string,
		newTokenHash: string,
		now: string,
	): Promise<AuthenticatedSession | null> {
		if (!digestPattern.test(currentTokenHash) || !digestPattern.test(newTokenHash)) return null;
		if (!Number.isFinite(Date.parse(now))) return null;
		return this.storage.transaction(async (tx) => {
			const current = await tx.webSessions.get(currentTokenHash);
			if (!current || current.revokedAt || current.tokenStatus !== "current" || current.expiresAt <= now) return null;
			const [user, binding] = await Promise.all([
				tx.users.get(current.userId),
				tx.identityBindings.get(current.identityBindingId),
			]);
			if (!user || user.status !== "active" || !binding || binding.status !== "active" || binding.userId !== user.id) return null;
			const familyId = current.familyId ?? current.id;
			const graceExpiresAt = new Date(Date.parse(now) + 30_000).toISOString();
			await tx.webSessions.put({ ...current, tokenStatus: "grace", graceExpiresAt, rotatedAt: now });
			const expiry = webSessionExpiry(
				current.sessionMode ?? "default",
				current.authenticatedAt ?? current.createdAt,
				now,
			);
			const rotated = {
				...current,
				id: newTokenHash,
				familyId,
				createdAt: now,
				tokenStatus: "current" as const,
				lastActivityAt: now,
				expiresAt: new Date(Math.min(Date.parse(expiry.idleExpiresAt), Date.parse(current.absoluteExpiresAt ?? current.expiresAt))).toISOString(),
				idleExpiresAt: expiry.idleExpiresAt,
				absoluteExpiresAt: current.absoluteExpiresAt ?? current.expiresAt,
			} as WebSession;
			await tx.webSessions.put(rotated);
			return {
				userId: user.id,
				sessionId: rotated.id,
				createdAt: rotated.createdAt,
				expiresAt: rotated.expiresAt,
				...(rotated.recentlyVerifiedAt ? { recentlyVerifiedAt: rotated.recentlyVerifiedAt } : {}),
				...(rotated.sessionMode ? { sessionMode: rotated.sessionMode } : {}),
				...(rotated.authenticatedAt ? { authenticatedAt: rotated.authenticatedAt } : {}),
				...(rotated.lastActivityAt ? { lastActivityAt: rotated.lastActivityAt } : {}),
				...(rotated.idleExpiresAt ? { idleExpiresAt: rotated.idleExpiresAt } : {}),
				...(rotated.absoluteExpiresAt ? { absoluteExpiresAt: rotated.absoluteExpiresAt } : {}),
				...(user.displayName ? { displayName: user.displayName } : {}),
				identity: {
					platform: binding.platform,
					applicationId: binding.applicationId,
					tenantId: binding.tenantId,
					idType: binding.idType,
					externalId: binding.externalId,
				},
			};
		});
	}

	async revokeIdentity(identityBindingId: string, now: string): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const binding = await tx.identityBindings.get(identityBindingId);
			if (!binding) return;
			if (binding.status !== "revoked")
				await tx.identityBindings.put({ ...binding, status: "revoked" });
			await cancelDecisionDeliveriesIn(tx, binding.userId, "identity_revoked");
			for (const session of await tx.webSessions.all()) {
				if (session.identityBindingId === binding.id && !session.revokedAt)
					await tx.webSessions.put({ ...session, revokedAt: now });
			}
		});
	}
}
