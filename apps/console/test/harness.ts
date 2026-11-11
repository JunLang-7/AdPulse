// 请求桩：必须在被测页面模块求值前安装（openapi-fetch 在 createClient 时捕获 fetch）。
// 因此测试文件里要把它放在第一个 import。

type Handler = (request: Request) => Response | Promise<Response>;

let handler: Handler = () => {
	throw new Error("fetch handler not configured");
};

// 顶层安装：本模块被 import 时立即替换，早于页面模块创建 client。
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const request =
		input instanceof Request ? input : new Request(input as string, init);
	return Promise.resolve(handler(request));
}) as typeof fetch;

export const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/**
 * 只拦截用例关心的请求，其余走默认成功返回；记录调用序列以便断言「没有发请求」。
 */
export function serve(
	defaults: Record<string, Handler>,
	overrides: Record<string, Handler> = {},
): { calls: string[] } {
	const routes: Record<string, Handler> = { ...defaults, ...overrides };
	const calls: string[] = [];
	handler = (request) => {
		const key = `${request.method} ${new URL(request.url).pathname}`;
		calls.push(key);
		const route = routes[key];
		if (!route) throw new Error(`unexpected request: ${key}`);
		return route(request);
	};
	return { calls };
}
