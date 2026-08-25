/**
 * `fetchPrompts` against a REAL published DuckDB snapshot.
 *
 * `prompts.test.ts` only pins the SQL/param TEXT of the clause builders - it
 * cannot see whether the query actually behaves correctly once DuckDB
 * executes it. Three defect classes live there and nowhere else:
 *
 *  1. Dedup partitions on `trim(t.text)` (fix B) - two rows that render
 *     identically after trim (`"fix bug"` / `" fix bug "`) must collapse to
 *     ONE displayed row with the combined `repeats` count, not two
 *     look-alike rows each reporting `repeats: 1`.
 *  2. `legacyInjectionClause` (generated from `FULL_CONTEXT_RULES`) must
 *     actually filter a pre-classifier-fix `task` row whose text starts with
 *     a machine-text prefix, e.g. `<task-notification>` - a stub or a
 *     SQL-text assertion cannot see whether the predicate binds correctly
 *     against a real row.
 *  3. `queryClause` escapes LIKE metacharacters (fix A) - `-q '100%'` must
 *     match text containing the literal `100%` and must NOT behave as a
 *     wildcard that also matches unrelated text merely containing `100`.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchPrompts } from "./prompts.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("prompts", { requireFts: true });

const SESSION = "019e2531-b552-7b53-a029-c780adbb6560";
const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);

const userTask = (id: string, seq: number, ts: Date, text: string, session = SESSION) => ({
    id,
    session,
    seq: BigInt(seq),
    ts,
    role: "user",
    message_kind: "task",
    text,
});

describe("fetchPrompts over a published snapshot", () => {
    dtest("dedupes by trimmed text, filters legacy machine text, and escapes LIKE metachars", async () => {
        const dir = tempDir("prompts");
        // Fixed once, up front - `fixBug!.ts` is compared against this exact
        // instant later, and two separate `hoursAgo(1)` calls a few hundred ms
        // apart would not agree down to the millisecond.
        const dedupNewerTs = hoursAgo(1);
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.put("session", { id: SESSION, source: "claude", cwd: "/Users/x/ax" });

                    // (1) trim-dedup: same prompt, one padded with whitespace.
                    // The later one (newer ts) is what should survive as the
                    // displayed row, with the combined repeat count.
                    yield* write.put("turn", userTask("turn:dedup-a", 1, hoursAgo(3), "fix bug"));
                    yield* write.put("turn", userTask("turn:dedup-b", 2, dedupNewerTs, " fix bug "));

                    // (2) a pre-classifier-fix row: `message_kind` is already
                    // stamped `task`, but the text is a machine-injected
                    // block. `legacyInjectionClause` must drop it.
                    yield* write.put(
                        "turn",
                        userTask(
                            "turn:legacy",
                            3,
                            hoursAgo(2),
                            "<task-notification>agent finished doing work",
                        ),
                    );

                    // The same full-only prefix must be filtered for Claude and
                    // Codex, but must remain visible for Pi, Omp, OpenCode, and
                    // Cursor. The suffix makes each source row unique, so prompt
                    // deduplication cannot hide a source-specific result.
                    const sourceCases = [
                        ["claude", "019e2531-b552-7b53-a029-c780adbb6561"],
                        ["codex", "019e2531-b552-7b53-a029-c780adbb6562"],
                        ["pi", "019e2531-b552-7b53-a029-c780adbb6563"],
                        ["omp", "019e2531-b552-7b53-a029-c780adbb6564"],
                        ["opencode", "019e2531-b552-7b53-a029-c780adbb6565"],
                        ["cursor", "019e2531-b552-7b53-a029-c780adbb6566"],
                    ] as const;
                    for (const [source, session] of sourceCases) {
                        const text = `Base directory for this skill: source=${source}`;
                        yield* write.put("session", { id: session, source, cwd: "/Users/x/ax" });
                        yield* write.put(
                            "turn",
                            userTask(`turn:source-${source}`, 1, hoursAgo(6), text, session),
                        );
                    }

                    // (3) LIKE-metachar rows. Unescaped, searching "100%"
                    // degenerates to "contains 100 anywhere" (the trailing
                    // wildcard already matches anything, and an unescaped `%`
                    // inside the term is just another wildcard) - so the
                    // dollars row would WRONGLY match too.
                    yield* write.put(
                        "turn",
                        userTask("turn:pct-match", 4, hoursAgo(4), "the discount is 100% off today"),
                    );
                    yield* write.put(
                        "turn",
                        userTask(
                            "turn:pct-nomatch",
                            5,
                            hoursAgo(5),
                            "the invoice total is 1000 dollars please review",
                        ),
                    );
                }),
            ),
        );
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        // --- (1) + (2): browse with no query ---------------------------------
        const browsed = await Effect.runPromise(
            fetchPrompts({ sinceDays: 30, limit: 40 }).pipe(Effect.provide(layer)),
        );

        const fixBug = browsed.rows.find((r) => r.text === "fix bug");
        expect(fixBug).toBeDefined();
        expect(fixBug!.repeats).toBe(2);
        // the newer of the pair is the one that should have survived QUALIFY
        expect(fixBug!.ts).toBe(dedupNewerTs.toISOString());
        // no second look-alike row
        expect(browsed.rows.filter((r) => r.text === "fix bug")).toHaveLength(1);

        // legacy machine text never reaches the output at all
        expect(browsed.rows.some((r) => r.text.startsWith("<task-notification>"))).toBe(false);

        for (const source of ["claude", "codex"]) {
            expect(browsed.rows.some((r) => r.source === source && r.text.includes(`source=${source}`))).toBe(false);
        }
        for (const source of ["pi", "omp", "opencode", "cursor"]) {
            expect(browsed.rows.some((r) => r.source === source && r.text.includes(`source=${source}`))).toBe(true);
        }

        // --- (3): a query containing a LIKE metacharacter ---------------------
        const searched = await Effect.runPromise(
            fetchPrompts({ sinceDays: 30, limit: 40, query: "100%" }).pipe(Effect.provide(layer)),
        );

        expect(searched.rows.some((r) => r.text === "the discount is 100% off today")).toBe(true);
        expect(
            searched.rows.some((r) => r.text === "the invoice total is 1000 dollars please review"),
        ).toBe(false);
    });
});
