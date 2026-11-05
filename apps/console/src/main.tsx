import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./css/globals.css";
import App from "./App.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "./context/shadcntheme/ThemeContext.tsx";
const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      <Suspense fallback={<div className="p-6">加载中…</div>}>
        <App />
      </Suspense>
    </ThemeProvider>
  </QueryClientProvider>,
);
