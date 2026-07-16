import { defineConfig } from "tsdown";

// main and preload are built as SEPARATE configs on purpose (#690): with both
// entries in one config, rolldown hoists shared CJS helpers into a chunk owned
// by main.cjs and emits `require('./main.cjs')` at the top of preload.cjs.
// A sandboxed Electron preload cannot require sibling files ("module not
// found: ./main.cjs"), so the preload bridge silently dies and the renderer
// boots without `window.axDesktop` - blank/white shell. Each entry must be a
// fully self-contained bundle.
const shared = {
    format: "cjs",
    outDir: "dist-electron",
    outExtensions: () => ({ js: ".cjs" }),
    sourcemap: true,
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
} satisfies Partial<import("tsdown").UserConfig>;

export default defineConfig([
    {
        ...shared,
        entry: ["src/main.ts"],
        clean: true,
    },
    {
        ...shared,
        entry: ["src/preload.ts"],
        // main's config already cleaned the outDir; cleaning again would delete
        // the freshly-built main.cjs.
        clean: false,
    },
]);
