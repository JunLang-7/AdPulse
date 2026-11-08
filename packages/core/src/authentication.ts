import { timingSafeEqual } from "node:crypto";
import type { IdentityBinding, LoginTransaction } from "./state/model.js";
import type { PlatformIdentity } from "./ports/channel.js";
import type { Storage, Transaction } from "./ports/storage.js";

export const MAX_WEB_SESSION_MS = 8 * 60 * 60 * 1000;

/** Platform-neutral identity contract shared by login and inbound channels. */
export type VerifiedIdentity = PlatformIdentity;

export interface NewLoginTransaction {
	id: string;
	browserBindingHash: string;
	codeVerifier: string;
	returnTo: string;
	createdAt: string;
	expiresAt: string;
}

export interface AuthenticatedSession {
	userId: string;
	sessionId: string;
	createdAt: string;
	expiresAt: string;
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
			expiresAt <= createdAt
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
					} else {
						userId = crypto.randomUUID();
						binding = {
							id: crypto.randomUUID(),
							...identity,
							userId,
							status: "active",
							verifiedAt: now,
						};
						await tx.users.put({ id: userId, status: "active", createdAt: now });
						await tx.identityBindings.put(binding);
					}
					const session: AuthenticatedSession = {
						userId,
						sessionId: sessionTokenHash,
						createdAt: now,
						expiresAt: new Date(Date.parse(now) + MAX_WEB_SESSION_MS).toISOString(),
					};
					await tx.webSessions.put({
						id: sessionTokenHash,
						userId,
						identityBindingId: binding.id,
						createdAt: session.createdAt,
						expiresAt: session.expiresAt,
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
			};
		});
	}

	async revokeSession(sessionTokenHash: string, now: string): Promise<void> {
		if (!digestPattern.test(sessionTokenHash)) return;
		await this.storage.transaction(async (tx) => {
			const session = await tx.webSessions.get(sessionTokenHash);
			if (session && !session.revokedAt)
				await tx.webSessions.put({ ...session, revokedAt: now });
		});
	}

	async revokeIdentity(identityBindingId: string, now: string): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const binding = await tx.identityBindings.get(identityBindingId);
			if (!binding) return;
			if (binding.status !== "revoked")
				await tx.identityBindings.put({ ...binding, status: "revoked" });
			for (const session of await tx.webSessions.all()) {
				if (session.identityBindingId === binding.id && !session.revokedAt)
					await tx.webSessions.put({ ...session, revokedAt: now });
			}
		});
	}
}
