import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebhookError } from "@adpluse/channels";
import {
	AuthenticationService,
	ComparisonConflictError,
	ComparisonValidationError,
	EvidenceConflictError,
	EvidenceValidationError,
	MarketEventError,
	InvestigationAlertValidationError,
	NotificationError,
	NotificationRecordError,
	NotificationRecordService,
	LifecycleDeletionService,
	NotificationSelectionService,
	DiscoveryLeadError,
	DiscoveryLeadService,
	UserSourceError,
	UserSourceService,
	SourceLeadError,
	SourceLeadService,
	SearchAggregator,
	NotificationService,
	SubscriptionError,
	SubscriptionService,
	TaskInputValidationError,
} from "@adpluse/core";
import type { Runtime } from "@adpluse/runtime";
import { agentReachReadFallback, composeInstantPush, discoverCompanySites, feishuInstantChannel, providersFromEnvironment, pushChannelGuide, pushChannelsFromEnvironment, runRealTimePush, runRealTimePushLoop, SearchQuotaExhaustedError, UserSiteFetcher } from "@adpluse/runtime";
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

/** 閻ц缍?娴兼俺鐦界悮顐ｅ珕閻ㄥ嫮绮ㄩ弸鍕閻ｆ瑧妫旈敍姘涧閸氼偄甯崶鐘辩瑢鐠囬攱鐪拌ぐ銏㈠Ц閿涘奔绗夐崥顐㈠殶閹诡喓鈧礁顦婚柈銊︾垼鐠囧棙鍨ㄩ崢鐔奉潗閸欏倹鏆熼妴?*/
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

/** 闁氨鐓￠惄顔炬畱閸?閹哄牊娼堥惃鍕惙娴ｆ粎鏆€閻ユ洩绱伴崣顏呮箒閸斻劋缍旀稉搴ｇ波閺嬫粣绱濇稉宥呮儓 open_id 缁涘顦婚柈銊︾垼鐠囧棎鈧?*/
export interface NotificationAuditEvent {
	event:
		| "notification.destination.verified"
		| "notification.consent.granted"
		| "notification.consent.revoked"
	| "notification.instant.sent"
		| "subscription.settings.updated"
		| "subscription.target.added"
		| "subscription.target.updated";
	path: string;
}

/**
 * 濡€崇€烽柊宥囩枂閻ㄥ嫭娓剁亸蹇擃吀鐠佲槄绱伴崣顏囶唶閸斻劋缍旈妴浣稿敶闁劌顕挒掳鈧胶澧楅張顑跨瑢缂佹挻鐏夋禒锝囩垳閵?
 * 娑撳秷顔囩€靛棝鎸滈妴浣哥槕閺傚洢鈧浇顕Ч鍌氥仈閵嗕浇顕Ч鍌欑秼閵嗕焦膩閸ㄥ甯弬鍥ㄥ灗娑撳﹥鐖堕柨娆掝嚖閺傚洦婀伴妴?
 */
export interface ModelAuditEvent {
	event:
		| "model.connection.created"
		| "model.connection.updated"
		| "model.connection.deleted"
		| "model.credential.replaced"
		| "model.credential.removed"
		| "model.preference.updated"
		| "model.connection.probed"
		| "model.discovery.requested"
		| "model.request.rejected";
	path: string;
	connectionId?: string;
	version?: number;
	status?: number;
	result: "ok" | "rejected" | "unavailable";
}

export type AuditEvent = AuthAuditEvent | NotificationAuditEvent | ModelAuditEvent;

export interface ApiAuthentication {
	service: AuthenticationService;
	provider: IdentityProvider;
	publicOrigin: string;
	now?: () => Date;
	/**
	 * 閹锋帞绮烽悾娆戞閻ㄥ嫯鎯ら悙骞库偓鍌炵帛鐠併倕鍟撴稉鈧悰?JSON 閸?stdout閿涘奔绌舵禍搴ㄧ崣閺€鎯板壖閺堫兛绗岄弮銉ョ箶濡偓缁便垺鏌囩懛鈧敍?
	 * 閸欏倹鏆熷鑼额梿閸擃亙璐熼崢鐔锋礈/閺傝纭?鐠侯垰绶為敍宀冪殶閻劍鏌熸稉宥呯繁鐞涖儱鍘?cookie閵嗕恭ode閵嗕够tate閵嗕狗pen_id 缁涘鈧?
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
	const notificationRecords = new NotificationRecordService(runtime.storage);
	const notificationSelections = new NotificationSelectionService(runtime.storage);
	const sourceLeads = new SourceLeadService(runtime.storage);
	const discoveryLeads = new DiscoveryLeadService(runtime.storage);
	const userSources = new UserSourceService(runtime.storage);
	// 搜索源聚合：免费源优先、付费源兑底，每源按日额度用完即停。
	const searchAggregator = new SearchAggregator(
		runtime.storage,
		providersFromEnvironment(process.env),
	);
	// 当前站点采不到内容时换站重试：同一企业常有集团站/商城站/品牌站多个入口。
	const discoverAlternates = (label: string) =>
		discoverCompanySites(label, process.env.AGENT_REACH_BIN, { aggregator: searchAggregator })
			.then((sites) => sites.map(({ host, listUrl }) => ({ host, listUrl })));
	const fetcherForHost = (host: string) => new UserSiteFetcher([host]);
	// 即时推送渠道（企微 / 钉钉 / ntfy / Bark）：与日汇总并行，用户主动触发。
	const pushChannels = pushChannelsFromEnvironment(process.env);
	const lifecycleDeletions = new LifecycleDeletionService(runtime.storage);
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
		// 閸欘亣顔囪ぐ鏇＄熅瀵板嫭婀伴煬顐窗閺屻儴顕楁稉鎻掑讲閼宠棄鐢?state/code閿涘矁顔囪ぐ鏇氱窗閹跺﹣绔村▎鈩冣偓褍鍤熼幑顔煎晸鏉╂稒妫╄箛妞尖偓?
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
						currentTime.toISOString(),
					);
					if (!rotated) {
						reject("session_invalid", req, path);
						clearCookie(res, OAUTH_COOKIE);
						return redirect(res, "/login?error=authorization");
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
						// Rotation lost the race: do not reissue the old cookie.
						const touched = await auth.service.touchWebSession(digest(token), currentTime);
						if (!touched) {
							reject("session_invalid", req, path);
							throw new HttpError(401, "unauthorized");
						}
						return json(res, 200, { sessionExpiresAt: touched.expiresAt });
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
					// 閸欘亣绻戦崶鐐存拱娴滄椽鍘ょ純顕嗙幢閺勵垰鎯侀崣顖涘闁帞鏁?/api/me/notification-status 閸愬啿鐣鹃敍灞肩瑝閸︺劏绻栭柌灞藉晪閸忓懌鈧?
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
							...(body?.sourceFeeds === undefined
								? {}
								: { sourceFeeds: body.sourceFeeds as never }),
							...(typeof body?.realTimePushEnabled === "boolean"
								? { realTimePushEnabled: body.realTimePushEnabled }
								: {}),
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
				if (path === "/api/me/source-status" && req.method === "GET") {
					// 閸欘亣绻戦崶鐐存拱娴滃搫鍑″鈧崥顖涙降濠ф劗娈戦柌鍥肠閻樿埖鈧緤绱遍張顏勭磻閸氼垰宓嗙粚鐚寸礉娑撳秵姣氶棁鎻掑弿鐏炩偓鏉╂劗娣穱鈩冧紖閵?
					return json(res, 200, { items: await sourceLeads.status(session.userId) });
				}
				if (path === "/api/me/lifecycle-deletions" && req.method === "GET") {
					// 閸欘亣顕伴敍姘拱娴滃搫鍨归梽銈堫嚞濮瑰倻娈戝〒鍛倞鏉╂稑瀹抽敍鍧nding / cleaned閿涘绱濇稉宥呮儓娑撴艾濮熷锝嗘瀮閵?
					return json(res, 200, { items: await lifecycleDeletions.list(session.userId) });
				}
				if (path === "/api/me/source-leads" && req.method === "GET") {
					const params = requestUrl.searchParams;
					const allowed = ["limit", "sourceKey"];
					if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1))
						throw new HttpError(400, "invalid_query");
					try {
						return json(res, 200, await sourceLeads.list(session.userId, {
							...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
							...(params.has("sourceKey") ? { sourceKey: params.get("sourceKey")! } : {}),
						}));
					} catch (error) {
						if (error instanceof SourceLeadError) throw new HttpError(400, error.reason);
						throw error;
					}
				}
				if (path === "/api/me/discovery-leads" && req.method === "GET") {
					const params = requestUrl.searchParams;
					const allowed = ["limit", "status"];
					if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1))
						throw new HttpError(400, "invalid_query");
					const status = params.get("status");
					if (status && !["pending", "accepted", "rejected", "kept"].includes(status))
						throw new HttpError(400, "invalid_status");
					try {
						return json(res, 200, { items: await discoveryLeads.list(session.userId, {
							...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
							...(status ? { status: status as "pending" | "accepted" | "rejected" | "kept" } : {}),
						}) });
					} catch (error) {
						if (error instanceof DiscoveryLeadError)
							throw new HttpError(error.status, error.code);
						throw error;
					}
				}
				const discoveryAction = path.match(/^\/api\/me\/discovery-leads\/([^/]+)\/(accept|reject|keep)$/);
				if (discoveryAction?.[1] && req.method === "POST") {
					const leadId = decodeURIComponent(discoveryAction[1]);
					const action = discoveryAction[2];
					const body = (await readJson(req).catch(() => null)) as Record<string, unknown> | null;
					try {
						if (action === "accept") {
							const corrected = body?.correctedPublishedAt;
							if (corrected !== undefined && corrected !== null &&
								(typeof corrected !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(corrected)))
								throw new HttpError(400, "invalid_date");
							return json(res, 200, await discoveryLeads.accept(session.userId, leadId, {
								operator: session.userId,
								...(typeof corrected === "string" ? { correctedPublishedAt: corrected } : {}),
							}, new Date().toISOString()));
						}
						if (action === "reject") {
							return json(res, 200, await discoveryLeads.reject(session.userId, leadId, {
								operator: session.userId,
								...(typeof body?.reason === "string" ? { reason: body.reason } : {}),
							}, new Date().toISOString()));
						}
						return json(res, 200, await discoveryLeads.keep(session.userId, leadId, {
							operator: session.userId,
						}, new Date().toISOString()));
					} catch (error) {
						if (error instanceof DiscoveryLeadError)
							throw new HttpError(error.status, error.code);
						throw error;
					}
				}
				if (path === "/api/me/search-providers" && req.method === "GET")
					return json(res, 200, { items: await searchAggregator.quotas() });
				if (path === "/api/me/push-channels" && req.method === "GET") {
					// 目前只做飞书：其他渠道（企微/钉钉/ntfy/Bark）未接入，不展示、不宣传。
					const status = await notifications.status(session.userId);
					const feishu = feishuInstantChannel({
						appId: process.env.FEISHU_APP_ID,
						appSecret: process.env.FEISHU_APP_SECRET,
						receiveId: status.destination?.status === "verified" ? status.destination.externalId : undefined,
					});
					return json(res, 200, {
						items: [feishu].map((channel) => ({
							channel: channel.channel,
							label: channel.label,
							configured: channel.configured,
							guide: channel.configured ? null : pushChannelGuide(channel.channel),
						})),
					});
				}
				if (path === "/api/me/notifications/push-now" && req.method === "POST") {
					// 即时推送：只取本人已确认（依据齐备）的事件摘要，不需等汇总时间。只走飞书。
					const status = await notifications.status(session.userId);
					const feishu = feishuInstantChannel({
						appId: process.env.FEISHU_APP_ID,
						appSecret: process.env.FEISHU_APP_SECRET,
						receiveId: status.destination?.status === "verified" ? status.destination.externalId : undefined,
					});
					const enabled = [feishu].filter((channel) => channel.configured);
					if (enabled.length === 0)
						throw new HttpError(409, "no_push_channel_configured");
					const versions = (await runtime.marketEvents.list(session.userId)).filter(
						(item) => item.candidate.status === "evidence_ready",
					);
					const view = await subscriptions.view(session.userId);
					const message = composeInstantPush({
						eventTitles: versions.map((item) => item.input.title),
						taskCount: new Set(versions.flatMap((item) => item.input.taskRefs.map((ref) => ref.taskId))).size,
						now: new Date(),
					});
					const results = [];
					for (const channel of enabled) results.push(await channel.send(message));
					const sent = results.filter((item) => item.status === "ok").length;
					audit({ event: "notification.instant.sent", path });
					return json(res, sent > 0 ? 200 : 502, {
						sent,
						results,
						eventCount: versions.length,
						targetCount: view.targets.length,
					});
				}
				if (path === "/api/me/user-sources" && req.method === "GET")
					return json(res, 200, { items: await userSources.list(session.userId) });
				if (path === "/api/me/user-sources" && req.method === "POST") {
					const body = (await readJson(req).catch(() => null)) as Record<
						string,
						unknown
					> | null;
					const subject = body?.subject as
						| { kind?: unknown; name?: unknown }
						| undefined;
					try {
						const label = String(body?.label ?? "");
						const listUrl = String(body?.listUrl ?? "");
						const subjectInput = {
							kind: subject?.kind === "competitor" ? "competitor" as const : "brand" as const,
							name: String(subject?.name ?? ""),
						};
						// 只给企业名：不再同步发现（可能 80 秒），登记后交给 worker 查找官网。
						if (!listUrl.trim()) {
							const source = await userSources.beginDiscovery(
								session.userId,
								{ label, subject: subjectInput },
								new Date().toISOString(),
							);
							return json(res, 202, { source });
						}						const source = await userSources.add(
							session.userId,
							{
								label,
								listUrl,
								subject: subjectInput,
							},
							new Date().toISOString(),
						);
						const addedHost = source.host;
						// 濞ｈ濮為崥搴ｇ彌閸楁娊鍣伴梿鍡曠濞嗏槄绱辨径杈Е娑撳秴濂栭崫宥囨鐠佺増鍨氶崝鐕傜礉閻樿埖鈧礁婀弶锛勬窗娑撳﹤褰茬憴浣碘偓?
						try {
							await userSources.refresh(
								session.userId,
								source.id,
								new UserSiteFetcher([addedHost ?? ""]),
								new Date().toISOString(),
								{
									readFallback: agentReachReadFallback(process.env.AGENT_REACH_BIN),
									searchFallback: async (query) => (await searchAggregator.search(query)).hits,
									discoverSites: discoverAlternates,
									fetcherFor: fetcherForHost,
								},
							);
						} catch {
							// 閸掗攱鏌婃径杈Е閸欘亣顔囪ぐ鏇炴躬閺夈儲绨稉濠忕幢閻劍鍩涢崣顖涘閸斻劑鍣哥拠鏇樷偓?
						}
						const items = await userSources.list(session.userId);
						return json(res, 201, { source: items.find((s) => s.id === source.id) ?? source });
					} catch (error) {
						if (error instanceof UserSourceError)
							throw new HttpError(error.status, error.code);
						throw error;
					}
				}
				const userSourceAction = path.match(
					/^\/api\/me\/user-sources\/([^/]+)(\/refresh)?$/,
				);
				if (userSourceAction?.[1]) {
					const sourceId = decodeURIComponent(userSourceAction[1]);
					if (userSourceAction[2] && req.method === "POST") {
						try {
							const target = (await userSources.list(session.userId)).find(
								(s) => s.id === sourceId,
							);
							if (!target) throw new HttpError(404, "not_found");
							if (!target.host || !target.listUrl)
								throw new HttpError(409, "source_not_ready");
							const result = await userSources.refresh(
								session.userId,
								sourceId,
								new UserSiteFetcher([target.host]),
								new Date().toISOString(),
								{
									readFallback: agentReachReadFallback(process.env.AGENT_REACH_BIN),
									searchFallback: async (query) => (await searchAggregator.search(query)).hits,
									discoverSites: discoverAlternates,
									fetcherFor: fetcherForHost,
								},
							);
							return json(res, 200, result);
						} catch (error) {
							if (error instanceof UserSourceError)
								throw new HttpError(error.status, error.code);
							throw error;
						}
					}
					if (!userSourceAction[2] && req.method === "DELETE") {
						try {
							await userSources.remove(session.userId, sourceId);
							return json(res, 200, { ok: true });
						} catch (error) {
							if (error instanceof UserSourceError)
								throw new HttpError(error.status, error.code);
							throw error;
						}
					}
				}
				if (path === "/api/me/notification-selections" && req.method === "GET") {
					const params = requestUrl.searchParams;
					const allowed = ["limit", "before", "taskId", "dateFrom", "dateTo", "outcome"];
					if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1))
						throw new HttpError(400, "invalid_query");
					try {
						return json(res, 200, await notificationSelections.list(session.userId, {
							...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
							...(params.has("before") ? { before: params.get("before")! } : {}),
							...(params.has("taskId") ? { taskId: params.get("taskId")! } : {}),
							...(params.has("dateFrom") ? { dateFrom: params.get("dateFrom")! } : {}),
							...(params.has("dateTo") ? { dateTo: params.get("dateTo")! } : {}),
							...(params.has("outcome") ? { outcome: params.get("outcome")! } : {}),
						}));
					} catch (error) {
						if (error instanceof NotificationRecordError) throw new HttpError(400, error.reason);
						throw error;
					}
				}
				if (path === "/api/me/notifications" && req.method === "GET") {
					// 閸欘亣顕伴幎鏇炲閿涙碍婀版禍鐑樺濞?閺夛紕娲?閹舵洟鈧帒娲栭幍褋鈧倷绗夐幐?id 閻╂潙褰囬敍宀冩硶閻劍鍩涢弮鐘插弳閸欙絻鈧?
					const limitParam = requestUrl.searchParams.get("limit");
					const before = requestUrl.searchParams.get("before") ?? undefined;
					let limit: number | undefined;
					if (limitParam !== null) {
						const parsed = Number(limitParam);
						if (!Number.isInteger(parsed))
							throw new HttpError(400, "invalid_query");
						limit = parsed;
					}
					try {
						return json(
							res,
							200,
							await notificationRecords.list(session.userId, {
								...(limit === undefined ? {} : { limit }),
								...(before === undefined ? {} : { before }),
							}),
						);
					} catch (error) {
						if (error instanceof NotificationRecordError)
							throw new HttpError(400, error.reason);
						throw error;
					}
				}
				if (
					path === "/api/me/notification-destination" &&
					req.method === "PUT"
				) {
					// 闊偂鍞ら弶銉ㄥ殰瑜版挸澧犳导姘崇樈缂佹垵鐣鹃惃鍕稊閻劌鐓欓敍灞肩瑝閹恒儱褰堢拠閿嬬湴娴ｆ挷绱堕崗?externalId閵?
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
					// 閻楀牊婀伴弰顖氱箑婵夘偆娈戦敍姘梾閺堝鐣犵亸杈ㄦ￥濞夋洖灏崚鍡愨偓宀€鏁ら幋宄板晙濞嗭紕鈥樼拋銈冣偓宥勭瑢閵嗗本妫拠閿嬬湴闁插秵鏂侀妴宥冣偓?
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
					((req.method === "PUT" || req.method === "DELETE") && path === "/api/task-drafts/models") ||
					(req.method === "POST" && path === "/api/task-drafts/models/test") ||
					(req.method === "POST" && (
						["/api/me/model-connections", "/api/me/model-connections/test", "/api/me/model-connections/models"].includes(path) ||
						/^\/api\/me\/model-connections\/[0-9a-f-]{36}\/test$/.test(path)
					)) ||
					((req.method === "PUT" || req.method === "DELETE") &&
						(/^\/api\/me\/model-connections\/[0-9a-f-]{36}(?:\/credential)?$/.test(path) ||
							path === "/api/me/model-preferences"))
				) {
					const verifiedAt = Date.parse(
						session.recentlyVerifiedAt ?? session.authenticatedAt ?? session.createdAt,
					);
					if (
						!Number.isFinite(verifiedAt) ||
						now().getTime() - verifiedAt > 15 * 60 * 1000
					) {
						reject("session_invalid", req, path);
						res.setHeader("Cache-Control", "no-store");
						throw new HttpError(401, "reauth_required");
					}
				}
				return await handleAdmin(req, res, runtime, session.userId, path, auth.service, audit);
			}
			throw new HttpError(404, "route not found");
		} catch (error) {
			// 濡€崇€烽柊宥囩枂閻ㄥ嫬銇戠拹銉ょ瘍鐟曚焦婀侀張鈧亸蹇擃吀鐠佲槄绱伴崣顏囶唶娑撳秴鎯堥弻銉嚄娑撹尙娈戠捄顖氱窞娑撳海濮搁幀浣虹垳閿?
			// 娑撳秷顔囬柨娆掝嚖濮濓絾鏋冮妴浣风瑐濞撳憡鏋冮張顒佸灗娴犺缍嶆稉鈧▎鈩冣偓褍鍤熼幑顔衡偓?
			const rejectedPath = (req.url ?? "/").split("?")[0] ?? "/";
			if (rejectedPath.startsWith("/api/me/model-connections") ||
				rejectedPath === "/api/me/model-preferences")
				audit({
					event: "model.request.rejected",
					path: rejectedPath,
					result: "rejected",
					status: error instanceof HttpError ? error.status : 500,
				});
			if (res.headersSent) {
				res.destroy();
				return;
			}
			if (error instanceof HttpError || error instanceof WebhookError)
				return json(res, error.status, { error: error.message });
			if (error instanceof MarketEventError)
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
