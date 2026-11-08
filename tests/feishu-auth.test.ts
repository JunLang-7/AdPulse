import test from "node:test";
import assert from "node:assert/strict";
import {
	FeishuIdentityProvider,
	type FeishuAuthConfiguration,
} from "../apps/api/dist/feishu-auth.js";

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
			codeChallenge: "challenge-value",
			redirectUri: "https://console.example.com/auth/feishu/callback",
		}),
	);
	assert.equal(url.origin, "https://accounts.feishu.cn");
	assert.equal(url.pathname, "/open-apis/authen/v1/authorize");
	assert.equal(url.searchParams.get("client_id"), configuration.applicationId);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("code_challenge"), "challenge-value");
	assert.equal(url.searchParams.get("state"), "state-value");
	assert.equal(url.searchParams.get("redirect_uri"), "https://console.example.com/auth/feishu/callback");
	assert.equal(url.toString().includes(configuration.applicationSecret), false);
});

test("authorization code is exchanged with PKCE and returns only a tenant-scoped open ID", async () => {
	const { calls, fetcher } = responder([
		{ code: 0, access_token: "short-lived-access-token", refresh_token: "never-store" },
		{ code: 0, data: { open_id: "ou-user-a", tenant_key: "tenant-a" } },
	]);
	const provider = new FeishuIdentityProvider(configuration, fetcher);
	const identity = await provider.verifyAuthorizationCode(
		"one-time-code",
		"pkce-verifier",
		"https://console.example.com/auth/feishu/callback",
	);
	assert.deepEqual(identity, {
		platform: "feishu",
		applicationId: "cli_test_app",
		tenantId: "tenant-a",
		idType: "open_id",
		externalId: "ou-user-a",
	});
	assert.equal(calls[0]?.url, "https://accounts.feishu.cn/oauth/v3/token");
	const body = JSON.parse(String(calls[0]?.init?.body));
	assert.equal(body.grant_type, "authorization_code");
	assert.equal(body.client_id, configuration.applicationId);
	assert.equal(body.client_secret, configuration.applicationSecret);
	assert.equal(body.code, "one-time-code");
	assert.equal(body.code_verifier, "pkce-verifier");
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
		provider.verifyAuthorizationCode("code", "verifier", "https://example.test/callback"),
		/tenant not allowed/,
	);

	const rejected = new FeishuIdentityProvider(configuration, responder([{ code: 999 }]).fetcher);
	await assert.rejects(
		rejected.verifyAuthorizationCode("code", "verifier", "https://example.test/callback"),
		/authorization rejected/,
	);
	const unavailable = new FeishuIdentityProvider(configuration, responder([], 503).fetcher);
	await assert.rejects(
		unavailable.verifyAuthorizationCode("code", "verifier", "https://example.test/callback"),
		/identity provider unavailable/,
	);
});
