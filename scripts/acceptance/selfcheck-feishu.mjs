// 飞书只读自检（原 scripts/feishu-acceptance.mjs）。
// 全部检查为 local-real：使用真实凭据或真实平台 API，但请求由本地发起，
// 因此只能证明配置与连通一致，不能替代真机验收（#12）。
// 不发送业务消息、不写业务数据；输出已脱敏。

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { EVIDENCE } from "./checks.mjs";
import { callJson, errorReason, httpStatus } from "./http.mjs";
import { mask, maskBody, maskUrl, redactDatabaseUrl } from "./redact.mjs";
import { ROOT, gitCommit } from "./workspace.mjs";
const PLATFORM = "https://open.feishu.cn";
const CLOCK_TOLERANCE_SECONDS = 240;
const ACK_BUDGET_MS = 1_000;
const DIST = resolve(ROOT, "packages/channels/dist/index.js");

const FEISHU_HINTS = {
	10003: "app_id 与 app_secret 不匹配：核对后台应用凭证与 FEISHU_APP_ID / FEISHU_APP_SECRET",
	10014: "app_secret 不正确：重新复制应用凭证并更新本地 .env",
	99991661: "缺少 tenant_access_token：脚本内部错误，请重试",
	99991663: "tenant_access_token 无效或过期：确认应用版本已发布，重新执行本脚本",
	99991672: "应用缺少所需权限 scope：后台开通后需发布新版本并等待生效",
	230002: "群 / open_id 不存在、或收件人不在应用可用范围内",
	230013: "机器人不在该群或无发消息权限：把机器人拉进群并检查 im:message 权限",
	230020: "触发平台频控：降低频率后重试",
	41050: "缺少通讯录读取权限，可跳过该项检查",
};

const hintForCode = (code) =>
	FEISHU_HINTS[String(code)] ?? "对照飞书开放平台错误码文档定位该 code";

/** 记录里固定的手工验收项；执行方式说明当前是否需要真人操作。 */
export const MANUAL_ITEMS = [
	{
		title: "验签 / 解密 / tenant-app-token 匹配（含错配置定位）",
		mode: "真人操作 + 脚本断言",
	},
	{ title: "单聊：卡片 → 点击 → 持久化 → 处理 → 确认", mode: "真人操作" },
	{ title: "群聊：卡片 → 点击 → 持久化 → 处理 → 确认", mode: "真人操作" },
	{
		title: "落库前失败显式失败；落库后响应丢失再次点击不重复生效",
		mode: "真人操作",
	},
	{
		title: "非允许成员 / 同轮重复 / 旧卡与过期操作被拒；待发送旧卡被抑制",
		mode: "真人操作",
	},
	{
		title: "发送超时或失败与业务成功分开；重试保留 delivery.id 与去重窗口风险",
		mode: "真人操作",
	},
];

/**
 * 执行飞书只读自检。
 * @param {{
 *   env: Record<string, string | undefined>,
 *   options: { api: string, publicUrl?: string, chatId?: string, openId?: string },
 *   checks: { record: Function },
 *   now?: () => number,
 * }} context
 * @returns {Promise<{ meta: Array<[string, string]>, manualItems: typeof MANUAL_ITEMS }>}
 */
export async function runFeishuSelfCheck({ env, options, checks }) {
	const { record } = checks;
	const config = {
		accountId: env.FEISHU_ACCOUNT_ID ?? "feishu-internal",
		appId: env.FEISHU_APP_ID ?? "",
		appSecret: env.FEISHU_APP_SECRET ?? "",
		tenantKey: env.FEISHU_TENANT_KEY ?? "",
		verificationToken: env.FEISHU_VERIFICATION_TOKEN ?? "",
		encryptKey: env.FEISHU_ENCRYPT_KEY ?? "",
	};

	// ---------- 本地配置 ----------
	function checkConfig() {
		const required = [
			["FEISHU_APP_ID", config.appId],
			["FEISHU_APP_SECRET", config.appSecret],
			["FEISHU_TENANT_KEY", config.tenantKey],
			["FEISHU_VERIFICATION_TOKEN", config.verificationToken],
			["FEISHU_ENCRYPT_KEY", config.encryptKey],
		];
		const missing = required.filter(([, value]) => !value).map(([key]) => key);
		if (env.DEMO_MODE === "1")
			missing.push("DEMO_MODE=0（真机联调必须关闭演示模式）");
		if (missing.length)
			record(
				"config.feishu",
				"飞书应用配置",
				"fail",
				`缺少或无效：${missing.join(" / ")}`,
				"按 docs/development.md 第 4 节填写 .env，secret 只放本地",
			);
		else
			record(
				"config.feishu",
				"飞书应用配置",
				"ok",
				`account=${config.accountId} app=${mask(config.appId)} tenant=${mask(config.tenantKey, 4, 2)}`,
			);

		const token = env.CONSOLE_TOKEN ?? "";
		if (token.length < 24)
			record(
				"config.console",
				"控制台鉴权",
				"fail",
				"CONSOLE_TOKEN 缺失或短于 24 字符",
				"生成随机长字符串写入本地 .env",
			);
		else
			record(
				"config.console",
				"控制台鉴权",
				"ok",
				`CONSOLE_TOKEN 长度 ${token.length}，user=${env.CONSOLE_USER_ID ?? "operator"}`,
			);

		const databaseUrl = env.DATABASE_URL ?? "";
		if (!databaseUrl)
			record(
				"config.database",
				"持久化数据库",
				"fail",
				"缺少 DATABASE_URL（真机联调禁用内存存储）",
				"准备专用 PostgreSQL 并设置 DATABASE_URL",
			);
		else if (!/^postgres(ql)?:\/\//.test(databaseUrl))
			record(
				"config.database",
				"持久化数据库",
				"fail",
				`DATABASE_URL 不是 PostgreSQL 连接串：${redactDatabaseUrl(databaseUrl)}`,
				"使用 postgres:// 连接串",
			);
		else
			record(
				"config.database",
				"持久化数据库",
				"ok",
				redactDatabaseUrl(databaseUrl),
				"本检查只校验格式；连接与建表以启动日志为准",
			);
	}

	// ---------- 离线协议自检 ----------
	function seal(payload, encryptKey) {
		const iv = randomBytes(16);
		const key = createHash("sha256").update(encryptKey).digest();
		const cipher = createCipheriv("aes-256-cbc", key, iv);
		return Buffer.concat([
			iv,
			cipher.update(JSON.stringify(payload)),
			cipher.final(),
		]).toString("base64");
	}

	function signedRequest(payload, overrides = {}) {
		const timestamp =
			overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
		const nonce = overrides.nonce ?? randomBytes(8).toString("hex");
		const body = overrides.encrypt
			? { encrypt: seal(payload, config.encryptKey) }
			: payload;
		const rawBody = Buffer.from(JSON.stringify(body));
		const signature = createHash("sha256")
			.update(timestamp + nonce + config.encryptKey)
			.update(rawBody)
			.digest("hex");
		return {
			method: "POST",
			url: "/webhooks/acceptance",
			rawBody,
			headers: {
				"x-lark-request-timestamp": timestamp,
				"x-lark-request-nonce": nonce,
				"x-lark-signature": overrides.signature ?? signature,
			},
		};
	}

	function challengePayload(overrides = {}) {
		return {
			type: "url_verification",
			token: overrides.token ?? config.verificationToken,
			challenge: overrides.challenge ?? randomBytes(8).toString("hex"),
		};
	}

	function actionPayload(overrides = {}) {
		return {
			schema: "2.0",
			header: {
				event_id: overrides.eventId ?? `acceptance-${Date.now()}`,
				token: config.verificationToken,
				app_id: config.appId,
				tenant_key: overrides.tenantKey ?? config.tenantKey,
				event_type: "card.action.trigger",
			},
			event: {
				operator: {
					open_id: overrides.actor ?? "ou_acceptance_selfcheck",
					tenant_key: overrides.tenantKey ?? config.tenantKey,
				},
				action: { value: { actionRef: overrides.actionRef ?? "acceptance" } },
			},
		};
	}

	async function checkProtocol(inbound) {
		const parse = (request) => inbound.parse(request);
		const challenge = challengePayload();

		let parsed;
		try {
			parsed = await parse(signedRequest(challenge));
		} catch (error) {
			record(
				"protocol.plain",
				"明文回调验签与 challenge",
				"fail",
				`${error.message}（status=${httpStatus(error) ?? "-"}）`,
				"核对 FEISHU_ENCRYPT_KEY / FEISHU_VERIFICATION_TOKEN 与后台一致",
			);
			return;
		}
		const echo = JSON.parse(parsed.response.body).challenge;
		record(
			"protocol.plain",
			"明文回调验签与 challenge",
			echo === challenge.challenge ? "ok" : "fail",
			echo === challenge.challenge
				? "签名通过并原样返回 challenge"
				: "返回的 challenge 与请求不一致",
		);

		const encrypted = challengePayload();
		try {
			const result = await parse(signedRequest(encrypted, { encrypt: true }));
			const value = JSON.parse(result.response.body).challenge;
			record(
				"protocol.encrypted",
				"密文回调解密",
				value === encrypted.challenge ? "ok" : "fail",
				value === encrypted.challenge
					? "AES-256-CBC 解密成功"
					: "解密结果与请求不一致",
				"后台开启加密推送后必须与本地 encrypt_key 一致",
			);
		} catch (error) {
			record(
				"protocol.encrypted",
				"密文回调解密",
				"fail",
				`${error.message}（status=${httpStatus(error) ?? "-"}）`,
				"核对 FEISHU_ENCRYPT_KEY 是否与后台加密推送的 Encrypt Key 一致",
			);
		}

		// 平台校验回调地址时只发加密体、不带 x-lark-* 头，这里按同样形态复现。
		const platformChallenge = challengePayload();
		const platformRequest = signedRequest(platformChallenge, { encrypt: true });
		for (const name of [
			"x-lark-request-timestamp",
			"x-lark-request-nonce",
			"x-lark-signature",
		])
			delete platformRequest.headers[name];
		try {
			const result = await parse(platformRequest);
			const echo = JSON.parse(result.response.body).challenge;
			record(
				"protocol.challenge",
				"平台式 challenge（无签名头）",
				echo === platformChallenge.challenge ? "ok" : "fail",
				echo === platformChallenge.challenge
					? "加密体且无 x-lark-* 头时仍应答 challenge"
					: "返回的 challenge 与请求不一致",
				"这项失败会让后台保存回调地址时提示 Challenge Code 未返回",
			);
		} catch (error) {
			record(
				"protocol.challenge",
				"平台式 challenge（无签名头）",
				"fail",
				`${error.message}（status=${httpStatus(error) ?? "-"}）`,
				"平台校验回调地址时不带签名头：入站需允许已解密的 challenge 无签名",
			);
		}

		const rejections = [];
		const badSignature = signedRequest(challengePayload(), {
			signature: "0".repeat(64),
		});
		try {
			await parse(badSignature);
			rejections.push("篡改签名未被拒绝");
		} catch (error) {
			if (httpStatus(error) !== 401)
				rejections.push(`篡改签名返回 ${httpStatus(error) ?? "-"}，预期 401`);
		}
		try {
			await parse(
				signedRequest(challengePayload(), {
					timestamp: String(Math.floor(Date.now() / 1000) - 3_600),
				}),
			);
			rejections.push("过期时间戳未被拒绝");
		} catch (error) {
			if (httpStatus(error) !== 401)
				rejections.push(
					`过期时间戳返回 ${httpStatus(error) ?? "-"}，预期 401`,
				);
		}
		try {
			await parse(signedRequest(challengePayload({ token: "wrong-token" })));
			rejections.push("错误 verification token 未被拒绝");
		} catch (error) {
			if (httpStatus(error) !== 403)
				rejections.push(`错误 token 返回 ${httpStatus(error) ?? "-"}，预期 403`);
		}
		try {
			await parse(
				signedRequest(actionPayload({ tenantKey: "tenant-mismatch" }), {
					encrypt: true,
				}),
			);
			rejections.push("错误 tenant_key 未被拒绝");
		} catch (error) {
			if (httpStatus(error) !== 403)
				rejections.push(
					`错误 tenant_key 返回 ${httpStatus(error) ?? "-"}，预期 403`,
				);
		}
		record(
			"protocol.reject",
			"错配置可定位拒绝",
			rejections.length ? "fail" : "ok",
			rejections.length
				? rejections.join("；")
				: "签名/时间戳/verification token/tenant 四类错误均按预期拒绝",
		);

		const actionRef = "acceptance-selfcheck";
		try {
			const result = await parse(
				signedRequest(actionPayload({ actionRef }), { encrypt: true }),
			);
			const command = result.command ?? {};
			const ok =
				result.kind === "choice" &&
				command.actionRef === actionRef &&
				command.actor?.externalId === "ou_acceptance_selfcheck" &&
				command.sourceId === config.accountId;
			record(
				"protocol.action",
				"卡片动作归一化",
				ok ? "ok" : "fail",
				ok
					? `actionRef / actor / sourceId=${config.accountId} 归一化正确`
					: `解析结果不符合预期：kind=${result.kind}`,
			);
		} catch (error) {
			record(
				"protocol.action",
				"卡片动作归一化",
				"fail",
				`${error.message}（status=${httpStatus(error) ?? "-"}）`,
			);
		}
	}

	// ---------- 平台连通 ----------
	const call = (url, init) => callJson(url, init);

	async function checkPlatform() {
		const token = await call(
			`${PLATFORM}/open-apis/auth/v3/tenant_access_token/internal`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					app_id: config.appId,
					app_secret: config.appSecret,
				}),
			},
		);
		const dateHeader = token.response.headers.get("date");
		if (dateHeader) {
			const skew = Math.abs(Date.now() - Date.parse(dateHeader)) / 1000;
			const rounded = Math.round(skew * 10) / 10;
			record(
				"clock.skew",
				"与平台的时钟偏差",
				skew > CLOCK_TOLERANCE_SECONDS ? "fail" : skew > 120 ? "warn" : "ok",
				`${rounded}s（回调签名允许 ±300s）`,
				"偏差过大导致所有回调被 401 拒绝：校准服务器时间（NTP）",
			);
		} else {
			record(
				"clock.skew",
				"与平台的时钟偏差",
				"skip",
				"响应未返回 Date 头",
				"手动确认服务器已校时",
			);
		}

		const tokenBody = token.body ?? {};
		if (
			!token.response.ok ||
			tokenBody.code !== 0 ||
			!tokenBody.tenant_access_token
		) {
			record(
				"platform.token",
				"tenant_access_token 获取",
				"fail",
				`HTTP ${token.response.status} code=${tokenBody.code ?? "-"} msg=${tokenBody.msg ?? "-"}`,
				hintForCode(tokenBody.code),
			);
			return;
		}
		record(
			"platform.token",
			"tenant_access_token 获取",
			"ok",
			`有效期 ${tokenBody.expire ?? "-"}s（token 值不落盘、不打印）`,
		);
		const authorization = {
			authorization: `Bearer ${tokenBody.tenant_access_token}`,
		};

		const tenant = await call(`${PLATFORM}/open-apis/tenant/v2/tenant/query`, {
			headers: authorization,
		});
		// 飞书接口的成功响应存在两种层级：部分接口把业务字段放在 data 下，部分放在顶层。
		// 两种都读，避免因层级变化把正确配置误报为不匹配。
		const payloadOf = (body, key) => body?.[key] ?? body?.data?.[key];
		const tenantKey = payloadOf(tenant.body, "tenant")?.tenant_key;
		if (tenant.body?.code !== 0) {
			record(
				"platform.tenant",
				"tenant / app 匹配",
				"fail",
				`code=${tenant.body?.code ?? "-"} msg=${tenant.body?.msg ?? "-"}`,
				hintForCode(tenant.body?.code),
			);
		} else if (!tenantKey) {
			record(
				"platform.tenant",
				"tenant / app 匹配",
				"fail",
				"响应中没有 tenant_key（接口结构可能变化）",
				"手动核对 /open-apis/tenant/v2/tenant/query 的返回字段，并更新本脚本",
			);
		} else if (tenantKey !== config.tenantKey) {
			record(
				"platform.tenant",
				"tenant / app 匹配",
				"fail",
				`凭证所属租户 ${mask(tenantKey ?? "", 4, 2)} 与 FEISHU_TENANT_KEY ${mask(config.tenantKey, 4, 2)} 不一致`,
				"回调会因 header.tenant_key 不匹配被拒（403）：改用该应用所在租户的 tenant_key",
			);
		} else {
			record(
				"platform.tenant",
				"tenant / app 匹配",
				"ok",
				`应用与 tenant=${mask(config.tenantKey, 4, 2)} 一致`,
			);
		}

		const bot = await call(`${PLATFORM}/open-apis/bot/v3/info`, {
			headers: authorization,
		});
		if (bot.body?.code !== 0) {
			record(
				"platform.bot",
				"机器人可用性",
				"fail",
				`code=${bot.body?.code ?? "-"} msg=${bot.body?.msg ?? "-"}`,
				hintForCode(bot.body?.code),
			);
		} else {
			const info = payloadOf(bot.body, "bot") ?? {};
			const active = info.activate_status === 2 || info.activate_status === "2";
			record(
				"platform.bot",
				"机器人可用性",
				active ? "ok" : "warn",
				`app=${mask(info.app_name ?? "", 1, 0)} 启用状态=${info.activate_status ?? "-"} 白名单=${(info.ip_white_list ?? []).length} 项`,
				active ? "发送权限仍需真机发送验证" : "机器人未启用：后台启用应用能力后重新发布",
			);
		}

		if (options.chatId) {
			const chat = await call(
				`${PLATFORM}/open-apis/im/v1/chats/${encodeURIComponent(options.chatId)}`,
				{ headers: authorization },
			);
			const found = chat.body?.code === 0;
			record(
				"recipient.chat",
				"群聊收件人",
				found ? "ok" : "fail",
				found
					? `chat=${mask(options.chatId, 6, 4)} 存在（名称已脱敏）`
					: `code=${chat.body?.code ?? "-"} msg=${chat.body?.msg ?? "-"}`,
				found ? undefined : hintForCode(chat.body?.code),
			);
		} else {
			record(
				"recipient.chat",
				"群聊收件人",
				"skip",
				"未提供 --chat-id",
				"群聊验收前用 --chat-id 校验机器人已在群",
			);
		}

		if (options.openId) {
			const user = await call(
				`${PLATFORM}/open-apis/contact/v3/users/${encodeURIComponent(options.openId)}?user_id_type=open_id`,
				{ headers: authorization },
			);
			const code = user.body?.code;
			const found = code === 0;
			record(
				"recipient.user",
				"单聊收件人",
				found ? "ok" : code === 41050 || code === 99991672 ? "skip" : "fail",
				found
					? `open_id=${mask(options.openId, 6, 4)} 在应用可用范围内（身份信息已脱敏）`
					: `code=${code ?? "-"} msg=${user.body?.msg ?? "-"}`,
				found ? undefined : hintForCode(code),
			);
		} else {
			record(
				"recipient.user",
				"单聊收件人",
				"skip",
				"未提供 --open-id（通讯录读取需额外 scope）",
				"单聊验收前用 --open-id 或直接在客户端确认机器人可见",
			);
		}
	}

	// ---------- 本机 API 与公网回调 ----------
	async function checkLocalApi() {
		try {
			const { response, body } = await call(`${options.api}/healthz`);
			record(
				"local.api",
				"本机 API",
				response.ok && body?.ok === true ? "ok" : "warn",
				`${options.api}/healthz → HTTP ${response.status}`,
				"/healthz 只证明 HTTP 进程可响应，不代表数据库、worker 就绪",
			);
		} catch (error) {
			record(
				"local.api",
				"本机 API",
				"warn",
				`不可达（${errorReason(error)}）`,
				"先运行 bun run start，或确认 --api 地址与端口",
			);
		}
	}

	async function checkPublicWebhook() {
		if (!options.publicUrl) {
			record(
				"webhook.reachability",
				"公网回调可达",
				"skip",
				"未提供 --public-url",
				"真机验收前必须用公网地址验证反向代理保留原始请求体与签名头",
			);
			record(
				"webhook.challenge",
				"公网自签 challenge 往返",
				"skip",
				"未提供 --public-url",
			);
			return;
		}
		const unsigned = await call(options.publicUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "url_verification" }),
		}).catch((error) => ({ error }));
		if (unsigned.error) {
			record(
				"webhook.reachability",
				"公网回调可达",
				"fail",
				`无法连接（${errorReason(unsigned.error)}）`,
				"核对域名、HTTPS 证书、隧道/反代与 /webhooks/<accountId> 路径",
			);
			record(
				"webhook.challenge",
				"公网自签 challenge 往返",
				"skip",
				"公网地址不可达",
			);
			return;
		}
		// 未鉴权请求只要求被拒绝且不回 challenge：缺签名头为 401，无签名又未加密的 challenge 为 403。
		const rejected = [401, 403].includes(unsigned.response.status);
		record(
			"webhook.reachability",
			"公网回调可达",
			rejected ? "ok" : "fail",
			`无签名请求 → HTTP ${unsigned.response.status} ${maskBody(unsigned.body)}`,
			rejected
				? "未鉴权请求被拒绝且未返回 challenge，反向代理已把原始请求体送到服务端"
				: "预期被拒绝（401/403）：检查路径是否指向 /webhooks/<FEISHU_ACCOUNT_ID>，以及代理是否改写了请求体",
		);

		// 自签 challenge 只证明链路与签名逻辑一致；飞书后台触发的 challenge 仍需人工验证。
		const payload = challengePayload();
		const request = signedRequest(payload);
		const started = Date.now();
		const echo = await call(options.publicUrl, {
			method: "POST",
			headers: { "content-type": "application/json", ...request.headers },
			body: request.rawBody.toString("utf8"),
		}).catch((error) => ({ error }));
		const elapsed = Date.now() - started;
		if (echo.error) {
			record(
				"webhook.challenge",
				"公网自签 challenge 往返",
				"fail",
				`请求失败（${errorReason(echo.error)}）`,
			);
			return;
		}
		const matched =
			echo.response.ok && echo.body?.challenge === payload.challenge;
		record(
			"webhook.challenge",
			"公网自签 challenge 往返",
			matched ? (elapsed > ACK_BUDGET_MS ? "warn" : "ok") : "fail",
			`HTTP ${echo.response.status} 往返 ${elapsed}ms`,
			matched
				? elapsed > ACK_BUDGET_MS
					? `往返超过 ${ACK_BUDGET_MS}ms：回调 3 秒预算吃紧，检查代理与数据库延迟`
					: "自签请求不代表平台推送；飞书后台的 challenge 与弹卡仍需人工验证"
				: "公网链路返回 challenge 不一致：代理可能重序列化了 JSON 或改写了请求体",
		);
	}

	// ---------- 执行 ----------
	checkConfig();
	if (
		config.encryptKey &&
		config.verificationToken &&
		config.appId &&
		config.tenantKey
	) {
		if (existsSync(DIST)) {
			const { FeishuInbound } = await import(pathToFileURL(DIST).href);
			await checkProtocol(new FeishuInbound(config));
		} else {
			record(
				"protocol.dist",
				"离线协议自检",
				"skip",
				"未找到 packages/channels/dist：先执行 bun run build",
			);
		}
	} else {
		record(
			"protocol.dist",
			"离线协议自检",
			"skip",
			"飞书配置不完整，无法构造本地回调",
		);
	}
	await checkLocalApi();
	if (config.appId && config.appSecret) await checkPlatform();
	else
		record(
			"platform.token",
			"tenant_access_token 获取",
			"skip",
			"缺少 FEISHU_APP_ID / FEISHU_APP_SECRET",
		);
	await checkPublicWebhook();

	return {
		evidence: EVIDENCE.localReal,
		meta: [
			["执行时间", new Date().toISOString()],
			["环境 commit", gitCommit(ROOT)],
			["账户", config.accountId],
			["应用 app_id", mask(config.appId)],
			["租户 tenant_key", mask(config.tenantKey, 4, 2)],
			["API 地址", options.api],
			["公网回调", options.publicUrl ? maskUrl(options.publicUrl) : "(未提供)"],
			[
				"数据库",
				env.DATABASE_URL ? redactDatabaseUrl(env.DATABASE_URL) : "(未配置)",
			],
		],
		manualItems: MANUAL_ITEMS,
	};
}
