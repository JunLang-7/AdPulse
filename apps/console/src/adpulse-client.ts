import createClient from "openapi-fetch";
import type { paths } from "./generated/api.js";

/** Console components use this generated-contract client, never hand-written fetch calls. */
export function createConsoleClient(baseUrl: string, token: string) {
	return createClient<paths>({
		baseUrl,
		headers: { authorization: `Bearer ${token}` },
	});
}
export type { components, paths } from "./generated/api.js";
