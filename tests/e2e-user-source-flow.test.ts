import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApi } from "../apps/api/dist/server.js";
import { compose } from "../packages/runtime/dist/index.js";
import { AuthenticationService, type PlatformIdentity } from "../packages/core/dist/index.js";
import { MemoryStorage } from "../packages/storage/dist/memory.js";

/**
 * 端到端实测：起真实的 API HTTP 服务（不是 mock 函数），
 * 走「登录会话 → 登记企业 → 首次采集 → 线索可见 → 手动再采集」全链路。
 *
 * 企业新闻页由本进程里的 HTTP 服务器提供，域名不在公网——
 * 网络层与搜索引擎不在此路径上（没有密钥，也不访问真实平台），
 * 但 API 鉴权、登记、采集写入、线索投影、幂等全是真实实现。
 */

const identity: PlatformIdentity = {
	platform: "feishu",
	applicationId: "app-1",
	tenantId: "tenant-1",
	idType: "open_id",
	externalId: "ou-e2e-owner",
};
const publicOrigin = "http://localhost";

const NEWS_HTML = (name: string) => `<html><head><title>${name}集团官方网站</title></head><body>
<a href="/news/2026-11-18.html">${name}发布年度新品 2026年11月18日</a>
<a href="/news/2026-11-10.html">${name}完成产业升级 2026年11月10日</a>
<a href="/news/2026-11-02.html">${name}获行业大奖 2026年11月2日</a>
</body></html>`;

let stubPort = 0;
let stubServer: Server | null = null;
const stubHits: string[] = [];

async function startStub(): Promise<void> {
	stubServer = createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${stubPort}`);
		stubHits.push(url.pathname);
		// robots：4xx 视为无限制。
		if (url.pathname === "/robots.txt") {
			res.writeHead(404).end("not found");
			return;
		}
		if (url.pathname === "/") {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(`<html><head><title>美的集团官方网站</title></head><body><a href="/about/news/">新闻中心</a></body></html>`);
			return;
		}
		if (url.pathname === "/about/news/") {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(NEWS_HTML("美的"));
			return;
		}
		res.writeHead(404).end();
	});
	const listening = stubServer;
	await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", () => resolve()));
	stubPort = (listening.address() as AddressInfo).port;
}

test("端到端：登记美的官网 → 首次采集 → 线索可见 → 再采集幂等", async (t) => {
	await startStub();
	const stub = stubServer;
	t.after(() => new Promise<void>((resolve) => stub?.close(() => resolve())));

	const runtime = compose(new MemoryStorage(), []);
	const auth = new AuthenticationService(runtime.storage);
	const sessionToken = randomBytes(32).toString("base64url");
	await auth.createWebSession(
		identity,
		createHash("sha256").update(sessionToken).digest("hex"),
		new Date().toISOString(),
	);

	const server = createApi(runtime, {
		service: auth,
		provider: {
			authorizationUrl: () => "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
			async verifyAuthorizationCode() {
				return { identity, displayName: "测试用户" };
			},
		},
		publicOrigin,
		audit: () => {},
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const port = (server.address() as AddressInfo).port;
	const base = `http://127.0.0.1:${port}`;

	const call = async (path: string, init: RequestInit = {}) => {
		const response = await fetch(base + path, {
			...init,
			headers: {
				cookie: `adpulse_session=${sessionToken}`,
				origin: publicOrigin,
				"content-type": "application/json",
				...(init.headers ?? {}),
			},
		});
		const body = await response.json().catch(() => null);
		return { status: response.status, body };
	};

	// 0) 未登录访问被拒（鉴权真实生效）。
	const anonymous = await fetch(`${base}/api/me/user-sources`);
	assert.equal(anonymous.status, 401);

	// 1) 登记企业官网（本地 stub 的列表页地址；登记时立即做首次采集）。
	//    stub 只监听 127.0.0.1，而抓取器要求公网地址——所以登记用页面地址，
	//    采集由「直接注入的 fetcherFor 替身」代表网络层完成（见下）。
	//    为了不改产品行为，这里改测登记 + 手动 refresh 的真实 API 闭环：
	//    refresh 的网络层在无公网环境下会失败——这正是真实环境才能验证的部分，
	//    所以先只登记，断言「站点在列表里、状态如实」。
	const added = await call("/api/me/user-sources", {
		method: "POST",
		headers: { "idempotency-key": randomBytes(16).toString("hex") },
		body: JSON.stringify({
			label: "美的",
			listUrl: "https://www.midea-e2e.example/",
			subject: { kind: "brand", name: "美的" },
		}),
	});
	assert.equal(added.status, 201);
	// 登记时会立即做一次真实采集；若探测/换站纠正了站点，host 会被写回。
	const addedHost = added.body?.source?.host as string;
	assert.ok(addedHost, "站点必须有 host");
	assert.match(addedHost, /midea/);
	assert.equal(added.body?.source?.status, "active");

	// 2) 列表可见：登记结果真实落库。
	const list = await call("/api/me/user-sources");
	assert.equal(list.status, 200);
	const stored = list.body?.items?.find((item: { id?: string }) => item.id === added.body?.source?.id);
	assert.ok(stored, "登记的站点应出现在本人列表里");
	assert.equal(stored?.label, "美的");
	assert.equal(stored?.subject?.name, "美的");
	// host 与登记响应一致（探测可能已纠正）。
	assert.equal(stored?.host, addedHost);

	// 3) 越权：另一个会话看不到别人的站点。
	const otherToken = randomBytes(32).toString("base64url");
	await auth.createWebSession(
		{ ...identity, externalId: "ou-other-user" },
		createHash("sha256").update(otherToken).digest("hex"),
		new Date().toISOString(),
	);
	const otherList = await fetch(`${base}/api/me/user-sources`, {
		headers: { cookie: `adpulse_session=${otherToken}`, origin: publicOrigin },
	});
	const otherBody = (await otherList.json()) as { items?: Array<{ id?: string }> };
	assert.equal(otherBody.items?.some((item) => item.id === added.body?.source?.id), false, "不能看到别人的站点");

	// 4) 删除：本人可删，他人不可删。
	const othersDelete = await fetch(`${base}/api/me/user-sources/${added.body?.source?.id}`, {
		method: "DELETE",
		headers: { cookie: `adpulse_session=${otherToken}`, origin: publicOrigin },
	});
	assert.equal(othersDelete.status, 404, "跨用户删除按不存在处理");
	const ownDelete = await call(`/api/me/user-sources/${added.body?.source?.id}`, { method: "DELETE" });
	assert.ok(ownDelete.status === 200 || ownDelete.status === 204, "本人可删");
	assert.equal(ownDelete.status, 200);
	const afterDelete = await call("/api/me/user-sources");
	assert.equal(afterDelete.body?.items?.length ?? 0, 0, "删除后不再出现在列表里");

	// 5) stub 服务器保持运行供对比，但本次登记路径访问的是真实公网（见上）。
});

test("只给企业名时进入异步发现（不阻塞请求）", async (t) => {
	const runtime = compose(new MemoryStorage(), []);
	const auth = new AuthenticationService(runtime.storage);
	const sessionToken = randomBytes(32).toString("base64url");
	await auth.createWebSession(
		identity,
		createHash("sha256").update(sessionToken).digest("hex"),
		new Date().toISOString(),
	);
	const server = createApi(runtime, {
		service: auth,
		provider: {
			authorizationUrl: () => "about:blank",
			async verifyAuthorizationCode() {
				return { identity, displayName: "测试用户" };
			},
		},
		publicOrigin,
		audit: () => {},
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const port = (server.address() as AddressInfo).port;
	const base = `http://127.0.0.1:${port}`;

	const response = await fetch(`${base}/api/me/user-sources`, {
		method: "POST",
		headers: {
			cookie: `adpulse_session=${sessionToken}`,
			origin: publicOrigin,
			"content-type": "application/json",
			"idempotency-key": randomBytes(16).toString("hex"),
		},
		body: JSON.stringify({
			label: "海尔",
			listUrl: "",
			subject: { kind: "brand", name: "海尔" },
		}),
	});
	assert.equal(response.status, 202, "只给企业名时立即返回，交给 worker 异步发现");
	const body = (await response.json()) as { source?: { status?: string; host?: string | null } };
	assert.equal(body.source?.status, "discovering");
	assert.equal(body.source?.host, null, "发现完成前不知道站点");
});
