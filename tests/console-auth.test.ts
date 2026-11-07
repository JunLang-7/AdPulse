import assert from "node:assert/strict";
import test from "node:test";
import {
	safeReturnTo,
	sessionExpiredTarget,
} from "../apps/console/src/views/auth/return-to.ts";

test("return targets keep in-console paths and reject external or ambiguous values", () => {
	assert.equal(
		safeReturnTo("/sessions?sort=recent#top"),
		"/sessions?sort=recent#top",
	);
	assert.equal(safeReturnTo("/"), "/");
	assert.equal(safeReturnTo("/tasks/../sessions"), "/sessions");
	for (const invalid of [
		"https://attacker.example/",
		"//attacker.example/",
		"///attacker.example/",
		"/\\attacker.example",
		"/%2e%2e//attacker.example",
		"javascript:alert(1)",
		"",
		undefined,
		null,
		42,
	])
		assert.equal(safeReturnTo(invalid), "/", String(invalid));
});

test("expired sessions return to the sanitized current page", () => {
	assert.equal(
		sessionExpiredTarget({
			pathname: "/sessions",
			search: "?sort=recent",
			hash: "#top",
		}),
		"/login?returnTo=%2Fsessions%3Fsort%3Drecent%23top",
	);
	assert.equal(
		sessionExpiredTarget({ pathname: "//attacker.example", search: "", hash: "" }),
		"/login?returnTo=%2F",
	);
});
