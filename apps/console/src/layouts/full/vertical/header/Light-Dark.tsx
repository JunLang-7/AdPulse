import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "src/context/shadcntheme/ThemeContext";
import { Button } from "@/components/ui/button";

type ViewTransitionDocument = Document & {
	startViewTransition?: (callback: () => void) => unknown;
};

const THEME_CYCLE = ["light", "dark", "system"] as const;

const THEME_META = {
	light: { icon: Sun, label: "浅色", next: "深色" },
	dark: { icon: Moon, label: "深色", next: "跟随系统" },
	system: { icon: Monitor, label: "跟随系统", next: "浅色" },
} as const;

const LightDark = () => {
	const { theme: activeMode, setTheme: setActiveMode } = useTheme();
	const [isMounted, setIsMounted] = useState(false);

	useEffect(() => {
		setIsMounted(true);
	}, []);

	const toggleTheme = async () => {
		const index = THEME_CYCLE.indexOf(activeMode);
		const nextMode = THEME_CYCLE[(index + 1) % THEME_CYCLE.length] ?? "light";

		const toggleMode = () => {
			setActiveMode(nextMode);
		};

		const doc = document as ViewTransitionDocument;
		if (!doc.startViewTransition) {
			toggleMode();
			return;
		}

		const transition = doc.startViewTransition(() => {
			toggleMode();
		});

		await transition.ready;

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
