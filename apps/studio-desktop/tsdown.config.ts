import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/main.ts", "src/preload.ts"],
    format: "cjs",
    outDir: "dist-electron",
    outExtensions: () => ({ js: ".cjs" }),
    sourcemap: true,
    clean: true,
    // Electron + native updater are provided by the Electron runtime, never bundled.
    external: ["electron", "electron-updater"],
    // Bundle effect + platform-node + @ax/* so the main process is self-contained.
    noExternal: [/^effect/, /^@effect\//, /^@ax\//],
});
