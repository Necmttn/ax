#!/usr/bin/env bun
/**
 * Guard: ban INTEGER-typed columns projected bare through `write.raw(...)` /
 * `transaction.raw(...)`. They must be `CAST(<col> AS DOUBLE)` in the SELECT.
 *
 * WHY THIS EXISTS. The typed read seams (`cacheRows` / `cacheFirst` and their
 * write-side twins) run every cell through a column decoder, and
 * `NumberFromBigIntColumn` is what turns a DuckDB BIGINT into a JS number.
 * `raw` is the escape hatch that applies NO decoder, so a BIGINT cell arrives
 * as a JS **bigint**. What happens next is the whole problem:
 *
 *   - `typeof cell === "number"` reads FALSE, so a guard written for the typed
 *     path silently stores `null`. No error, no log - a column of zeros.
 *   - `JSON.stringify(cell)` THROWS ("Do not know how to serialize a BigInt").
 *
 * Two of the three instances found during the v2 migration were the silent
 * kind. The loud one was only loud by accident, because a serializer happened
 * to sit downstream. A wrong number that never announces itself is the defect
 * class this migration produced most, and it is why the fix belongs in the
 * PROJECTION rather than in each consumer: a cast at the read boundary cannot
 * be forgotten by the next caller, and a `typeof` guard can.
 *
 * WHY NOT A TEST. Same shape as `check-timestamp-cast.ts`: a bigint flows
 * through a happy-path test without complaint, and the assertion that would
 * catch it (`toBe(42)` against `42n`) is only written when someone already
 * suspects the bug. Nothing in an ordinary suite run fails on this class.
 *
 * SCOPE. Columns the DuckDB schema declares BIGINT / INTEGER / HUGEINT, read
 * through a `.raw(` call. DOUBLE columns already arrive as JS numbers.
 *
 * A column read INSIDE an aggregate still counts: `sum(turns)` reads an integer
 * column and SUM over an integer yields an integer, so the result reaches JS as
 * a bigint exactly as a bare read would. Only the function NAME is exempt, and
 * only because `count`, `sum` and `min` are themselves column names in this
 * schema.
 *
 * KNOWN GAP: `count(*)` is not flagged. `*` is not an identifier, so a
 * name-based guard has nothing to match, yet `count(*)` does return BIGINT.
 * Both current call sites wrap it in `Number(...)`, which is correct; a future
 * caller that does not is not caught here. Closing it needs expression typing
 * rather than name matching - deliberately out of scope for a repo grep.
 */

import { Glob } from "bun";

const SCHEMA_PATH = "packages/schema/src/schema.duckdb.sql";

const SCAN_GLOBS = [
    "apps/*/src/**/*.ts",
    "packages/*/src/**/*.ts",
    "scripts/**/*.ts",
];

/** Files legitimately allowed to contain the banned shape. Each needs a reason. */
const EXCLUDED_FILES: readonly string[] = [
    // This guard itself: its documentation quotes the banned shape.
    "scripts/check-raw-numeric-cast.ts",
    // This guard's own tests: the banned shape IS the fixture there.
    "scripts/check-raw-numeric-cast.test.ts",
];

/**
 * Integer-typed column names from the DuckDB DDL.
 *
 * Deliberately a name set, not a (table, column) map: `.raw` SQL is assembled
 * at runtime and its FROM clause is often a template hole, so the table cannot
 * be resolved statically. Matching on the name alone over-approximates, which
 * is the correct direction for a guard - a false positive costs one CAST, a
 * false negative costs a silent column of nulls.
 */
export function integerColumnsFromDdl(ddl: string): ReadonlySet<string> {
    const columns = new Set<string>();
    // `    name BIGINT ...` or `    "name" BIGINT ...`, ignoring comment lines.
    const re = /^\s*"?([a-z_][a-z0-9_]*)"?\s+(BIGINT|INTEGER|HUGEINT)\b/gim;
    for (const line of ddl.split("\n")) {
        if (line.trimStart().startsWith("--")) continue;
        re.lastIndex = 0;
        const m = re.exec(line);
        if (m?.[1]) columns.add(m[1].toLowerCase());
    }
    return columns;
}

/**
 * The SELECT projections of every `.raw(` call in `source`.
 *
 * Scans from each `.raw(` to its balanced closing paren so a projection is only
 * read inside a call that actually bypasses the decoder - the same statement
 * text passed to `cacheRows` is decoded and must NOT be flagged.
 */
export function rawProjections(source: string): ReadonlyArray<{ line: number; text: string }> {
    const out: Array<{ line: number; text: string }> = [];
    const callRe = /\b(?:write|transaction)\.raw\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(source)) !== null) {
        let depth = 1;
        let i = m.index + m[0].length;
        for (; i < source.length && depth > 0; i++) {
            const ch = source[i];
            if (ch === "(") depth += 1;
            else if (ch === ")") depth -= 1;
        }
        const body = source.slice(m.index, i);
        const line = source.slice(0, m.index).split("\n").length;
        // Every SELECT ... FROM inside the call, including subqueries.
        const projRe = /\bselect\b([\s\S]*?)\bfrom\b/gi;
        let p: RegExpExecArray | null;
        while ((p = projRe.exec(body)) !== null) {
            if (p[1]) out.push({ line, text: p[1] });
        }
    }
    return out;
}

/**
 * Integer columns referenced bare in `projection`.
 *
 * A reference is "bare" when it is not inside a `CAST(...)`. Aliases are
 * ignored: in `CAST(bytes AS DOUBLE) AS bytes` the second `bytes` follows `AS`
 * and names the OUTPUT, which carries the cast type.
 */
export function bareIntegerRefs(
    projection: string,
    integerColumns: ReadonlySet<string>,
): ReadonlyArray<string> {
    // Blank out every CAST(...) body so its contents cannot match. Scanning to
    // the BALANCED closing paren, not a `[^()]*` regex: `CAST(COALESCE(x, 0) AS
    // DOUBLE)` carries inner parens, and a non-balanced matcher walks straight
    // past it and reports the cast column as bare.
    const chars = [...projection];
    const castRe = /\bcast\s*\(/gi;
    let c: RegExpExecArray | null;
    while ((c = castRe.exec(projection)) !== null) {
        let depth = 1;
        let i = c.index + c[0].length;
        for (; i < projection.length && depth > 0; i++) {
            if (projection[i] === "(") depth += 1;
            else if (projection[i] === ")") depth -= 1;
        }
        for (let j = c.index; j < i; j++) chars[j] = " ";
    }
    const masked = chars.join("");
    const found = new Set<string>();
    const idRe = /(\bas\s+)?\b([a-z_][a-z0-9_]*)\b(\s*\()?/gi;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(masked)) !== null) {
        if (m[1]) continue; // an output alias, not a column read
        // An identifier followed by `(` is a FUNCTION, not a column. `count`,
        // `sum` and `min` are all real column names in this schema as well as
        // aggregates, and `count(*) AS count` reads neither of them - DuckDB
        // decides the aggregate's result type, and every call site already
        // wraps it in `Number(...)`.
        if (m[3]) continue;
        const name = m[2]!.toLowerCase();
        if (integerColumns.has(name)) found.add(name);
    }
    return [...found];
}

interface Offender {
    readonly file: string;
    readonly line: number;
    readonly columns: ReadonlyArray<string>;
}

async function main(): Promise<void> {
    const ddl = await Bun.file(SCHEMA_PATH).text();
    const integerColumns = integerColumnsFromDdl(ddl);

    const excluded = new Set(EXCLUDED_FILES);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const pattern of SCAN_GLOBS) {
        const glob = new Glob(pattern);
        for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
            if (seen.has(file) || excluded.has(file)) continue;
            seen.add(file);
            files.push(file);
        }
    }

    const offenders: Offender[] = [];
    for (const file of files.sort()) {
        const source = await Bun.file(file).text();
        if (!source.includes(".raw(")) continue;
        for (const { line, text } of rawProjections(source)) {
            const bare = bareIntegerRefs(text, integerColumns);
            if (bare.length > 0) offenders.push({ file, line, columns: bare });
        }
    }

    if (offenders.length > 0) {
        console.error("Integer columns projected bare through .raw() (no column decoder applies):");
        for (const o of offenders) console.error(`${o.file}:${o.line}: ${o.columns.join(", ")}`);
        console.error(
            `\n${offenders.length} offender(s). \`raw\` applies NO column decoder, so a BIGINT cell ` +
                "arrives as a JS bigint: a `typeof x === \"number\"` guard reads false and silently " +
                "stores null, and JSON.stringify throws.\n" +
                "Fix: cast in the PROJECTION, so the next consumer cannot forget it -\n" +
                "  SELECT CAST(bytes AS DOUBLE) AS bytes FROM ...\n" +
                "Or read through the typed seam (`cacheRows` + NumberFromBigIntColumn), which decodes.",
        );
        process.exit(1);
    }

    console.log(
        `check-raw-numeric-cast: clean (${files.length} files scanned, ` +
            `${integerColumns.size} integer columns known, 0 bare projections).`,
    );
}

if (import.meta.main) {
    await main();
}
