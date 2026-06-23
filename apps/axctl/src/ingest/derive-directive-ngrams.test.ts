import { expect, test } from "bun:test";
import { buildNgramUpsertStatements } from "./derive-directive-ngrams.ts";
import type { LiftRow } from "../queries/directive-ngrams.ts";

test("buildNgramUpsertStatements emits one UPSERT per row with lift + counts", () => {
    const rows: LiftRow[] = [
        { ngram: "remember to", n: 2, occurrences: 10, outcomes: 8, sessions: 6, lift: 8 },
        { ngram: "from now on", n: 3, occurrences: 5, outcomes: 4, sessions: 3, lift: 7.5 },
    ];
    const stmts = buildNgramUpsertStatements(rows);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("UPSERT directive_ngram");
    expect(stmts[0]).toContain("lift");
    // values present
    expect(stmts.join("\n")).toContain("remember to");
    expect(stmts.join("\n")).toContain("from now on");
});

test("buildNgramUpsertStatements escapes ngram into a safe record id", () => {
    const stmts = buildNgramUpsertStatements([
        { ngram: "git add -A", n: 3, occurrences: 5, outcomes: 5, sessions: 3, lift: 9 },
    ]);
    // the record id must not contain raw spaces/special chars that break SurrealQL
    expect(stmts[0]).toMatch(/UPSERT directive_ngram[:⟨]/);
});

test("buildNgramUpsertStatements returns empty array for empty input", () => {
    expect(buildNgramUpsertStatements([])).toEqual([]);
});

test("buildNgramUpsertStatements includes all required fields", () => {
    const row: LiftRow = { ngram: "always use", n: 2, occurrences: 7, outcomes: 6, sessions: 4, lift: 3.5 };
    const stmt = buildNgramUpsertStatements([row])[0]!;
    expect(stmt).toContain("ngram");
    expect(stmt).toContain("n");
    expect(stmt).toContain("occurrences");
    expect(stmt).toContain("outcomes");
    expect(stmt).toContain("sessions");
    expect(stmt).toContain("lift");
    expect(stmt).toContain("last_seen");
    expect(stmt).toContain("refit_at");
});

test("buildNgramUpsertStatements stores the raw ngram text in the ngram field", () => {
    const row: LiftRow = { ngram: "make sure", n: 2, occurrences: 6, outcomes: 5, sessions: 3, lift: 4.2 };
    const stmt = buildNgramUpsertStatements([row])[0]!;
    // The raw ngram value should appear as a quoted string in the SET clause
    expect(stmt).toContain('"make sure"');
});
