#!/usr/bin/env bun
/**
 * Guard: ban bare record-list FROM sources (`FROM [table:..., ...]`) in
 * runtime SurrealQL.
 *
 * SurrealDB 3.0.x threw "Specify a database to use" on bare record-list
 * selection even with the session database set (issue #251 - it aborted every
 * Claude/Codex ingest on fresh installs).
 *
 * RETIRED IN PRACTICE, STILL WIRED. The v2 DuckDB migration removed the
 * SurrealDB client, and with it `@ax/lib/shared/record-select` - the only
 * module that was allowed to emit the materialized shape. Nothing produces
 * `FROM [` any more, so this guard now watches an empty set. It is kept only
 * because `.github/workflows/ci.yml` runs it and that file cannot be edited
 * from the migration branch (the push token lacks the `workflow` scope).
 * Delete both together.
 *
 * Scope: .ts/.tsx under apps/axctl/src and packages/-star-/src, excluding
 * test files and record-select.ts itself. Comment lines are skipped so the
 * invariant docs don't trip the guard.
 */

import { Glob } from "bun";

const SCAN_GLOBS = [
    "apps/axctl/src/**/*.ts",
    "apps/axctl/src/**/*.tsx",
    "packages/*/src/**/*.ts",
    "packages/*/src/**/*.tsx",
];

/** Files allowed to contain `FROM [`. Each entry must carry a reason. */
const EXCLUDED_FILES: readonly string[] = [
    // Empty: the one module that was allowed to emit `FROM [` went with the
    // SurrealDB client. Any hit is now unambiguously a mistake.
];

const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*|--)/;
const BARE_RECORD_LIST_FROM_RE = /\bFROM\s+\[/;

/** True when `line` contains a bare record-list FROM source (not a comment,
 *  not already materialized on the same line). Exported for tests. */
export function isBareRecordListFromLine(line: string): boolean {
    if (COMMENT_LINE_RE.test(line)) return false;
    if (!BARE_RECORD_LIST_FROM_RE.test(line)) return false;
    // The helpers append `.map(|$r| ...)` to the list source; a line that
    // carries the materializer (directly or via refListSource/recordListSource
    // interpolation) is fine.
    return !/\.map\(\|\$r\|/.test(line) && !/refListSource|recordListSource|selectByIds/.test(line);
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
            if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
            if (excluded.has(file)) continue;
            files.push(file);
        }
    }

    const offenders: Offender[] = [];
    for (const file of files.sort()) {
        const content = await Bun.file(file).text();
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
            const text = lines[i] as string;
            if (isBareRecordListFromLine(text)) {
                offenders.push({ file, line: i + 1, text: text.trim() });
            }
        }
    }

    if (offenders.length > 0) {
        console.error("Bare record-list FROM source(s) found (throws on SurrealDB 3.0.x - issue #251):");
        for (const o of offenders) {
            console.error(`${o.file}:${o.line}: ${o.text}`);
        }
        console.error(
            `\n${offenders.length} offender(s). Build the source with refListSource/recordListSource/selectByIds from @ax/lib/shared/record-select.`,
        );
        process.exit(1);
    }

    console.log(`check-record-select: clean (${files.length} files scanned, 0 bare record-list FROM sources).`);
}

if (import.meta.main) {
    await main();
}
