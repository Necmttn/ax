import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";

/** The released monorepo version, baked into the bundle so the studio can show
 *  its own build version and flag a mismatch against the connected daemon. */
const STUDIO_VERSION = ((): string => {
    try {
        return JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")).version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
})();

/**
 * Studio SPA build with 3 targets, selected via STUDIO_TARGET:
 *
 *   daemon  - served by `ax serve` (base `/`, real /api proxy, emits ./dist)
 *   web     - hosted at ax.necmttn.com/studio/ (base `/studio/`, mock fixtures,
 *             emits ./dist-studio; staged into the site by scripts/stage-studio.ts)
 *   desktop - bundled into the desktop shell (relative base `./`, mock fixtures,
 *             emits ./dist-desktop)
 *
 * `vite dev` (daemon target) proxies /api/* to the Bun daemon on :1738.
 */
type StudioTarget = "daemon" | "web" | "desktop";
const TARGET = (process.env.STUDIO_TARGET ?? "daemon") as StudioTarget;
const CONFIG: Record<StudioTarget, { base: string; outDir: string; mock: boolean }> = {
    daemon: { base: "/", outDir: "dist", mock: false },
    web: { base: "/studio/", outDir: "dist-studio", mock: true },
    desktop: { base: "./", outDir: "dist-desktop", mock: true },
};
const { base, outDir, mock } = CONFIG[TARGET];

export default defineConfig({
    root: __dirname,
    base,
    define: {
        "import.meta.env.VITE_STUDIO_MOCK": JSON.stringify(mock ? "true" : "false"),
        __STUDIO_VERSION__: JSON.stringify(STUDIO_VERSION),
    },
    plugins: [react()],
    resolve: { alias: { "@shared": path.resolve(__dirname, "../../packages/lib/src/shared") } },
    server: {
        host: "127.0.0.1",
        port: 1739,
        strictPort: true,
        proxy: { "/api": { target: `http://127.0.0.1:${process.env.AX_DAEMON_PORT ?? "1738"}`, changeOrigin: false, ws: false } },
    },
    build: { outDir, emptyOutDir: true, sourcemap: true, target: "es2022" },
});
