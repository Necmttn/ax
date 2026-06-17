import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/main.ts", "src/preload.ts"],
    format: "cjs",
    outDir: "dist-electron",
    outExtensions: () => ({ js: ".cjs" }),
    sourcemap: true,
    clean: true,
    // Only `electron` is provided by the runtime. Everything else is bundled,
    // because the packaged asar is just dist-electron + package.json (no
    // node_modules) - a runtime `require` of a non-bundled module crashes the
    // app (electron-updater did exactly that on first launch).
    external: ["electron"],
    // Bundle effect + platform-node + @ax/* + electron-updater so the main
    // process is fully self-contained.
    noExternal: [/^effect/, /^@effect\//, /^@ax\//, "electron-updater"],
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
