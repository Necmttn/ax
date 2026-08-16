#!/usr/bin/env bun
/**
 * Guard: ban `CURRENT_TIMESTAMP` INTERVAL ARITHMETIC that is not wrapped in
 * `CAST(CURRENT_TIMESTAMP AS TIMESTAMP)`.
 *
 * WHY THIS EXISTS. DuckDB's `CURRENT_TIMESTAMP` is a TIMESTAMP WITH TIME ZONE.
 * Subtracting an INTERVAL from a TIMESTAMPTZ resolves only through the ICU
 * extension, and the static DuckDB build ax ships does NOT carry ICU. So the
 * uncast form is not a wrong answer - the statement does not bind at all:
 *
 *     Binder Error: No function matches the given name and argument types
 *     '(TIMESTAMP WITH TIME ZONE, INTERVAL)'
 *
 * Every TIMESTAMP column in packages/schema/src/schema.duckdb.sql is a NAIVE
 * UTC timestamp (see its "UTC CONTRACT" block - TIMESTAMPTZ is banned there),
 * and the seam pins every connection to UTC, so casting the clock down to a
 * naive TIMESTAMP compares like with like and preserves meaning.
 *
 * WHY A REPO CHECK AND NOT A TEST. The dylib the test suite resolves by default
 * DOES carry ICU, so no ordinary `bun test` run can fail on this class. That is
 * exactly how thirteen sites accumulated behind a green suite. Only a run
 * against the ICU-less build reproduces it:
 *
 *     AX_DUCKDB_DYLIB=~/.cache/ax-duckdb/dist/duckdb bun test <paths>
 *
 * WHY CASE-INSENSITIVE. SQL keywords are case-insensitive and every one of the
 * thirteen sites spelled it lowercase. Prior sweeps grepped for the uppercase
 * spelling only, found nothing, and declared the class clean.
 *
 * SCOPE. Arithmetic only (the proven defect class), in both operand orders.
 * Bare `DEFAULT CURRENT_TIMESTAMP` in DDL and a bare `CURRENT_TIMESTAMP` bound
 * as an INSERT value are fine: those are assignments into a naive column, which
 * DuckDB casts without ICU.
 */

import { Glob } from "bun";

const SCAN_GLOBS = [
    "apps/*/src/**/*.ts",
    "apps/*/src/**/*.tsx",
    "packages/*/src/**/*.ts",
    "packages/*/src/**/*.tsx",
    "packages/*/src/**/*.sql",
    "scripts/**/*.ts",
];

/** Files legitimately allowed to contain the bare form. Each entry needs a reason. */
const EXCLUDED_FILES: readonly string[] = [
    // This guard itself: its documentation quotes the banned shape.
    "scripts/check-timestamp-cast.ts",
    // This guard's own tests: the banned shape IS the fixture there.
    "scripts/check-timestamp-cast.test.ts",
];

// NOTE: other *.test.ts files are deliberately IN scope. Test SQL runs against
// the same ICU-less build in CI's `verify` job, so a bad spelling in a test is
// a real failure, not a false positive.

/**
 * `CURRENT_TIMESTAMP` on the LEFT of `-`/`+`.
 *
 * The correct form does NOT match: in
 * `CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL '30 days'` the token that
 * precedes the operator is `)`, not the keyword.
 */
const LHS_RE = /current_timestamp\s*[-+]/i;

/**
 * `CURRENT_TIMESTAMP` on the RIGHT of `-`/`+` (e.g. `ts - current_timestamp`).
 * The wrapped form reads `- CAST(CURRENT_TIMESTAMP ...`, so the character after
 * the operator is `C` of `CAST` and this does not match either.
 */
const RHS_RE = /[-+]\s*current_timestamp\b/i;

/**
 * Remove line comments before matching, so PROSE that merely discusses the
 * banned shape is not flagged. Several files legitimately explain this bug in
 * comments, and a `-- CURRENT_TIMESTAMP is a TIMESTAMPTZ` line would otherwise
 * trip the right-hand rule on the comment marker itself.
 */
export function stripComments(line: string): string {
    const trimmed = line.trimStart();
    // JSDoc/block-comment continuation lines.
    if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
    const sqlComment = line.indexOf("--");
    const tsComment = line.indexOf("//");
    const cut = [sqlComment, tsComment].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    return cut === undefined ? line : line.slice(0, cut);
}

/** The line matcher, exported for tests. True when `line` does uncast arithmetic. */
export function isUncastTimestampArithmetic(line: string): boolean {
    const code = stripComments(line);
    return LHS_RE.test(code) || RHS_RE.test(code);
}

interface Offender {
    readonly file: string;
    readonly line: number;
    readonly text: string;
}

async function main(): Promise<void> {
    const excluded = new Set(EXCLUDED_FILES);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const pattern of SCAN_GLOBS) {
        const glob = new Glob(pattern);
        for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
            if (seen.has(file)) continue;
            seen.add(file);
            if (excluded.has(file)) continue;
            files.push(file);
        }
    }

    const offenders: Offender[] = [];
    for (const file of files.sort()) {
        const lines = (await Bun.file(file).text()).split("\n");
        for (let i = 0; i < lines.length; i++) {
            if (isUncastTimestampArithmetic(lines[i]!)) {
                offenders.push({ file, line: i + 1, text: lines[i]!.trim() });
            }
        }
    }

    if (offenders.length > 0) {
        console.error("Uncast CURRENT_TIMESTAMP interval arithmetic found:");
        for (const o of offenders) console.error(`${o.file}:${o.line}: ${o.text}`);
        console.error(
            `\n${offenders.length} offender(s). DuckDB's CURRENT_TIMESTAMP is a TIMESTAMPTZ and ` +
                "TIMESTAMPTZ +/- INTERVAL needs the ICU extension, which the shipped static build " +
                "does not carry - these statements fail to BIND at runtime.\n" +
                "Fix: wrap the clock in CAST(CURRENT_TIMESTAMP AS TIMESTAMP), e.g.\n" +
                "  CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL '30 days'\n" +
                "  CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')\n" +
                "Verify against the ICU-less build:\n" +
                "  AX_DUCKDB_DYLIB=~/.cache/ax-duckdb/dist/duckdb bun test <paths>",
        );
        process.exit(1);
    }

    console.log(
        `check-timestamp-cast: clean (${files.length} files scanned, 0 uncast CURRENT_TIMESTAMP arithmetic).`,
    );
}

if (import.meta.main) {
    await main();
}
