import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import fs from 'fs/promises';
import svgr from '@svgr/rollup';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, resolve(__dirname, '../..'), '');
    return {
    envDir: resolve(__dirname, '../..'),
    define: {
        'import.meta.env.VITE_API_BASE_URL': JSON.stringify(env.VITE_API_BASE_URL || env.API_BASE_URL || 'http://127.0.0.1:3000'),
        'import.meta.env.VITE_CONSOLE_TOKEN': JSON.stringify(env.VITE_CONSOLE_TOKEN || env.CONSOLE_TOKEN || ''),
    },
    resolve: {
        alias: {
            src: resolve(__dirname, 'src'),
            '@': resolve(__dirname, 'src'),
        },
    },
    optimizeDeps: {
        esbuildOptions: {
            plugins: [
                {
                    name: 'load-js-files-as-tsx',
                    setup(build: { onLoad: (arg0: { filter: RegExp; }, arg1: (args: any) => Promise<{ loader: string; contents: string; }>) => void; }) {
                        build.onLoad(
                            { filter: /src\\.*\.js$/ },
                            async (args) => ({
                                loader: 'tsx',
                                contents: await fs.readFile(args.path, 'utf8'),
                            })
                        );
                    },
                },
            ],
        },
    },

    plugins: [svgr(), react()],
    };
});