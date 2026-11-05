import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./css/globals.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.tsx";
import { ThemeProvider } from "./context/shadcntheme/ThemeContext.tsx";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const container = document.getElementById("root");
if (!container) throw new Error("missing #root container");

createRoot(container).render(
	<QueryClientProvider client={queryClient}>
		<ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
			<Suspense fallback={<div className="p-6">加载中…</div>}>
				<App />
			</Suspense>
		</ThemeProvider>
	</QueryClientProvider>,
);
