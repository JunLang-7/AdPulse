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
    // Same-origin requests through the dev proxy avoid CORS preflight entirely.
    define: {
        'import.meta.env.VITE_API_BASE_URL': JSON.stringify(env.VITE_API_BASE_URL || ''),
        'import.meta.env.VITE_CONSOLE_TOKEN': JSON.stringify(env.VITE_CONSOLE_TOKEN || env.CONSOLE_TOKEN || ''),
    },
    server: {
        proxy: {
            '/api': 'http://127.0.0.1:3000',
            '/webhooks': 'http://127.0.0.1:3000',
        },
    },
    resolve: {
        alias: {
            src: resolve(__dirname, 'src'),
            '@': resolve(__dirname, 'src'),
        },
    },
    plugins: [svgr(), react()],
    };
});