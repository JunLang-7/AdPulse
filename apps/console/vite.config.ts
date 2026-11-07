import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import svgr from "@svgr/rollup";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	envDir: resolve(root, "../.."),
	// Same-origin requests through the dev proxy avoid CORS preflight.
	server: {
		proxy: {
			"/api": "http://127.0.0.1:3000",
			"/auth": "http://127.0.0.1:3000",
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
});
