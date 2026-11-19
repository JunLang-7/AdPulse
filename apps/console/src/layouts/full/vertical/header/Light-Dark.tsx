import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "src/context/shadcntheme/ThemeContext";
import { Button } from "@/components/ui/button";

type ViewTransitionLike = { ready: Promise<unknown> };

type ViewTransitionDocument = Document & {
	startViewTransition?: (callback: () => void) => ViewTransitionLike | undefined;
};

const THEME_CYCLE = ["light", "dark", "system"] as const;
type Theme = (typeof THEME_CYCLE)[number];

const THEME_META = {
	light: { icon: Sun, label: "浅色", next: "深色" },
	dark: { icon: Moon, label: "深色", next: "跟随系统" },
	system: { icon: Monitor, label: "跟随系统", next: "浅色" },
} as const;

const nextTheme = (theme: Theme): Theme =>
	THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length] ?? "light";

const LightDark = () => {
	const { theme: activeMode, setTheme: setActiveMode } = useTheme();
	const [isMounted, setIsMounted] = useState(false);
	// 连点/连按 Enter 时 React 状态还没提交，下一态要按「已排队的最新选择」算，否则一次点击会白丢。
	const pendingTheme = useRef<Theme>(activeMode);

	useEffect(() => {
		setIsMounted(true);
	}, []);

	useEffect(() => {
		pendingTheme.current = activeMode;
	}, [activeMode]);

	const toggleTheme = () => {
		const next = nextTheme(pendingTheme.current);
		pendingTheme.current = next;

		const commit = () => setActiveMode(next);

		const doc = document as ViewTransitionDocument;
		if (!doc.startViewTransition) {
			commit();
			return;
		}

		const transition = doc.startViewTransition(commit);

		// 后一次点击会跳过进行中的过渡，ready 以 AbortError 拒绝；配色已提交，跳过动画即可。
		transition?.ready
			?.then(() => {
				document.documentElement.animate(
					{
						clipPath: ["inset(0 0 100% 0)", "inset(0)"],
					},
					{
						duration: 800,
						easing: "ease-in-out",
						pseudoElement: "::view-transition-new(root)",
					},
				);
			})
			.catch(() => undefined);
	};

	if (!isMounted) {
		// Render nothing on the server to avoid hydration mismatch
		return null;
	}

	const meta = THEME_META[activeMode] ?? THEME_META.system;
	const Icon = meta.icon;

	return (
		<div>
			{/* Theme Toggle：浅色 → 深色 → 跟随系统 循环 */}
			<Button
				variant="ghost"
				className=" h-10 w-10  hover:bg-primary/5  rounded-full cursor-pointer"
				onClick={toggleTheme}
				aria-label={`主题：${meta.label}，点击切换到${meta.next}`}
				title={`主题：${meta.label}，点击切换到${meta.next}`}
				data-theme-mode={activeMode}
			>
				<Icon className="size-5" />
			</Button>
		</div>
	);
};

export default LightDark;
