import { expect, test } from "bun:test";
import { buildNgramRows } from "./derive-directive-ngrams.ts";
import type { LiftRow } from "../queries/directive-ngrams.ts";

test("buildNgramRows emits one row per input with lift and counts", () => {
    const rows: LiftRow[] = [
        { ngram: "remember to", n: 2, occurrences: 10, outcomes: 8, sessions: 6, lift: 8 },
        { ngram: "from now on", n: 3, occurrences: 5, outcomes: 4, sessions: 3, lift: 7.5 },
    ];
    const built = buildNgramRows(rows, new Date("2026-08-15T00:00:00Z"));
    expect(built).toHaveLength(2);
    expect(built.map((row) => row.ngram)).toEqual(["remember to", "from now on"]);
    expect(built[0]).toMatchObject({ lift: 8, occurrences: 10 });
});

test("buildNgramRows hashes the ngram into a stable row id", () => {
    const rows = buildNgramRows([
        { ngram: "git add -A", n: 3, occurrences: 5, outcomes: 5, sessions: 3, lift: 9 },
    ]);
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{32}$/);
});

test("buildNgramRows returns empty array for empty input", () => {
    expect(buildNgramRows([])).toEqual([]);
});

test("buildNgramRows includes all required fields", () => {
    const row: LiftRow = { ngram: "always use", n: 2, occurrences: 7, outcomes: 6, sessions: 4, lift: 3.5 };
    expect(buildNgramRows([row])[0]).toMatchObject(row);
});

test("buildNgramRows stores the raw ngram text in the ngram field", () => {
    const row: LiftRow = { ngram: "make sure", n: 2, occurrences: 6, outcomes: 5, sessions: 3, lift: 4.2 };
    expect(buildNgramRows([row])[0]!.ngram).toBe("make sure");
});
