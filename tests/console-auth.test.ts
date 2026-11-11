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

test("cross-tab identity hints clear only changed identities and stop after unsubscribe", async (t) => {
	const { announceSessionIdentity, watchSessionIdentity } = await import("../apps/console/src/views/auth/session-sync.ts");
	const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const savedChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
	const events = new EventTarget();
	const stored = new Map<string, string>();
	const localStorage = {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => { stored.set(key, value); },
	};
	Object.defineProperty(globalThis, "window", { configurable: true, value: {
		localStorage,
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
	} });
	Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
	t.after(() => {
		if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (savedChannel) Object.defineProperty(globalThis, "BroadcastChannel", savedChannel);
		else Reflect.deleteProperty(globalThis, "BroadcastChannel");
	});
	let changes = 0;
	const stop = watchSessionIdentity(() => "user-a", () => { changes++; });
	const hint = (value: string) => {
		const event = new Event("storage");
		Object.defineProperties(event, {
			key: { value: "adpulse.auth.identity" }, storageArea: { value: localStorage }, newValue: { value },
		});
		events.dispatchEvent(event);
	};
	announceSessionIdentity("user-a");
	hint('"user-a"');
	hint('{malformed');
	assert.equal(changes, 0, "same-user announcements cannot cause reload loops");
	hint('"user-b"');
	assert.equal(changes, 1, "another account invalidates private content");
	hint('null');
	assert.equal(changes, 2, "logout invalidates private content in other tabs");
	stop();
	hint('"user-b"');
	assert.equal(changes, 2);
});
