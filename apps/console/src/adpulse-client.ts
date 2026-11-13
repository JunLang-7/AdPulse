import createClient from "openapi-fetch";
import { sessionExpiredTarget } from "./views/auth/return-to";
import type { paths } from "./generated/api.js";

/** Console components use the same-origin generated client and opaque session cookie. */
export const consoleClient = createClient<paths>({ baseUrl: "" });

consoleClient.use({
	async onResponse({ request, response }) {
		if (response.status !== 401 || typeof window === "undefined") return;
		const path = new URL(request.url, window.location.origin).pathname;
		// The login gate and explicit logout handle their own 401 responses.
		if (path === "/api/me" || path === "/api/logout") return;
		if (path.startsWith("/api/me/model-") || path.startsWith("/api/task-drafts/models")) {
			const body: unknown = await response.clone().json().catch(() => undefined);
			if (typeof body === "object" && body !== null && "error" in body && body.error === "reauth_required") return;
		}
		if (window.location.pathname === "/login") return;
		window.location.assign(sessionExpiredTarget(window.location));
	},
});
export type { components, paths } from "./generated/api.js";
