import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebhookError } from "@adpluse/channels";
import {
	AuthenticationService,
	ComparisonConflictError,
	ComparisonValidationError,
	EvidenceConflictError,
	EvidenceValidationError,
	InvestigationAlertValidationError,
	NotificationError,
	NotificationService,
	SubscriptionError,
	SubscriptionService,
	TaskInputValidationError,
} from "@adpluse/core";
import type { Runtime } from "@adpluse/runtime";
import { ZodError } from "zod";
import type { IdentityProvider } from "./feishu-auth.js";
import { HttpError, json, readJson } from "./http.js";
import { handleAdmin } from "./routes/admin.js";
import { handleWebhook } from "./routes/webhooks.js";

const OAUTH_COOKIE = "adpulse_oauth_nonce";
const SESSION_COOKIE = "adpulse_session";
const OAUTH_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const COOKIE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** 登录/会话被拒的结构化留痕：只含原因与请求形状，不含凭据、外部标识或原始参数。 */
export type AuthAuditReason =
	| "login_request_invalid"
	| "login_transaction_invalid"
	| "identity_rejected"
	| "session_missing"
	| "session_invalid"
	| "origin_mismatch";

export interface AuthAuditEvent {
	event: "auth.reject";
	reason: AuthAuditReason;
	method: string;
	path: string;
}

/** 通知目的地/授权的操作留痕：只有动作与结果，不含 open_id 等外部标识。 */
export interface NotificationAuditEvent {
	event:
		| "notification.destination.verified"
		| "notification.consent.granted"
		| "notification.consent.revoked"
		| "subscription.settings.updated"
		| "subscription.target.added"
		| "subscription.target.updated";
	path: string;
}

export type AuditEvent = AuthAuditEvent | NotificationAuditEvent;

export interface ApiAuthentication {
	service: AuthenticationService;
	provider: IdentityProvider;
	publicOrigin: string;
	now?: () => Date;
	/**
	 * 拒绝留痕的落点。默认写一行 JSON 到 stdout，便于验收脚本与日志检索断言；
	 * 参数已裁剪为原因/方法/路径，调用方不得补充 cookie、code、state、open_id 等。
	 */
	audit?: (event: AuditEvent) => void;
}

const digest = (value: string): string =>
	createHash("sha256").update(value, "utf8").digest("hex");
const cookieValue = (header: string | undefined, name: string): string | null => {
	if (!header) return null;
	let result: string | null = null;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		if (result !== null) return null;
		result = part.slice(separator + 1).trim();
	}
	return result;
};
const sameOrigin = (origin: string | undefined, expected: string): boolean => {
	if (!origin) return false;
	try {
		const parsed = new URL(origin);
		return parsed.origin === expected && parsed.origin === origin;
	} catch {
		return false;
	}
};
const redirect = (res: import("node:http").ServerResponse, location: string) => {
	res.statusCode = 303;
	res.setHeader("location", location);
	res.setHeader("cache-control", "no-store");
	res.end();
};

function validatePublicOrigin(value: string): URL {
	let origin: URL;
	try {
		origin = new URL(value);
	} catch {
		throw new Error("PUBLIC_ORIGIN must be an absolute origin");
	}
	if (
		origin.origin !== value ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash
	)
		throw new Error("PUBLIC_ORIGIN must contain only an origin");
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
	if (origin.protocol !== "https:" && !local)
		throw new Error("PUBLIC_ORIGIN must use HTTPS outside localhost");
	return origin;
}

export function createApi(runtime: Runtime, auth: ApiAuthentication) {
	const publicOrigin = validatePublicOrigin(auth.publicOrigin);
	const notifications = new NotificationService(runtime.storage);
	const subscriptions = new SubscriptionService(runtime.storage);
	const subscriptionErrorStatus = (reason: SubscriptionError["reason"]): number => {
		switch (reason) {
			case "target_not_found":
				return 404;
			case "subscription_conflict":
			case "duplicate_target":
				return 409;
			case "invalid_schedule":
			case "invalid_target":
				return 422;
		}
	};
	const notificationErrorStatus = (reason: NotificationError["reason"]): number => {
		switch (reason) {
			case "user_unavailable":
				return 401;
			case "identity_not_verified":
				return 403;
			case "destination_not_found":
				return 404;
			case "destination_conflict":
			case "consent_not_granted":
			case "consent_conflict":
				return 409;
		}
	};
	const audit =
		auth.audit ??
		((event: AuditEvent) => {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		});
	const secureCookies = publicOrigin.protocol === "https:";
	const now = auth.now ?? (() => new Date());
	const appendCookie = (
		res: import("node:http").ServerResponse,
		name: string,
		value: string,
		maxAge: number,
	) => {
		const secure = secureCookies ? "; Secure" : "";
		res.appendHeader(
			"set-cookie",
			`${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`,
		);
	};
	const clearCookie = (
		res: import("node:http").ServerResponse,
		name: string,
	) => appendCookie(res, name, "", 0);
	const callbackUri = new URL("/auth/feishu/callback", publicOrigin).toString();

	const reject = (
		reason: AuthAuditReason,
		req: import("node:http").IncomingMessage,
		path: string,
	) =>
		// 只记录路径本身：查询串可能带 state/code，记录会把一次性凭据写进日志。
		audit({ event: "auth.reject", reason, method: req.method ?? "GET", path });

	const server = createServer(async (req, res) => {
		try {
			const requestUrl = new URL(req.url ?? "/", publicOrigin);
			const path = requestUrl.pathname;
			if (path === "/healthz" && req.method === "GET")
				return json(res, 200, { ok: true });
			const webhook = path.match(/^\/webhooks\/([^/]+)$/);
			if (webhook?.[1])
				return await handleWebhook(
					req,
					res,
					runtime,
					decodeURIComponent(webhook[1]),
					(identity) => auth.service.resolveIdentity(identity),
				);

			if (path === "/auth/feishu/login" && req.method === "GET") {
				const requested = requestUrl.searchParams.get("returnTo") ?? "/";
				const returnTo = new URL(requested, publicOrigin);
				if (
					returnTo.origin !== publicOrigin.origin ||
					requested.length > 2048 ||
					!requested.startsWith("/") ||
					requested.startsWith("//") ||
					requested.includes("\\") ||
					!returnTo.pathname.startsWith("/") ||
					returnTo.pathname.startsWith("//") ||
					returnTo.pathname.includes("\\")
				) {
					reject("login_request_invalid", req, path);
					throw new HttpError(400, "invalid return target");
				}

				const rememberMe = requestUrl.searchParams.get("rememberMe") === "1";
				const reauth = requestUrl.searchParams.get("reauth") === "1";
				let reauthSessionId: string | undefined;
				if (reauth) {
					const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
					if (!token || !COOKIE_TOKEN_PATTERN.test(token)) {
						reject("session_missing", req, path);
						throw new HttpError(401, "unauthorized");
					}
					const session = await auth.service.authenticateSession(
						digest(token),
						now().toISOString(),
					);
					if (!session) {
						reject("session_invalid", req, path);
						throw new HttpError(401, "unauthorized");
					}
					reauthSessionId = session.sessionId;
				}
				const state = randomBytes(32).toString("base64url");
				const browserNonce = randomBytes(32).toString("base64url");
				const codeVerifier = randomBytes(32).toString("base64url");
				const codeChallenge = createHash("sha256")
					.update(codeVerifier, "utf8")
					.digest("base64url");
				const createdAt = now();
				await auth.service.beginLogin({
					id: digest(state),
					browserBindingHash: digest(browserNonce),
					codeVerifier,
					returnTo: `${returnTo.pathname}${returnTo.search}${returnTo.hash}`,
					createdAt: createdAt.toISOString(),
					expiresAt: new Date(createdAt.getTime() + OAUTH_TTL_MS).toISOString(),
					rememberMe,
					...(reauth ? { purpose: "reauth" as const, reauthSessionId } : {}),
				});
				appendCookie(res, OAUTH_COOKIE, browserNonce, OAUTH_TTL_MS / 1000);
				const location = auth.provider.authorizationUrl({
					state,
					codeChallenge,
					redirectUri: callbackUri,
				});
				res.statusCode = 302;
				res.setHeader("location", location);
				res.setHeader("cache-control", "no-store");
				return res.end();
			}

			if (path === "/auth/feishu/callback" && req.method === "GET") {
				const state = requestUrl.searchParams.get("state");
				const code = requestUrl.searchParams.get("code");
				const nonce = cookieValue(req.headers.cookie, OAUTH_COOKIE);
				if (
					requestUrl.searchParams.has("error") ||
					!state ||
					state.length > 256 ||
					!code ||
					code.length > 2048 ||
					!nonce ||
					!COOKIE_TOKEN_PATTERN.test(nonce)
				) {
					reject("login_request_invalid", req, path);
					clearCookie(res, OAUTH_COOKIE);
					return redirect(res, "/login?error=authorization");
				}
				const currentTime = now();
				const transaction = await auth.service.consumeLogin(
					digest(state),
					digest(nonce),
					currentTime.toISOString(),
				);
				if (!transaction) {
					reject("login_transaction_invalid", req, path);
					clearCookie(res, OAUTH_COOKIE);
					return redirect(res, "/login?error=authorization");
				}
				let login;
				try {
					login = await auth.provider.verifyAuthorizationCode(
						code,
						transaction.codeVerifier,
						callbackUri,
					);
				} catch {
					reject("identity_rejected", req, path);
					clearCookie(res, OAUTH_COOKIE);
					return redirect(res, "/login?error=identity");
				}

				const previousToken = cookieValue(req.headers.cookie, SESSION_COOKIE);
				if (transaction.purpose === "reauth") {
					if (!previousToken || !COOKIE_TOKEN_PATTERN.test(previousToken) || digest(previousToken) !== transaction.reauthSessionId) {
						reject("session_invalid", req, path);
						clearCookie(res, OAUTH_COOKIE);
						return redirect(res, "/login?error=authorization");
					}
					const currentSession = await auth.service.authenticateSession(
						digest(previousToken),
						currentTime.toISOString(),
					);
					if (!currentSession || currentSession.userId !== (await auth.service.resolveIdentity(login.identity) ?? "")) {
						reject("identity_rejected", req, path);
						clearCookie(res, OAUTH_COOKIE);
						return redirect(res, "/login?error=identity");
					}
					const newToken = randomBytes(32).toString("base64url");
					const rotated = await auth.service.rotateWebSession(
						digest(previousToken),
						digest(newToken),
						currentTime.toISOString(),
					);
					if (!rotated) {
						reject("session_invalid", req, path);
						clearCookie(res, OAUTH_COOKIE);
						return redirect(res, "/login?error=authorization");
					}
					// Update recent verification timestamp without extending absolute expiry.
					const sessionRow = await runtime.storage.transaction((tx) => tx.webSessions.get(digest(newToken)));
					if (sessionRow) {
						await runtime.storage.transaction((tx) =>
							tx.webSessions.put({ ...sessionRow, recentlyVerifiedAt: currentTime.toISOString() }),
						);
					}
					appendCookie(
						res,
						SESSION_COOKIE,
						newToken,
						Math.max(1, Math.ceil((Date.parse(rotated.expiresAt) - currentTime.getTime()) / 1000)),
					);
					clearCookie(res, OAUTH_COOKIE);
					return redirect(res, transaction.returnTo);
				}

				// A successful account switch must not leave the previous browser session live.
				if (previousToken && COOKIE_TOKEN_PATTERN.test(previousToken))
					await auth.service.revokeSession(digest(previousToken), currentTime.toISOString());
				const sessionToken = randomBytes(32).toString("base64url");
				const sessionMode = transaction.rememberMe ? "remembered" : "default";
				const session = await auth.service.createWebSession(
					login.identity,
					digest(sessionToken),
					currentTime.toISOString(),
					login.displayName,
					sessionMode,
				);
				appendCookie(
					res,
					SESSION_COOKIE,
					sessionToken,
					Math.max(1, Math.ceil((Date.parse(session.expiresAt) - currentTime.getTime()) / 1000)),
				);
				clearCookie(res, OAUTH_COOKIE);
				return redirect(res, transaction.returnTo);
			}

			if (path.startsWith("/api/")) {
				const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
				if (!token || !COOKIE_TOKEN_PATTERN.test(token)) {
					reject("session_missing", req, path);
					throw new HttpError(401, "unauthorized");
				}
				const session = await auth.service.authenticateSession(
					digest(token),
					now().toISOString(),
				);
				if (!session) {
					reject("session_invalid", req, path);
					throw new HttpError(401, "unauthorized");
				}
				if (
					MUTATING_METHODS.has(req.method ?? "") &&
					!sameOrigin(req.headers.origin, publicOrigin.origin)
				) {
					reject("origin_mismatch", req, path);
					throw new HttpError(403, "same-origin request required");
				}
				if (path === "/api/me" && req.method === "GET")
					return json(res, 200, {
						userId: session.userId,
						sessionExpiresAt: session.expiresAt,
						...(session.displayName ? { displayName: session.displayName } : {}),
						identities: await auth.service.listIdentities(session.userId),
					});
				if (path === "/api/session/activity" && req.method === "POST") {
					const currentTime = now().toISOString();
					const current = await auth.service.authenticateSession(digest(token), currentTime);
					if (!current) {
						reject("session_invalid", req, path);
						throw new HttpError(401, "unauthorized");
					}
					const tokenAgeMs = Date.parse(currentTime) - Date.parse(current.createdAt);
					const shouldRotate = tokenAgeMs >= 24 * 60 * 60 * 1000;
					if (shouldRotate) {
						const newToken = randomBytes(32).toString("base64url");
						const rotated = await auth.service.rotateWebSession(
							digest(token),
							digest(newToken),
							currentTime,
						);
						if (rotated) {
							appendCookie(
								res,
								SESSION_COOKIE,
								newToken,
								Math.max(1, Math.ceil((Date.parse(rotated.expiresAt) - Date.parse(currentTime)) / 1000)),
							);
							return json(res, 200, { sessionExpiresAt: rotated.expiresAt });
						}
					}
					const touched = await auth.service.touchWebSession(digest(token), currentTime);
					if (!touched) {
						reject("session_invalid", req, path);
						throw new HttpError(401, "unauthorized");
					}
					appendCookie(
						res,
						SESSION_COOKIE,
						token,
						Math.max(1, Math.ceil((Date.parse(touched.expiresAt) - Date.parse(currentTime)) / 1000)),
					);
					return json(res, 200, { sessionExpiresAt: touched.expiresAt });
				}
				if (path === "/api/me/subscription" && req.method === "GET") {
					// 只返回本人配置；是否可投递由 /api/me/notification-status 决定，不在这里冒充。
					return json(res, 200, await subscriptions.view(session.userId));
				}
				if (
					path === "/api/me/subscription/settings" &&
					req.method === "PUT"
				) {
					const body = (await readJson(req).catch(() => null)) as Record<
						string,
						unknown
					> | null;
					if (
						body?.decisionCardsEnabled !== undefined &&
						typeof body.decisionCardsEnabled !== "boolean"
					)
						throw new HttpError(422, "invalid_target");
					try {
						const view = await subscriptions.updateSettings(session.userId, {
							expectedVersion: body?.expectedVersion as number,
							...(typeof body?.decisionCardsEnabled === "boolean"
								? { decisionCardsEnabled: body.decisionCardsEnabled }
								: {}),
							...(body?.proactiveEnabled === undefined
								? {}
								: { proactiveEnabled: body.proactiveEnabled as boolean }),
							...(body?.schedule === undefined
								? {}
								: { schedule: body.schedule as never }),
						});
						audit({ event: "subscription.settings.updated", path });
						return json(res, 200, view);
					} catch (error) {
						if (error instanceof SubscriptionError)
							throw new HttpError(
								subscriptionErrorStatus(error.reason),
								error.reason,
							);
						throw error;
					}
				}
				if (path === "/api/me/subscription/targets" && req.method === "POST") {
					const body = (await readJson(req).catch(() => null)) as Record<
						string,
						unknown
					> | null;
					try {
						const view = await subscriptions.addTarget(session.userId, {
							expectedVersion: body?.expectedVersion as number,
							kind: body?.kind as never,
							...(typeof body?.refId === "string" ? { refId: body.refId } : {}),
							...(typeof body?.label === "string" ? { label: body.label } : {}),
							...(typeof body?.sourceUrl === "string"
								? { sourceUrl: body.sourceUrl }
								: {}),
							categories: body?.categories,
							scope: body?.scope,
						});
						audit({ event: "subscription.target.added", path });
						return json(res, 201, view);
					} catch (error) {
						if (error instanceof SubscriptionError)
							throw new HttpError(
								subscriptionErrorStatus(error.reason),
								error.reason,
							);
						throw error;
					}
				}
				const targetMatch = /^\/api\/me\/subscription\/targets\/([0-9a-f-]{36})$/.exec(
					path,
				);
				if (targetMatch && req.method === "PATCH") {
					const body = (await readJson(req).catch(() => null)) as Record<
						string,
						unknown
					> | null;
					try {
						const view = await subscriptions.updateTarget(
							session.userId,
							targetMatch[1] as string,
							{
								expectedVersion: body?.expectedVersion as number,
								...(body?.categories === undefined
									? {}
									: { categories: body.categories }),
								...(body?.scope === undefined ? {} : { scope: body.scope }),
								...(body?.status === undefined ? {} : { status: body.status }),
							},
						);
						audit({ event: "subscription.target.updated", path });
						return json(res, 200, view);
					} catch (error) {
						if (error instanceof SubscriptionError)
							throw new HttpError(
								subscriptionErrorStatus(error.reason),
								error.reason,
							);
						throw error;
					}
				}
				if (path === "/api/me/notification-status" && req.method === "GET") {
					return json(res, 200, await notifications.status(session.userId));
				}
				if (
					path === "/api/me/notification-destination" &&
					req.method === "PUT"
				) {
					// 身份来自当前会话绑定的作用域，不接受请求体传入 externalId。
					if (!session.identity)
						throw new HttpError(403, "session has no verified identity");
					try {
						const destination = await notifications.verifyDestination(
							session.userId,
							session.identity,
						);
						audit({
							event: "notification.destination.verified",
							path,
						});
						return json(res, 200, destination);
					} catch (error) {
						if (error instanceof NotificationError)
							throw new HttpError(
								notificationErrorStatus(error.reason),
								error.reason,
							);
						throw error;
					}
				}
				if (
					path === "/api/me/notification-consent" &&
					req.method === "POST"
				) {
					const body = await readJson(req).catch(() => null);
					const parsed =
						body && typeof body === "object"
							? (body as { action?: unknown; expectedVersion?: unknown })
							: {};
					const action = parsed.action;
					const expectedVersion = parsed.expectedVersion;
					if (action !== "grant" && action !== "revoke")
						throw new HttpError(400, "invalid action");
					// 版本是必填的：没有它就无法区分「用户再次确认」与「旧请求重放」。
					if (
						typeof expectedVersion !== "number" ||
						!Number.isInteger(expectedVersion) ||
						expectedVersion < 0
					)
						throw new HttpError(400, "invalid expectedVersion");
					const status = await notifications.status(session.userId);
					if (!status.destination)
						throw new HttpError(404, "destination_not_found");
					try {
						const consent =
							action === "grant"
								? await notifications.grantConsent(
										session.userId,
										status.destination.id,
										expectedVersion,
									)
								: await notifications.revokeConsent(
										session.userId,
										status.destination.id,
										expectedVersion,
									);
						audit({
							event:
								action === "grant"
									? "notification.consent.granted"
									: "notification.consent.revoked",
							path,
						});
						return json(res, 200, consent);
					} catch (error) {
						if (error instanceof NotificationError)
							throw new HttpError(
								notificationErrorStatus(error.reason),
								error.reason,
							);
						throw error;
					}
				}
				if (path === "/api/logout" && req.method === "POST") {
					await auth.service.revokeSession(session.sessionId, now().toISOString());
					clearCookie(res, SESSION_COOKIE);
					return json(res, 200, { ok: true });
				}
				if (
					path === "/api/task-drafts/models" &&
					(req.method === "PUT" || req.method === "DELETE")
				) {
					const verifiedAt = Date.parse(
						session.recentlyVerifiedAt ?? session.authenticatedAt ?? session.createdAt,
					);
					if (
						!Number.isFinite(verifiedAt) ||
						now().getTime() - verifiedAt > 15 * 60 * 1000
					) {
						reject("session_invalid", req, path);
						throw new HttpError(401, "reauth_required");
					}
				}
				return await handleAdmin(req, res, runtime, session.userId, path, auth.service);
			}
			throw new HttpError(404, "route not found");
		} catch (error) {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			if (error instanceof HttpError || error instanceof WebhookError)
				return json(res, error.status, { error: error.message });
			if (error instanceof TaskInputValidationError)
				return json(res, 400, { error: `invalid field: ${error.fieldPath}` });
			if (
				error instanceof EvidenceConflictError ||
				error instanceof ComparisonConflictError
			)
				return json(res, 409, { error: error.message });
			if (error instanceof InvestigationAlertValidationError) {
				const status = ["comparison result not found", "task not found", "comparison evidence unavailable", "comparison task unavailable"].includes(error.message) ? 404 : 400;
				return json(res, status, { error: error.message });
			}
			if (error instanceof ComparisonValidationError) {
				const status = ["task not found", "evidence not found", "follow-up not found", "task version not found"].includes(error.message)
					? 404
					: 400;
				return json(res, status, { error: error.message });
			}
			if (error instanceof EvidenceValidationError) {
				const status = ["task not found", "evidence not found"].includes(
					error.message,
				)
					? 404
					: 400;
				return json(res, status, { error: error.message });
			}
			if (
				error instanceof Error &&
				["idempotency conflict", "task version conflict"].includes(error.message)
			)
				return json(res, 409, { error: error.message });
			if (error instanceof Error && error.message === "task not found")
				return json(res, 404, { error: "task not found" });
			if (error instanceof Error && error.message === "task strategy mismatch")
				return json(res, 400, { error: error.message });
			if (error instanceof ZodError || error instanceof URIError)
				return json(res, 400, { error: "invalid request" });
			// Persistence failure must not produce a successful platform ACK.
			json(res, 503, { error: "temporarily unavailable" });
		}
	});
	server.requestTimeout = 15_000;
	server.headersTimeout = 10_000;
	return server;
}
