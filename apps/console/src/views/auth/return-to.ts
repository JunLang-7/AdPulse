const BASE = "http://adpulse.invalid";

/**
 * Mirrors the API's same-origin return-target validation. Invalid or external
 * values fall back to the console root instead of becoming navigation input.
 */
export function safeReturnTo(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("/")) return "/";
	if (value.startsWith("//") || value.includes("\\")) return "/";
	let target: URL;
	try {
		target = new URL(value, BASE);
	} catch {
		return "/";
	}
	if (target.origin !== BASE) return "/";
	const path = `${target.pathname}${target.search}${target.hash}`;
	if (
		!path.startsWith("/") ||
		path.startsWith("//") ||
		path.includes("\\")
	)
		return "/";
	return path;
}

/** Login URL used when an API call reports an expired or revoked session. */
export function sessionExpiredTarget(location: {
	pathname: string;
	search?: string;
	hash?: string;
}): string {
	const returnTo = safeReturnTo(
		`${location.pathname}${location.search ?? ""}${location.hash ?? ""}`,
	);
	return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}
