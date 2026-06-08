import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Studio SPA build. Three targets via STUDIO_TARGET:
 *   - daemon  (default): base "/",        outDir "dist",         mock off
 *                         (legacy daemon-mounted build; also the dev default)
 *   - web:               base "/studio/", outDir "dist-studio",  mock on
 *                         (hosted at ax.necmttn.com/studio/, CORS-fetches a
 *                          user's local daemon; consumed by apps/site)
 *   - desktop:           base "./",       outDir "dist-desktop", mock on
 *                         (served from the Electron custom-protocol root;
 *                          relative base so assets resolve under app://studio/)
 *
 * `web` and `desktop` set VITE_STUDIO_MOCK=true so src/api.ts keeps its
 * existing `import.meta.env.VITE_STUDIO_MOCK` mock/live-connect behaviour.
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
    },
    plugins: [react()],
    resolve: {
        alias: {
            "@shared": path.resolve(__dirname, "../../packages/lib/src/shared"),
        },
    },
    server: {
        // Bind IPv4 explicitly: the desktop shell's dev URL is
        // http://127.0.0.1:1739, and vite's default "localhost" host resolves
        // to IPv6 ::1 on macOS, which the Electron window can't reach
        // (ERR_CONNECTION_REFUSED). Pin 127.0.0.1 so `bun --filter @ax/studio
        // dev` + the desktop dev launch work out of the box.
        host: "127.0.0.1",
        port: 1739,
        strictPort: true,
        proxy: {
            "/api": {
                target: `http://127.0.0.1:${process.env.AX_DAEMON_PORT ?? "1738"}`,
                changeOrigin: false,
                ws: false,
            },
        },
    },
    build: {
        outDir,
        emptyOutDir: true,
        sourcemap: true,
        target: "es2022",
    },
});
