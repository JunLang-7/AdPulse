import test from "node:test";
import assert from "node:assert/strict";
import {
	FeishuIdentityProvider,
	type FeishuAuthConfiguration,
} from "../apps/api/dist/feishu-auth.js";

// RFC 7636 Appendix B vector, not a real user's authorization credential.
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const configuration: FeishuAuthConfiguration = {
	applicationId: "cli_test_app",
	applicationSecret: "test-secret",
	tenantId: "tenant-a",
};

function responder(payloads: unknown[], status = 200) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), ...(init ? { init } : {}) });
		const payload = payloads.shift();
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, fetcher };
}

test("authorization URL uses Feishu OAuth and S256 PKCE without leaking app secret", () => {
	const provider = new FeishuIdentityProvider(configuration);
	const url = new URL(
		provider.authorizationUrl({
			state: "state-value",
			codeChallenge: challenge,
			redirectUri: "https://console.example.com/auth/feishu/callback",
		}),
	);
	assert.equal(url.origin, "https://accounts.feishu.cn");
	assert.equal(url.pathname, "/open-apis/authen/v1/authorize");
	assert.equal(url.searchParams.get("client_id"), configuration.applicationId);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("code_challenge"), challenge);
	assert.equal(url.searchParams.get("state"), "state-value");
	assert.equal(url.searchParams.get("redirect_uri"), "https://console.example.com/auth/feishu/callback");
	assert.equal(url.toString().includes(configuration.applicationSecret), false);
});

test("authorization code is exchanged with PKCE and returns only a tenant-scoped open ID", async () => {
	const { calls, fetcher } = responder([
		{ code: 0, access_token: "short-lived-access-token", refresh_token: "never-store" },
		{ code: 0, data: { open_id: "ou-user-a", tenant_key: "tenant-a", name: "小明" } },
	]);
	const provider = new FeishuIdentityProvider(configuration, fetcher);
	const login = await provider.verifyAuthorizationCode(
		"one-time-code",
		verifier,
		"https://console.example.com/auth/feishu/callback",
	);
	assert.deepEqual(login.identity, {
		platform: "feishu",
		applicationId: "cli_test_app",
		tenantId: "tenant-a",
		idType: "open_id",
		externalId: "ou-user-a",
	});
	// 同一响应里的显示名只用于界面，不进入身份作用域。
	assert.equal(login.displayName, "小明");
	assert.equal(calls[0]?.url, "https://open.feishu.cn/open-apis/authen/v2/oauth/token");
	const body = JSON.parse(String(calls[0]?.init?.body));
	assert.equal(body.grant_type, "authorization_code");
	assert.equal(body.client_id, configuration.applicationId);
	assert.equal(body.client_secret, configuration.applicationSecret);
	assert.equal(body.code, "one-time-code");
	assert.equal(body.code_verifier, verifier);
	assert.equal(body.redirect_uri, "https://console.example.com/auth/feishu/callback");
	assert.equal(calls[1]?.url, "https://open.feishu.cn/open-apis/authen/v1/user_info");
	assert.equal(calls[1]?.init?.headers && new Headers(calls[1].init?.headers).get("authorization"), "Bearer short-lived-access-token");
});

test("tenant mismatch, provider rejection, and transport failure never produce an identity", async () => {
	const mismatch = responder([
		{ code: 0, access_token: "access" },
		{ code: 0, data: { open_id: "ou-other", tenant_key: "tenant-b" } },
	]);
	const provider = new FeishuIdentityProvider(configuration, mismatch.fetcher);
	await assert.rejects(
		provider.verifyAuthorizationCode("code", verifier, "https://example.test/callback"),
		/tenant not allowed/,
	);

	const rejected = new FeishuIdentityProvider(configuration, responder([{ code: 999 }]).fetcher);
	await assert.rejects(
		rejected.verifyAuthorizationCode("code", verifier, "https://example.test/callback"),
		/authorization rejected/,
	);
	const unavailable = new FeishuIdentityProvider(configuration, responder([], 503).fetcher);
	await assert.rejects(
		unavailable.verifyAuthorizationCode("code", verifier, "https://example.test/callback"),
		/identity provider unavailable/,
	);
});


test("PKCE must be present and valid before starting authorization or exchanging a code", async () => {
	const { calls, fetcher } = responder([]);
	const provider = new FeishuIdentityProvider(configuration, fetcher);
	for (const invalid of ["", "short", "a".repeat(44), "!".repeat(43)])
		assert.throws(() => provider.authorizationUrl({
			state: "state", codeChallenge: invalid, redirectUri: "https://example.test/callback",
		}), /invalid PKCE challenge/);
	for (const invalid of ["", "short", "a".repeat(129), "!".repeat(43)])
		await assert.rejects(provider.verifyAuthorizationCode("code", invalid, "https://example.test/callback"), /invalid PKCE verifier/);
	assert.equal(calls.length, 0, "invalid PKCE must never reach a token endpoint");
});

test("a rejected code is not retried against a different token endpoint", async () => {
	const { calls, fetcher } = responder([{ code: 20049, error: "invalid_grant" }], 400);
	const provider = new FeishuIdentityProvider(configuration, fetcher);
	await assert.rejects(provider.verifyAuthorizationCode("one-time-code", verifier, "https://example.test/callback"));
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.url, "https://open.feishu.cn/open-apis/authen/v2/oauth/token");
});
