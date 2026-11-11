// 组件测试的 DOM 环境：在测试文件加载前把 jsdom 挂到全局。
// 只在 `test:components` 这一条通道里生效，不影响 node --test 的纯函数与 HTTP 测试。

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	url: "http://localhost",
	// 不开 pretendToBeVisual：它的 rAF 循环会让进程不退出，node --test 就会挂住。
	pretendToBeVisual: false,
});

const win = dom.window as unknown as Window & typeof globalThis;

// React 与 testing-library 需要的最小全局集合。
const globals: Record<string, unknown> = {
	window: win,
	document: win.document,
	navigator: win.navigator,
	location: win.location,
	history: win.history,
	HTMLElement: win.HTMLElement,
	HTMLDivElement: win.HTMLDivElement,
	HTMLInputElement: win.HTMLInputElement,
	HTMLSelectElement: win.HTMLSelectElement,
	HTMLButtonElement: win.HTMLButtonElement,
	Element: win.Element,
	Node: win.Node,
	Event: win.Event,
	MouseEvent: win.MouseEvent,
	KeyboardEvent: win.KeyboardEvent,
	getComputedStyle: win.getComputedStyle.bind(win),
	requestAnimationFrame: (callback: FrameRequestCallback) =>
		setTimeout(() => callback(Date.now()), 0) as unknown as number,
	cancelAnimationFrame: (handle: number) => clearTimeout(handle),
	localStorage: win.localStorage,
	sessionStorage: win.sessionStorage,
};
for (const [key, value] of Object.entries(globals)) {
	// navigator 等在 Node 里是只读 getter，用 defineProperty 覆盖而不是赋值。
	Object.defineProperty(globalThis, key, {
		value,
		configurable: true,
		writable: true,
	});
}

// React 18+ 的并发特性在测试里需要显式标记，否则 act() 会告警。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
	true;

// openapi-fetch 用 baseUrl "" 生成相对路径（浏览器里由文档基址解析）。
// Node 的 Request 不接受相对 URL，这里补一层基址解析，保持被测代码不变。
const NativeRequest = globalThis.Request;
class BaseRelativeRequest extends NativeRequest {
	constructor(input: RequestInfo | URL, init?: RequestInit) {
		super(
			typeof input === "string" ? new URL(input, "http://localhost").toString() : input,
			init,
		);
	}
}
globalThis.Request = BaseRelativeRequest as unknown as typeof Request;
