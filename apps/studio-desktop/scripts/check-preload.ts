/**
 * Build gate for #690: the sandboxed Electron preload cannot require sibling
 * files, so dist-electron/preload.cjs must be fully self-contained - its only
 * permitted require is the runtime-provided "electron". A relative require
 * (e.g. `require('./main.cjs')` from rolldown chunk-sharing) silently kills
 * the preload bridge and the renderer boots without `window.axDesktop`.
 * Runs as part of build:main (see package.json).
 */
const path = new URL("../dist-electron/preload.cjs", import.meta.url).pathname;
const text = await Bun.file(path).text();

const relativeRequires = [...text.matchAll(/require\((["'])(\.{1,2}\/[^"']+)\1\)/g)].map(
    (m) => m[2],
);

if (relativeRequires.length > 0) {
    console.error(
        `check-preload: dist-electron/preload.cjs requires sibling module(s) ` +
            `${relativeRequires.join(", ")} - a sandboxed preload cannot resolve these ` +
            `(#690). Keep main and preload as SEPARATE tsdown configs so no shared ` +
            `chunk is emitted.`,
    );
    process.exit(1);
}

console.log("check-preload: preload.cjs is self-contained");
