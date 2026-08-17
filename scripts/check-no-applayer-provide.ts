#!/usr/bin/env bun
/**
 * Guard: ban `Effect.provide(...)` calls that self-provision an `AppLayer`
 * outside the two places allowed to build one.
 *
 * WHY THIS EXISTS. `ax share` is declared runtime `"none"` in the command
 * manifest - it must reach no stored data - yet `cli/share.ts` used to call
 * `Effect.provide(AppLayer)` INLINE inside `liveShareDeps.exportArtifact`,
 * self-provisioning regardless of what the dispatcher handed it. That made the
 * manifest's runtime label untrustworthy: a command could read "none" and
 * still acquire a full runtime on its own. The fix removes the inline provide
 * and takes the dependency from the dispatcher instead; this guard is what
 * keeps the pattern from coming back, here or anywhere else.
 *
 * The engine has changed (SurrealDB is gone; reads go through `CacheRead`) but
 * the rule has not, because the rule is about WHERE a runtime is chosen, not
 * which engine it carries. A module that builds its own runtime answers from
 * whatever it built, not from what its declared runtime promised.
 *
 * ALLOWED SITES. Exactly two source files may build one:
 *
 *   - `apps/axctl/src/cli/index.ts` - the dispatcher itself, the ONE place a
 *     command's runtime is chosen.
 *   - `apps/axctl/src/ingest/stage/runtime.ts` - `IngestRuntimeLayer`, the
 *     ingest pipeline's own runtime construction.
 *
 * Everything else - CLI command modules, query modules, dojo/profile/share/
 * team/self-improve modules - must take its dependencies from the caller
 * (the `R` channel).
 *
 * `*.test.ts` / `*.e2e.test.ts` files are OUT of scope: an integration test
 * that provides a full runtime to exercise a real path is a legitimate and
 * different use from a production read path bypassing its declared runtime.
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
/** Plain substring, NOT a `\b`-bounded match, so a wrapper name ending in
 *  `AppLayer` is caught too - a suffixed alias is exactly how the banned
 *  pattern would come back. */
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
            "Effect.provide(...) self-provisioning an AppLayer found outside the allowed sites:",
        );
        for (const o of offenders) console.error(`${o.file}:${o.line}: ${o.text}`);
        console.error(
            `\n${offenders.length} offender(s). Only ${ALLOWED_FILES.join(" and ")} may build an AppLayer ` +
                "this way. Every other module must take its dependencies from the caller's R channel instead " +
                "of self-provisioning - see cli/index.ts's `withCache` for the one legitimate construction " +
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
