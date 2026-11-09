import type { VerifiedIdentity } from "@adpluse/core";
import { z } from "zod";

export interface OAuthAuthorizationParameters {
	state: string;
	codeChallenge: string;
	redirectUri: string;
}

/** 登录结果：身份作用域用于唯一性与权限；displayName 仅用于界面展示。 */
export interface VerifiedLogin {
	identity: VerifiedIdentity;
	displayName?: string;
}

export interface IdentityProvider {
	authorizationUrl(parameters: OAuthAuthorizationParameters): string;
	verifyAuthorizationCode(
		code: string,
		codeVerifier: string,
		redirectUri: string,
	): Promise<VerifiedLogin>;
}

const tokenResponseSchema = z.object({
	code: z.number(),
	access_token: z.string().min(1).optional(),
});
const userInfoSchema = z.object({
	code: z.number(),
	data: z.object({
		open_id: z.string().min(1),
		tenant_key: z.string().min(1),
		// 同一响应里即带显示名，无需额外权限；缺失时界面自行降级。
		name: z.string().trim().min(1).max(200).optional(),
	}),
});

export interface FeishuAuthConfiguration {
	applicationId: string;
	applicationSecret: string;
	tenantId: string;
}

/** OAuth protocol adapter. Tokens and profile data other than scoped IDs are never persisted. */
export class FeishuIdentityProvider implements IdentityProvider {
	constructor(
		private readonly configuration: FeishuAuthConfiguration,
		private readonly fetcher: typeof fetch = fetch,
	) {}

	authorizationUrl(parameters: OAuthAuthorizationParameters): string {
		if (!/^[A-Za-z0-9_-]{43}$/.test(parameters.codeChallenge))
			throw new Error("invalid PKCE challenge");
		const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
		url.searchParams.set("client_id", this.configuration.applicationId);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("redirect_uri", parameters.redirectUri);
		url.searchParams.set("state", parameters.state);
		url.searchParams.set("code_challenge", parameters.codeChallenge);
		url.searchParams.set("code_challenge_method", "S256");
		return url.toString();
	}

	async verifyAuthorizationCode(
		code: string,
		codeVerifier: string,
		redirectUri: string,
	): Promise<VerifiedLogin> {
		if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier))
			throw new Error("invalid PKCE verifier");
		// This authorize endpoint currently supports PKCE with the v2 token endpoint.
		// https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code
		// Keep the pair explicit: never retry a consumed code against another endpoint.
		const tokenResponse = await this.fetcher(
			"https://open.feishu.cn/open-apis/authen/v2/oauth/token",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					grant_type: "authorization_code",
					client_id: this.configuration.applicationId,
					client_secret: this.configuration.applicationSecret,
					code,
					redirect_uri: redirectUri,
					code_verifier: codeVerifier,
				}),
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!tokenResponse.ok) throw new Error("identity provider unavailable");
		const token = tokenResponseSchema.safeParse(await tokenResponse.json());
		if (!token.success || token.data.code !== 0 || !token.data.access_token)
			throw new Error("identity authorization rejected");

		const userResponse = await this.fetcher(
			"https://open.feishu.cn/open-apis/authen/v1/user_info",
			{
				headers: { authorization: `Bearer ${token.data.access_token}` },
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!userResponse.ok) throw new Error("identity provider unavailable");
		const user = userInfoSchema.safeParse(await userResponse.json());
		if (!user.success || user.data.code !== 0)
			throw new Error("identity verification rejected");
		if (user.data.data.tenant_key !== this.configuration.tenantId)
			throw new Error("identity tenant not allowed");

		return {
			identity: {
				platform: "feishu",
				applicationId: this.configuration.applicationId,
				tenantId: user.data.data.tenant_key,
				idType: "open_id",
				externalId: user.data.data.open_id,
			},
			...(user.data.data.name ? { displayName: user.data.data.name } : {}),
		};
	}
}
