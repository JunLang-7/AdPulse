// 模型调用的受控出网层（#86 §7）：只允许公网 HTTPS、绑定已校验地址、禁重定向、
// 限制大小与超时。测试注入 DNS 与 request，不发真实网络请求。

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Readable } from "node:stream";
import { ModelEgressError, createModelEgressFetch } from "../packages/runtime/dist/model-egress.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

type Captured = {
	options: Record<string, unknown>;
	body: string;
};

function fakeTransport(reply: { status?: number; headers?: Record<string, string>; chunks?: string[] }) {
	const captured: Captured = { options: {}, body: "" };
	const request = (options: Record<string, unknown>, callback: (response: unknown) => void) => {
		captured.options = options;
		const emitter = new EventEmitter() as EventEmitter & {
			write: (chunk: string) => void;
			end: () => void;
			setTimeout: () => void;
			destroy: (error?: Error) => void;
		};
		emitter.write = (chunk: string) => {
			captured.body += chunk;
		};
		emitter.setTimeout = () => {};
		emitter.destroy = (error?: Error) => {
			if (error) emitter.emit("error", error);
		};
		emitter.end = () => {
			const response = Readable.from((reply.chunks ?? ["data: {}\n\n"]).map((chunk) => Buffer.from(chunk)));
			Object.assign(response, {
				statusCode: reply.status ?? 200,
				statusMessage: "OK",
				headers: reply.headers ?? { "content-type": "text/event-stream" },
			});
			callback(response);
		};
		return emitter;
	};
	return { captured, request };
}

test("egress: private, loopback, metadata and mixed DNS answers are refused before any request", async () => {
	const cases = [
		async () => [{ address: "127.0.0.1", family: 4 }],
		async () => [{ address: "10.1.2.3", family: 4 }],
		async () => [{ address: "169.254.169.254", family: 4 }],
		async () => [{ address: "::1", family: 6 }],
		async () => [{ address: "fd00::1", family: 6 }],
		async () => [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.10", family: 4 }],
	];
	for (const lookup of cases) {
		let requested = false;
		const egress = createModelEgressFetch({
			lookup: lookup as never,
			request: (() => {
				requested = true;
				throw new Error("must not request");
			}) as never,
		});
		await assert.rejects(
			() => egress("https://api.example.com/v1/chat/completions", { method: "POST" }),
			(error) => error instanceof ModelEgressError && error.reason === "blocked",
		);
		assert.equal(requested, false);
	}
});

test("egress: non-HTTPS, embedded credentials and DNS failures fail closed", async () => {
	const egress = createModelEgressFetch({ lookup: publicLookup as never, request: (() => { throw new Error("unused"); }) as never });
	await assert.rejects(() => egress("http://api.example.com/v1"), (error) => error instanceof ModelEgressError && error.reason === "blocked");
	await assert.rejects(() => egress("https://user:pass@api.example.com/v1"), (error) => error instanceof ModelEgressError && error.reason === "blocked");
	await assert.rejects(() => egress("not a url"), (error) => error instanceof ModelEgressError && error.reason === "blocked");
	const broken = createModelEgressFetch({
		lookup: (async () => { throw new Error("dns down"); }) as never,
		request: (() => { throw new Error("unused"); }) as never,
	});
	await assert.rejects(() => broken("https://api.example.com/v1"), (error) => error instanceof ModelEgressError && error.reason === "network");
});

test("egress: pins the verified address, keeps Host/servername and drops redirect locations", async () => {
	const { captured, request } = fakeTransport({
		status: 302,
		headers: { location: "https://evil.example/next", "content-type": "text/plain" },
		chunks: ["redirecting"],
	});
	const egress = createModelEgressFetch({ lookup: publicLookup as never, request: request as never });
	const response = await egress("https://api.example.com/v1/chat/completions?x=1", {
		method: "POST",
		headers: { authorization: "Bearer synthetic", "content-type": "application/json", "accept-encoding": "gzip" },
		body: JSON.stringify({ model: "mimo" }),
	});
	assert.equal(response.status, 302);
	assert.equal(response.headers.get("location"), null, "redirect target must not leak to callers");
	assert.equal(await response.text(), "redirecting");
	assert.equal(captured.options.host, "93.184.216.34");
	assert.equal(captured.options.servername, "api.example.com");
	assert.equal(captured.options.path, "/v1/chat/completions?x=1");
	assert.equal(captured.options.method, "POST");
	const headers = captured.options.headers as Record<string, string>;
	assert.equal(headers.Host, "api.example.com");
	assert.equal(headers.authorization, "Bearer synthetic");
	assert.equal(headers["Accept-Encoding"], "identity", "compression must not be negotiated");
	assert.equal(headers["accept-encoding"], undefined);
	assert.deepEqual(JSON.parse(captured.body), { model: "mimo" });
});

test("egress: oversized responses are cut off and unsupported bodies are refused", async () => {
	const big = fakeTransport({ chunks: ["x".repeat(200), "y".repeat(200)] });
	const egress = createModelEgressFetch({ lookup: publicLookup as never, request: big.request as never, maxBytes: 256 });
	const response = await egress("https://api.example.com/v1", { method: "POST" });
	await assert.rejects(() => response.text(), (error) => error instanceof ModelEgressError && error.reason === "too_large");

	const streamBody = createModelEgressFetch({ lookup: publicLookup as never, request: (() => { throw new Error("unused"); }) as never });
	await assert.rejects(
		() => streamBody("https://api.example.com/v1", { method: "POST", body: new ReadableStream() }),
		(error) => error instanceof ModelEgressError && error.reason === "blocked",
	);
});

test("egress: an aborted signal destroys the request without resolving", async () => {
	const controller = new AbortController();
	controller.abort();
	const failed = createModelEgressFetch({
		lookup: publicLookup as never,
		request: ((_options: unknown, _callback: unknown) => {
			const emitter = new EventEmitter() as EventEmitter & { destroy: (error?: Error) => void; write: () => void; end: () => void; setTimeout: () => void };
			emitter.destroy = (error?: Error) => { if (error) queueMicrotask(() => emitter.emit("error", error)); };
			emitter.write = () => {};
			emitter.end = () => {};
			emitter.setTimeout = () => {};
			return emitter;
		}) as never,
	});
	await assert.rejects(
		() => failed("https://api.example.com/v1", { method: "POST", signal: controller.signal }),
		(error) => error instanceof ModelEgressError,
	);
});
