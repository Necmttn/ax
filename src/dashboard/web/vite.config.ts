import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Dashboard SPA build. `vite dev` proxies /api/* to the Bun.serve dashboard
 * on :1738; `vite build` emits to `./dist`, which Bun.serve mounts as static
 * assets in production.
 *
 * The studio build (VITE_STUDIO_MOCK=true) ships at ax.necmttn.com/studio/,
 * so assets resolve from /studio/. It emits to ./dist-studio to keep it
 * separate from the production axctl-serve build.
 */
const STUDIO_MOCK = process.env.VITE_STUDIO_MOCK === "true";

export default defineConfig({
    root: __dirname,
    base: STUDIO_MOCK ? "/studio/" : "/",
    plugins: [react()],
    resolve: {
        alias: {
            "@shared": path.resolve(__dirname, "../../lib/shared"),
        },
    },
    server: {
        port: 1739,
        strictPort: true,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:1738",
                changeOrigin: false,
                ws: false,
            },
        },
    },
    build: {
        outDir: STUDIO_MOCK ? "dist-studio" : "dist",
        emptyOutDir: true,
        sourcemap: true,
        target: "es2022",
    },
});
