#!/usr/bin/env bun
/**
 * Guard: ban `Effect.provide(...)` calls that self-provision a LIVE
 * SurrealDB-carrying layer (`AppLayer` / `LegacySurrealAppLayer`) outside the
 * two places that are allowed to build one.
 *
 * WHY THIS EXISTS. `ax share` is declared runtime `"none"` in the command
 * manifest - it must never touch the database - yet `cli/share.ts` used to
 * call `Effect.provide(LegacySurrealAppLayer)` INLINE inside
 * `liveShareDeps.exportArtifact`, self-providing a real `SurrealClient`
 * regardless of what the dispatcher handed it. That made the manifest's
 * runtime label untrustworthy evidence of porting status: a command could
 * read "none" and still open a live SurrealDB connection. The fix removes the
 * inline provide and takes the dependency from the dispatcher instead; this
 * guard is what keeps the pattern from coming back, here or anywhere else.
 *
 * ALLOWED SITES. Exactly two source files may build one of these layers:
 *
 *   - `apps/axctl/src/cli/index.ts` - the dispatcher itself. `withDb` is the
 *     ONE place a command's runtime is chosen and a live SurrealClient may be
 *     constructed on the way in.
 *   - `apps/axctl/src/ingest/stage/runtime.ts` - `IngestRuntimeLayer`, the
 *     ingest pipeline's own runtime construction.
 *
 * Everything else - CLI command modules, query modules, dojo/profile/share/
 * team/self-improve modules - must take its dependencies from the caller
 * (the `R` channel), never build its own live-DB layer.
 *
 * `*.test.ts` / `*.e2e.test.ts` files are OUT of scope: several pre-existing
 * integration tests deliberately provide `LegacySurrealAppLayer` to exercise
 * real (pre-v2, still-reachable) SurrealDB behavior directly, which is a
 * legitimate and different use from a production read path silently
 * bypassing its declared runtime.
 */

import { Glob } from "bun";

const SCAN_GLOBS = [
    "apps/*/src/**/*.ts",
    "apps/*/src/**/*.tsx",
    "packages/*/src/**/*.ts",
    "packages/*/src/**/*.tsx",
];

/** Files allowed to build a live-SurrealDB-carrying layer. Each needs a reason
 *  (see the module doc above). */
const ALLOWED_FILES: readonly string[] = [
    "apps/axctl/src/cli/index.ts",
    "apps/axctl/src/ingest/stage/runtime.ts",
];

const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*)/;
const PROVIDE_CALL_RE = /Effect\.provide\s*\(/;
/** Plain substring, NOT a `\b`-bounded match: `LegacySurrealAppLayer` has no
 *  word boundary before its `AppLayer` suffix (`l` and `A` are both word
 *  characters), and that name IS the live layer this guard exists to catch. */
const APP_LAYER_RE = /AppLayer/;

/** How many lines after an `Effect.provide(` call to scan for its argument,
 *  for the common case where the layer expression wraps onto its own line
 *  (e.g. `Effect.provide(\n    Layer.mergeAll(LegacySurrealAppLayer, ...),\n)`). */
const LOOKAHEAD_LINES = 5;

interface Offender {
    readonly file: string;
    readonly line: number;
    readonly text: string;
}

/** True when the `Effect.provide(` call starting at `lines[index]` carries an
 *  AppLayer-family argument, scanning forward across a wrapped call. Exported
 *  for tests. */
export function provideCallCarriesAppLayer(lines: ReadonlyArray<string>, index: number): boolean {
    const window = lines.slice(index, index + 1 + LOOKAHEAD_LINES).join("\n");
    return APP_LAYER_RE.test(window);
}

async function main(): Promise<void> {
    const allowed = new Set(ALLOWED_FILES);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const pattern of SCAN_GLOBS) {
        const glob = new Glob(pattern);
        for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
            if (seen.has(file)) continue;
            seen.add(file);
            if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
            if (allowed.has(file)) continue;
            files.push(file);
        }
    }

    const offenders: Offender[] = [];
    for (const file of files.sort()) {
        const lines = (await Bun.file(file).text()).split("\n");
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (COMMENT_LINE_RE.test(line)) continue;
            if (!PROVIDE_CALL_RE.test(line)) continue;
            if (provideCallCarriesAppLayer(lines, i)) {
                offenders.push({ file, line: i + 1, text: line.trim() });
            }
        }
    }

    if (offenders.length > 0) {
        console.error(
            "Effect.provide(...) self-provisioning a live-SurrealDB layer (AppLayer / LegacySurrealAppLayer) " +
                "found outside the allowed sites:",
        );
        for (const o of offenders) console.error(`${o.file}:${o.line}: ${o.text}`);
        console.error(
            `\n${offenders.length} offender(s). Only ${ALLOWED_FILES.join(" and ")} may build a live-SurrealDB ` +
                "layer this way. Every other module must take its dependencies from the caller's R channel " +
                "instead of self-providing one - see cli/index.ts's `withDb` for the one legitimate construction " +
                "site, and scripts/check-no-applayer-provide.ts's module doc for the `ax share` incident this " +
                "guard was written to catch.",
        );
        process.exit(1);
    }

    console.log(
        `check-no-applayer-provide: clean (${files.length} files scanned, 0 self-provisioned AppLayer sites).`,
    );
}

if (import.meta.main) {
    await main();
}
