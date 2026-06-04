#!/usr/bin/env bun
/**
 * Guard: ban reintroduction of node:fs / node:path (and bare fs / path)
 * imports across the runtime source tree.
 *
 * The whole codebase was migrated off node:fs/node:path onto @effect/platform
 * (FileSystem/Path from "effect") plus the @ax/lib/shared helpers
 * (fs-error, fs-classify, path). This gate hard-fails CI if any of them
 * sneak back in.
 *
 * Scope: .ts/.tsx under apps/axctl/src and packages/-star-/src.
 * Excludes test files (*.test.ts / *.test.tsx; tests may use node builtins)
 * and the exclusions in EXCLUDED_FILES below.
 *
 * Matching anchors on import/require + the specifier so prose comments that
 * merely mention node:path are NOT flagged (there are such comments in
 * cli/index.ts and classifiers-workflow-candidates.ts).
 */

import { Glob } from "bun";

const SCAN_GLOBS = [
    "apps/axctl/src/**/*.ts",
    "apps/axctl/src/**/*.tsx",
    "packages/*/src/**/*.ts",
    "packages/*/src/**/*.tsx",
];

/**
 * Files legitimately allowed to import node fs/path. Each entry must carry a
 * reason. This list should only shrink.
 */
const EXCLUDED_FILES: readonly string[] = [
    // Build-time config: runs under vite/node (not the Effect runtime), so
    // node:path is the correct dependency here.
    "apps/axctl/src/dashboard/web/vite.config.ts",
];

const BANNED_SPECIFIERS = [
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:path/posix",
    "node:path/win32",
    "fs",
    "fs/promises",
    "path",
    "path/posix",
    "path/win32",
];

const SPECIFIER_ALTERNATION = BANNED_SPECIFIERS.map((s) => s.replace(/\//g, "\\/")).join("|");

/**
 * Matches an IMPORT/REQUIRE of a banned specifier. Anchors on the import/require
 * keyword + the quoted specifier, so comments and unrelated identifiers
 * (e.g. `path.basename`) are not matched.
 *
 *  - static:        import ... from "node:fs"        /  import "node:fs"
 *  - dynamic:       import("node:path")
 *  - require:       require("node:fs/promises")
 */
const IMPORT_RE = new RegExp(
    // static import (default/named/namespace/side-effect) ... from "<spec>" or import "<spec>"
    String.raw`(?:^\s*import\b[^;'"]*?from\s*['"](?:${SPECIFIER_ALTERNATION})['"]` +
        String.raw`|^\s*import\s*['"](?:${SPECIFIER_ALTERNATION})['"]` +
        // dynamic import() / require()
        String.raw`|\b(?:import|require)\s*\(\s*['"](?:${SPECIFIER_ALTERNATION})['"]\s*\))`,
);

/** The line matcher, exported for tests. True when `line` is a banned import. */
export function isBannedImportLine(line: string): boolean {
    return IMPORT_RE.test(line);
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
            const text = lines[i];
            if (isBannedImportLine(text)) {
                offenders.push({ file, line: i + 1, text: text.trim() });
            }
        }
    }

    if (offenders.length > 0) {
        console.error("Banned node:fs / node:path import(s) found:");
        for (const o of offenders) {
            console.error(`${o.file}:${o.line}: ${o.text}`);
        }
        console.error(
            `\n${offenders.length} offender(s). Migrate to FileSystem/Path from "effect" + @ax/lib/shared/{fs-error,fs-classify,path}.`,
        );
        process.exit(1);
    }

    console.log(`check-no-node-fs: clean (${files.length} files scanned, 0 banned imports).`);
}

if (import.meta.main) {
    await main();
}
