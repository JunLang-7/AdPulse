import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebhookError } from "@adpluse/channels";
import { AuthenticationService, TaskInputValidationError } from "@adpluse/core";
import type { Runtime } from "@adpluse/runtime";
import { ZodError } from "zod";
import type { IdentityProvider } from "./feishu-auth.js";
import { HttpError, json } from "./http.js";
import { handleAdmin } from "./routes/admin.js";
import { handleWebhook } from "./routes/webhooks.js";

const OAUTH_COOKIE = "adpulse_oauth_nonce";
const SESSION_COOKIE = "adpulse_session";
const OAUTH_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const COOKIE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export interface ApiAuthentication {
	service: AuthenticationService;
	provider: IdentityProvider;
	publicOrigin: string;
	now?: () => Date;
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
				)
					throw new HttpError(400, "invalid return target");

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
					clearCookie(res, OAUTH_COOKIE);
					return redirect(res, "/login?error=authorization");
				}
				let identity;
				try {
					identity = await auth.provider.verifyAuthorizationCode(
						code,
						transaction.codeVerifier,
						callbackUri,
					);
				} catch {
					clearCookie(res, OAUTH_COOKIE);
					return redirect(res, "/login?error=identity");
				}

				// A successful account switch must not leave the previous browser session live.
				const previousToken = cookieValue(req.headers.cookie, SESSION_COOKIE);
				if (previousToken && COOKIE_TOKEN_PATTERN.test(previousToken))
					await auth.service.revokeSession(digest(previousToken), currentTime.toISOString());
				const sessionToken = randomBytes(32).toString("base64url");
				await auth.service.createWebSession(
					identity,
					digest(sessionToken),
					currentTime.toISOString(),
				);
				appendCookie(res, SESSION_COOKIE, sessionToken, SESSION_TTL_SECONDS);
				clearCookie(res, OAUTH_COOKIE);
				return redirect(res, transaction.returnTo);
			}

			if (path.startsWith("/api/")) {
				const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
				if (!token || !COOKIE_TOKEN_PATTERN.test(token))
					throw new HttpError(401, "unauthorized");
				const session = await auth.service.authenticateSession(
					digest(token),
					now().toISOString(),
				);
				if (!session) throw new HttpError(401, "unauthorized");
				if (
					MUTATING_METHODS.has(req.method ?? "") &&
					!sameOrigin(req.headers.origin, publicOrigin.origin)
				)
					throw new HttpError(403, "same-origin request required");
				if (path === "/api/me" && req.method === "GET")
					return json(res, 200, {
						userId: session.userId,
						sessionExpiresAt: session.expiresAt,
					});
				if (path === "/api/logout" && req.method === "POST") {
					await auth.service.revokeSession(session.sessionId, now().toISOString());
					clearCookie(res, SESSION_COOKIE);
					return json(res, 200, { ok: true });
				}
				return await handleAdmin(req, res, runtime, session.userId, path);
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
