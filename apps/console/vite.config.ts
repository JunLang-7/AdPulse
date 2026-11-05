import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import svgr from "@svgr/rollup";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, resolve(root, "../.."), "");

	return {
		envDir: resolve(root, "../.."),
		// Same-origin requests through the dev proxy avoid CORS preflight.
		define: {
			"import.meta.env.VITE_API_BASE_URL": JSON.stringify(
				env.VITE_API_BASE_URL || "",
			),
			"import.meta.env.VITE_CONSOLE_TOKEN": JSON.stringify(
				env.VITE_CONSOLE_TOKEN || env.CONSOLE_TOKEN || "",
			),
		},
		server: {
			proxy: {
				"/api": "http://127.0.0.1:3000",
				"/webhooks": "http://127.0.0.1:3000",
			},
		},
		resolve: {
			alias: {
				src: resolve(root, "src"),
				"@": resolve(root, "src"),
			},
		},
		plugins: [svgr(), react()],
	};
});
