import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./css/globals.css";
import App from "./App.tsx";
import { ThemeProvider } from "./context/shadcntheme/ThemeContext.tsx";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
    <Suspense fallback={<div className="p-6">加载中…</div>}>
      <App />
    </Suspense>
  </ThemeProvider>,
);
