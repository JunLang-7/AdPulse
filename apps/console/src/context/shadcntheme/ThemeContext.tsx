import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";
type ResolvedTheme = Exclude<Theme, "system">;

type ThemeProviderProps = {
	children: React.ReactNode;
	defaultTheme?: Theme;
	storageKey?: string;
};

type ThemeProviderState = {
	theme: Theme;
	setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
	theme: "system",
	setTheme: () => null,
};

const DARK_QUERY = "(prefers-color-scheme: dark)";

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

// 与 index.html 的首帧脚本、Light-Dark 的三态循环共用同一套规则。
const isTheme = (value: string | null): value is Theme =>
	value === "light" || value === "dark" || value === "system";

const readSystemTheme = (): ResolvedTheme =>
	typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches
		? "dark"
		: "light";

const resolveTheme = (theme: Theme): ResolvedTheme =>
	theme === "system" ? readSystemTheme() : theme;

const applyTheme = (theme: Theme) => {
	const root = window.document.documentElement;

	root.classList.remove("light", "dark");
	root.classList.add(resolveTheme(theme));
};

export function ThemeProvider({
	children,
	defaultTheme = "system",
	storageKey = "vite-ui-theme",
	...props
}: ThemeProviderProps) {
	const [theme, setTheme] = useState<Theme>(() => {
		const stored = localStorage.getItem(storageKey);

		return isTheme(stored) ? stored : defaultTheme;
	});

	useEffect(() => {
		applyTheme(theme);

		// 只有「跟随系统」需要跟着系统切换实时更新；手动选定的不覆盖用户选择。
		if (theme !== "system") return;

		const media = window.matchMedia?.(DARK_QUERY);

		if (!media?.addEventListener) return;

		const onChange = () => applyTheme("system");

		media.addEventListener("change", onChange);

		return () => media.removeEventListener("change", onChange);
	}, [theme]);

	const value = {
		theme,
		setTheme: (theme: Theme) => {
			localStorage.setItem(storageKey, theme);
			// 立即落 DOM：view-transition 在回调返回后就截「新快照」，等 React effect 会截到旧配色。
			applyTheme(theme);
			setTheme(theme);
		},
	};

	return (
		<ThemeProviderContext.Provider {...props} value={value}>
			{children}
		</ThemeProviderContext.Provider>
	);
}

export const useTheme = () => {
	const context = useContext(ThemeProviderContext);

	if (context === undefined)
		throw new Error("useTheme must be used within a ThemeProvider");

	return context;
};
