// 主题三态与「跟随系统」的回归测试：
// 1) 系统偏好变化时（不刷新页面）要实时跟随；
// 2) 头部按钮点一次换一态：浅色 → 深色 → 跟随系统；
// 3) 手动态不能被系统变化覆盖，回到「跟随系统」后又能继续跟随。

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
