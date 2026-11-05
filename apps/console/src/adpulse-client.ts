import createClient from "openapi-fetch";
import type { paths } from "./generated/api.js";

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
const token = import.meta.env.VITE_CONSOLE_TOKEN ?? "";

if (!token) {
	console.warn(
		"VITE_CONSOLE_TOKEN is empty: console API calls will be rejected",
	);
}

/** Console components use this generated-contract client, never hand-written fetch calls. */
export const consoleClient = createClient<paths>({
	baseUrl,
	headers: { authorization: `Bearer ${token}` },
});

export function createConsoleClient(base: string, bearer: string) {
	return createClient<paths>({
		baseUrl: base,
		headers: { authorization: `Bearer ${bearer}` },
	});
}
export type { components, paths } from "./generated/api.js";
