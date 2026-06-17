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
    // We deliberately bundle those deps (above) into one self-contained main
    // process. tsdown warns about that and, under CI=true, escalates the warning
    // to a fatal error - silence it; the bundling is intended.
    inlineOnly: false,
    // `@ax/schema/schema.surql` is imported as text (DesktopSchema applies it on
    // boot). Teach rolldown to load `.surql` files as string modules instead of
    // trying to parse them as JS.
    inputOptions: {
        moduleTypes: { ".surql": "text" },
    },
});
