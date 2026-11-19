// 主题三态与「跟随系统」的回归测试：
// 1) 系统偏好变化时（不刷新页面）要实时跟随；
// 2) 头部按钮点一次换一态：浅色 → 深色 → 跟随系统；
// 3) 手动态不能被系统变化覆盖，回到「跟随系统」后又能继续跟随；
// 4) 连点/连按 Enter 不能丢态，被跳过的过渡不留未处理的 AbortError；
// 5) 过渡截「新快照」时根元素已换好配色（不靠 React effect 补）。

import assert from "node:assert/strict";
import test from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../src/context/shadcntheme/ThemeContext.tsx";
import LightDark from "../src/layouts/full/vertical/header/Light-Dark.tsx";

type MediaListener = (event: { matches: boolean }) => void;

// jsdom 没有 matchMedia，这里装一个可手动改变系统偏好的桩。
function installMatchMedia(initialDark: boolean) {
	const listeners = new Set<MediaListener>();
	const state = { matches: initialDark };
	const media = {
		media: "(prefers-color-scheme: dark)",
		onchange: null,
		get matches() {
			return state.matches;
		},
		addEventListener: (_type: string, listener: MediaListener) => {
			listeners.add(listener);
		},
		removeEventListener: (_type: string, listener: MediaListener) => {
			listeners.delete(listener);
		},
		dispatchEvent: () => true,
	};

	const target = window as unknown as Record<string, unknown>;
	target.matchMedia = () => media;

	return {
		listenerCount: () => listeners.size,
		setDark(dark: boolean) {
			state.matches = dark;
			for (const listener of [...listeners]) listener({ matches: dark });
		},
		restore() {
			delete target.matchMedia;
		},
	};
}

const mount = (storageKey: string) =>
	render(
		<ThemeProvider defaultTheme="system" storageKey={storageKey}>
			<LightDark />
		</ThemeProvider>,
	);

const rootClass = () => Array.from(document.documentElement.classList).sort().join(" ");

const waitForRootClass = (expected: string, message: string) =>
	waitFor(() => {
		if (rootClass() !== expected) {
			throw new Error(`${message}：期望 ${expected}，实际 "${rootClass()}"`);
		}
	});

test("跟随系统：系统切到深色时实时生效，不需要刷新", async t => {
	const media = installMatchMedia(false);
	t.after(() => {
		cleanup();
		media.restore();
		localStorage.clear();
	});

	mount("theme-test-system-follow");

	const toggle = await screen.findByRole("button", { name: /主题：跟随系统/ });
	await waitForRootClass("light", "首帧按系统偏好选浅色");

	act(() => media.setDark(true));
	await waitForRootClass("dark", "系统变深色后页面跟着变");

	act(() => media.setDark(false));
	await waitForRootClass("light", "系统变回浅色后页面也回来");

	assert.equal(toggle.getAttribute("data-theme-mode"), "system");
	assert.equal(localStorage.getItem("theme-test-system-follow"), null, "仅浏览不改写用户选择");
});

test("手动态不被系统变化覆盖，写回「跟随系统」后恢复跟踪", async t => {
	const media = installMatchMedia(false);
	t.after(() => {
		cleanup();
		media.restore();
		localStorage.clear();
	});

	mount("theme-test-manual");

	const toggle = await screen.findByRole("button", { name: /主题：跟随系统/ });
	await waitFor(() => assert.equal(rootClass(), "light"));

	// 点击一次：跟随系统 → 浅色（显式选定，监听器应被移除）
	fireEvent.click(toggle);
	await waitFor(() => assert.equal(localStorage.getItem("theme-test-manual"), "light"));
	await waitFor(() => assert.equal(rootClass(), "light"));
	assert.equal(media.listenerCount(), 0, "手动态不再订阅系统变化");

	act(() => media.setDark(true));
	assert.equal(rootClass(), "light", "手动浅色不被系统深色覆盖");

	// 点第二次：浅色 → 深色
	fireEvent.click(screen.getByRole("button", { name: /主题：浅色/ }));
	await waitFor(() => assert.equal(localStorage.getItem("theme-test-manual"), "dark"));
	await waitFor(() => assert.equal(rootClass(), "dark"));

	// 点第三次：深色 → 跟随系统
	fireEvent.click(screen.getByRole("button", { name: /主题：深色/ }));
	await waitFor(() => assert.equal(localStorage.getItem("theme-test-manual"), "system"));
	await waitForRootClass("dark", "系统当前是深色，跟随系统后跟随");
	assert.equal(media.listenerCount(), 1, "回到跟随系统后重新订阅");

	act(() => media.setDark(false));
	await waitFor(() => assert.equal(rootClass(), "light"));
});

test("重新加载时沿用已保存的手动态", async t => {
	const media = installMatchMedia(true);
	t.after(() => {
		cleanup();
		media.restore();
		localStorage.clear();
	});

	localStorage.setItem("theme-test-reload", "light");

	mount("theme-test-reload");

	const toggle = await screen.findByRole("button", { name: /主题：浅色/ });
	await waitForRootClass("light", "存的是浅色，即使系统是深色也用浅色");
	assert.equal(toggle.getAttribute("data-theme-mode"), "light");
	assert.equal(media.listenerCount(), 0);
});

type TransitionRecord = { ready: Promise<unknown>; finished: Promise<unknown> };

// 模拟 Chrome 的 View Transition：更新回调延后执行（新快照在回调返回后截），
// 进行中的过渡被下一次调用跳过时 ready 以 AbortError 拒绝。
function installViewTransition() {
	const captures: string[] = [];
	const animated: { keyframes: unknown; options: unknown }[] = [];
	const rejections: unknown[] = [];
	let active: { skip: () => void } | null = null;

	const onUnhandled = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onUnhandled);

	const target = document as unknown as Record<string, unknown>;
	target.startViewTransition = (callback: () => void): TransitionRecord => {
		active?.skip();

		let resolveReady: () => void = () => undefined;
		let rejectReady: (error: unknown) => void = () => undefined;
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		const self = {
			skip: () => rejectReady(new DOMException("Transition was skipped", "AbortError")),
		};
		active = self;

		queueMicrotask(() => {
			callback();
			// 回调返回的这一刻就是截「新快照」的时刻：这里必须已经是新配色。
			captures.push(
				["light", "dark"]
					.filter(name => document.documentElement.classList.contains(name))
					.join(" "),
			);
			if (active !== self) return; // 已被后一次点击跳过，ready 已经拒绝
			active = null;
			resolveReady();
		});

		return { ready, finished: Promise.resolve() };
	};

	const element = document.documentElement as unknown as Record<string, unknown>;
	element.animate = (keyframes: unknown, options: unknown) => {
		animated.push({ keyframes, options });
		return { finished: Promise.resolve() };
	};

	return {
		captures,
		animated,
		rejections,
		restore() {
			process.off("unhandledRejection", onUnhandled);
			delete target.startViewTransition;
			delete element.animate;
		},
	};
}

test("连点两次推进两态，不丢点击也不留未处理的 AbortError", async t => {
	const media = installMatchMedia(false); // 系统浅色
	const viewTransition = installViewTransition();
	t.after(() => {
		cleanup();
		viewTransition.restore();
		media.restore();
		localStorage.clear();
	});

	localStorage.setItem("theme-test-rapid", "light");
	mount("theme-test-rapid");

	const toggle = await screen.findByRole("button", { name: /主题：浅色/ });
	// 同一个同步任务里连点两次：第一次的提交还卡在过渡回调里，第二次不能按旧值再算一遍。
	fireEvent.click(toggle);
	fireEvent.click(toggle);

	await waitFor(() => assert.equal(localStorage.getItem("theme-test-rapid"), "system"));
	await waitFor(() => {
		const mode = screen.getByRole("button").getAttribute("data-theme-mode");

		assert.equal(mode, "system", "两次有效操作应推进两态（浅色 → 深色 → 跟随系统）");
	});
	await waitForRootClass("light", "跟随浅色系统");

	assert.deepEqual(viewTransition.captures, ["dark", "light"], "每次过渡截到的新快照都已是新配色");
	assert.equal(viewTransition.animated.length, 1, "被跳过的过渡不播动画，后一次正常播");
	assert.deepEqual(viewTransition.rejections, [], "被跳过的过渡不能留下未处理的 AbortError");
});

test("过渡正常兑现时播裁切动画", async t => {
	const media = installMatchMedia(false);
	const viewTransition = installViewTransition();
	t.after(() => {
		cleanup();
		viewTransition.restore();
		media.restore();
		localStorage.clear();
	});

	localStorage.setItem("theme-test-animate", "light");
	mount("theme-test-animate");

	const toggle = await screen.findByRole("button", { name: /主题：浅色/ });
	fireEvent.click(toggle);

	await waitFor(() => assert.equal(localStorage.getItem("theme-test-animate"), "dark"));
	await waitFor(() => assert.equal(viewTransition.animated.length, 1, "过渡就绪后播动画"));
	assert.equal(
		(viewTransition.animated[0]?.options as { pseudoElement: string }).pseudoElement,
		"::view-transition-new(root)",
	);
});
