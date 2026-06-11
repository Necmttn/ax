import { describe, expect, test } from "bun:test";

import { isBareRecordListFromLine } from "./check-record-select.ts";

describe("isBareRecordListFromLine", () => {
    test("flags a bare record-list FROM source", () => {
        expect(isBareRecordListFromLine("            FROM [${from}]")).toBe(true);
        expect(isBareRecordListFromLine("`SELECT name FROM [skill:`a`];`")).toBe(true);
        expect(isBareRecordListFromLine('TURN_SQL.split("$refs").join(`[${refs.join(", ")}]`) + " FROM [x]"')).toBe(true);
    });

    test("does NOT flag the materialized shape", () => {
        expect(isBareRecordListFromLine("FROM [skill:`a`].map(|$r| $r.*).filter(|$o| $o != NONE);")).toBe(false);
    });

    test("does NOT flag helper interpolations", () => {
        expect(isBareRecordListFromLine("FROM ${refListSource(directBlockRefs)}")).toBe(false);
        expect(isBareRecordListFromLine("`SELECT name FROM ${recordListSource(\"skill\", keys)};`")).toBe(false);
    });

    test("does NOT flag comments or non-FROM brackets", () => {
        expect(isBareRecordListFromLine("// NEVER bare `FROM [refs]` (throws on 3.0.x)")).toBe(false);
        expect(isBareRecordListFromLine(" * `SELECT ... FROM [table:`k1`]` works on 3.1.0")).toBe(false);
        expect(isBareRecordListFromLine("WHERE session IN [${sidLiteral}]")).toBe(false);
    });
});

test("runtime tree is clean of bare record-list FROM sources", async () => {
    const proc = Bun.spawn(["bun", "scripts/check-record-select.ts"], {
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
});
