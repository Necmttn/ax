// packages/lib/src/sqlite/sidecar.test.ts
//
// The judgment seam, against a REAL SQLite file in a temp directory - never
// `:memory:`. WAL, `BEGIN IMMEDIATE`, busy timeouts and "does a second
// connection see the commit" are all properties of a file-backed database, and
// an in-memory one would pass every test here while hiding all four.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Option, Schema } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import {
    BooleanColumn,
    Judgment,
    JudgmentLayer,
    TimestampColumn,
    type JudgmentService,
} from "./index.ts";

let dir: string;
let sidecarPath: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ax-judgment-"));
    sidecarPath = join(dir, "judgment.sqlite");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Run `body` against a real sidecar at `sidecarPath`. */
const run = <A, E>(
    body: (judgment: JudgmentService) => Effect.Effect<A, E, never>,
): Promise<A> =>
    Effect.runPromise(
        Effect.gen(function* () {
            const judgment = yield* Judgment;
            return yield* body(judgment);
        }).pipe(Effect.scoped, Effect.provide(JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL }))) as Effect.Effect<A, E>,
    );

const ProposalRow = Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    status: Schema.String,
    frequency: Schema.Number,
    created_at: TimestampColumn,
});

describe("the judgment sidecar seam", () => {
    test("creates the database and applies the DDL on first use", async () => {
        const tables = await run((j) =>
            j.rows(Schema.Struct({ name: Schema.String }), "SELECT name FROM sqlite_master WHERE type='table'"),
        );
        expect(tables.map((t) => t.name)).toContain("proposal");
    });

    test("round-trips a row through put and rows", async () => {
        const found = await run((j) =>
            Effect.gen(function* () {
                yield* j.put("proposal", {
                    id: "p1",
                    form: "skill",
                    title: "extract the worktree guard",
                    hypothesis: "it fires often enough to be a skill",
                    dedupe_sig: "sig-1",
                    confidence: "high",
                    frequency: 7,
                });
                return yield* j.rows(ProposalRow, "SELECT id, title, status, frequency, created_at FROM proposal");
            }),
        );
        expect(found).toHaveLength(1);
        expect(found[0]?.title).toBe("extract the worktree guard");
        // The DDL's DEFAULTs apply to columns `put` did not name.
        expect(found[0]?.status).toBe("open");
        expect(found[0]?.frequency).toBe(7);
        expect(found[0]?.created_at).toBeInstanceOf(Date);
    });

    test("put REPLACES a row with the same id rather than appending a duplicate", async () => {
        const rows = await run((j) =>
            Effect.gen(function* () {
                const base = {
                    id: "p1",
                    form: "skill",
                    hypothesis: "h",
                    dedupe_sig: "sig-1",
                    confidence: "high",
                };
                yield* j.put("proposal", { ...base, title: "first" });
                yield* j.put("proposal", { ...base, title: "second" });
                return yield* j.rows(ProposalRow, "SELECT id, title, status, frequency, created_at FROM proposal");
            }),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.title).toBe("second");
    });

    test("first is about absence, not cardinality", async () => {
        const [empty, present] = await run((j) =>
            Effect.gen(function* () {
                const before = yield* j.first(
                    Schema.Struct({ id: Schema.String }),
                    "SELECT id FROM proposal WHERE id = ?",
                    ["nope"],
                );
                yield* j.put("proposal", {
                    id: "p1",
                    form: "skill",
                    title: "t",
                    hypothesis: "h",
                    dedupe_sig: "sig",
                    confidence: "low",
                });
                const after = yield* j.first(
                    Schema.Struct({ id: Schema.String }),
                    "SELECT id FROM proposal WHERE id = ?",
                    ["p1"],
                );
                return [before, after] as const;
            }),
        );
        expect(Option.isNone(empty)).toBe(true);
        expect(Option.getOrNull(present)?.id).toBe("p1");
    });

    test("stores a Date parameter as an ISO-8601 UTC instant that decodes back to the same time", async () => {
        const when = new Date("2026-08-15T09:41:07.123Z");
        const [text, decoded] = await run((j) =>
            Effect.gen(function* () {
                yield* j.put("retro", {
                    id: "r1",
                    session: "sess-1",
                    source: "manual",
                    tried: "the port",
                    created_at: when,
                });
                const raw = yield* j.first(
                    Schema.Struct({ created_at: Schema.String }),
                    "SELECT created_at FROM retro",
                );
                const typed = yield* j.first(
                    Schema.Struct({ created_at: TimestampColumn }),
                    "SELECT created_at FROM retro",
                );
                return [Option.getOrNull(raw)?.created_at, Option.getOrNull(typed)?.created_at] as const;
            }),
        );
        expect(text).toBe("2026-08-15T09:41:07.123Z");
        expect(decoded?.getTime()).toBe(when.getTime());
    });

    test("stores a boolean parameter as 0/1 and decodes it back as a boolean", async () => {
        const decoded = await run((j) =>
            Effect.gen(function* () {
                yield* j.put("transcript_label_review", {
                    id: "tlr1",
                    candidate_id: "c1",
                    label_family: "reaction",
                    review_status: "reviewed",
                    promotion_safe: true,
                    reviewer: "necmttn",
                    rationale: "matches two prior confirmations",
                    evidence_paths_json: "[]",
                });
                return yield* j.first(
                    Schema.Struct({ promotion_safe: BooleanColumn, raw: Schema.Number }),
                    "SELECT promotion_safe, promotion_safe AS raw FROM transcript_label_review",
                );
            }),
        );
        expect(Option.getOrNull(decoded)?.promotion_safe).toBe(true);
        expect(Option.getOrNull(decoded)?.raw).toBe(1);
    });

    test("refuses a batch whose rows carry no id, rather than appending duplicates", async () => {
        const failure = await run((j) =>
            Effect.flip(
                j.putMany("skill_triage_decision", [{ skill_name: "tdd", decision: "keep" }]),
            ),
        );
        expect(failure._tag).toBe("SidecarQueryError");
        expect(failure.message).toContain("needs an `id` on every row");
    });

    test("refuses a ragged batch, rather than NULLing the columns a row omitted", async () => {
        const failure = await run((j) =>
            Effect.flip(
                j.putMany("skill_triage_decision", [
                    { id: "d1", skill_name: "tdd", decision: "keep", reason: "used weekly" },
                    { id: "d2", skill_name: "brainstorming", decision: "keep" },
                ]),
            ),
        );
        expect(failure._tag).toBe("SidecarQueryError");
        expect(failure.message).toContain("same columns");
    });

    test("refuses a table name it cannot safely quote", async () => {
        const failure = await run((j) =>
            Effect.flip(j.put("proposal; DROP TABLE proposal", { id: "x" })),
        );
        expect(failure._tag).toBe("SidecarQueryError");
        expect(failure.message).toContain("cannot be a bound parameter");
    });

    test("writes a batch larger than one statement's worth of rows", async () => {
        // PUT_BATCH_ROWS is 200; 450 forces three statements, and the last one is
        // a different width than the first two.
        const count = await run((j) =>
            Effect.gen(function* () {
                yield* j.putMany(
                    "skill_triage_decision",
                    Array.from({ length: 450 }, (_, i) => ({
                        id: `d${i}`,
                        skill_name: `skill-${i}`,
                        decision: "keep",
                    })),
                );
                return yield* j.first(
                    Schema.Struct({ n: Schema.Number }),
                    "SELECT count(*) AS n FROM skill_triage_decision",
                );
            }),
        );
        expect(Option.getOrNull(count)?.n).toBe(450);
    });

    test("rolls the whole transaction back when the body fails", async () => {
        const rows = await run((j) =>
            Effect.gen(function* () {
                const attempt = j.transaction(
                    Effect.gen(function* () {
                        yield* j.put("role", { id: "role:reviewer", name: "reviewer", weight: 2 });
                        yield* j.put("plays_role", {
                            id: "pr1",
                            in_id: "skill:tdd",
                            out_id: "role:reviewer",
                            source: "user",
                        });
                        return yield* Effect.fail("the scaffold step failed" as const);
                    }),
                );
                yield* Effect.flip(attempt);
                // Neither half may survive: the role tag and the role it points
                // at are one decision, and half of it is a dangling tag.
                return yield* j.rows(
                    Schema.Struct({ n: Schema.Number }),
                    "SELECT (SELECT count(*) FROM role) + (SELECT count(*) FROM plays_role) AS n",
                );
            }),
        );
        expect(rows[0]?.n).toBe(0);
    });

    test("opens the sidecar in WAL mode, so a reader never blocks on a writer", async () => {
        await run((j) => j.exec("SELECT 1"));
        const other = new Database(sidecarPath, { readonly: true });
        const mode = other.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode;
        other.close();
        expect(mode).toBe("wal");
    });

    test("creates a missing parent directory rather than failing on first run", async () => {
        // First run on a fresh machine has no `~/.ax` at all.
        const nested = join(dir, "does", "not", "exist", "judgment.sqlite");
        const n = await Effect.runPromise(
            Effect.gen(function* () {
                const j = yield* Judgment;
                return yield* j.first(
                    Schema.Struct({ n: Schema.Number }),
                    "SELECT count(*) AS n FROM proposal",
                );
            }).pipe(
                Effect.scoped,
                Effect.provide(JudgmentLayer({ sidecarPath: nested, schemaSql: SIDECAR_SCHEMA_SQL })),
            ),
        );
        expect(Option.getOrNull(n)?.n).toBe(0);
    });

    test("serialises concurrent transactions instead of interleaving them on one connection", async () => {
        // A SQLite transaction belongs to the CONNECTION. Two fibers issuing
        // BEGIN/COMMIT against this shared handle would commit each other's work
        // and roll back each other's, so a failing transaction must not be able
        // to take a succeeding one down with it - which is what happens if they
        // overlap.
        const surviving = await run((j) =>
            Effect.gen(function* () {
                const doomed = j.transaction(
                    Effect.gen(function* () {
                        yield* j.put("role", { id: "role:doomed", name: "doomed" });
                        yield* Effect.yieldNow;
                        return yield* Effect.fail("no" as const);
                    }),
                );
                const kept = j.transaction(
                    Effect.gen(function* () {
                        yield* Effect.yieldNow;
                        yield* j.put("role", { id: "role:kept", name: "kept" });
                    }),
                );
                yield* Effect.all([Effect.ignore(doomed), kept], { concurrency: 2 });
                return yield* j.rows(
                    Schema.Struct({ id: Schema.String }),
                    "SELECT id FROM role ORDER BY id",
                );
            }),
        );
        expect(surviving.map((r) => r.id)).toEqual(["role:kept"]);
    });

    test("commits a transaction that succeeds, visible to a SEPARATE connection", async () => {
        await run((j) =>
            j.transaction(
                Effect.gen(function* () {
                    yield* j.put("role", { id: "role:reviewer", name: "reviewer", weight: 2 });
                    yield* j.put("plays_role", {
                        id: "pr1",
                        in_id: "skill:tdd",
                        out_id: "role:reviewer",
                        source: "user",
                    });
                }),
            ),
        );
        // Not through the seam: a second process is the case that matters (the
        // CLI writes, the daemon reads), and a same-connection read would pass
        // even if the commit never reached the file.
        const other = new Database(sidecarPath, { readonly: true });
        const n = other.query<{ n: number }, []>("SELECT count(*) AS n FROM plays_role").get()?.n;
        other.close();
        expect(n).toBe(1);
    });
});
