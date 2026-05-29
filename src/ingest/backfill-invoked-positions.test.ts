/**
 * Unit tests for backfillInvokedPositions (P3.1, R4).
 *
 * The SurrealClient is mocked: we capture the SQL statements issued and
 * control what the SELECT queries return. No live DB required.
 *
 * R4 algorithm recap:
 *   - SELECT DISTINCT affected (session, skill) pairs (rows with NONE fields).
 *   - For each pair, SELECT ALL rows in the group (not just missing ones).
 *   - Compute: turn_index (keep if set, else seq), total_turns (always refresh),
 *     is_first (earliest seq in full group).
 *   - Emit UPDATE only if at least one field differs.
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { backfillInvokedPositions } from "./backfill-invoked-positions.ts";

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type AffectedPairRow = { session: string; skill: string };
type TurnCountRow = { session: string; n: number };
type GroupRow = {
    id: string;
    seq: number;
    turn_index: number | null;
    total_turns: number | null;
    is_first: boolean | null;
};

// ---------------------------------------------------------------------------
// Mock builder
//
// The new algorithm issues these queries in order:
//   Q1: SELECT DISTINCT ... FROM invoked WHERE turn_index IS NONE OR ...
//   Q2: SELECT session, count() AS n FROM turn GROUP BY session
//   Q3+: SELECT id, in.seq AS seq, ... FROM invoked WHERE in.session = X AND out = Y
//   Q4+: UPDATE <id> SET ... (batched via executeStatementsWith)
// ---------------------------------------------------------------------------

function makeDb(options: {
    affectedPairs: AffectedPairRow[];
    turnCounts: TurnCountRow[];
    /** Map from "session|||skill" to all rows in that group. */
    groups: Map<string, GroupRow[]>;
    issued?: string[];
}): typeof SurrealClient.Service {
    const { affectedPairs, turnCounts, groups, issued = [] } = options;

    const mockDb = {
        query: (sql: string) =>
            Effect.sync(() => {
                issued.push(sql);

                // Q1: affected pairs
                if (
                    sql.includes("FROM invoked") &&
                    sql.includes("turn_index IS NONE") &&
                    sql.includes("DISTINCT")
                ) {
                    return [affectedPairs];
                }

                // Q2: turn counts
                if (sql.includes("FROM turn") && sql.includes("GROUP BY session")) {
                    return [turnCounts];
                }

                // Q3: per-pair group fetch
                if (
                    sql.includes("FROM invoked") &&
                    sql.includes("in.session =") &&
                    sql.includes("AND out =")
                ) {
                    // Extract session and skill from the WHERE clause.
                    // Pattern: in.session = session:X AND out = skill:Y
                    const sessionMatch = sql.match(/in\.session = (\S+)\s+AND/);
                    const skillMatch = sql.match(/AND out = (\S+)/);
                    const session = sessionMatch?.[1] ?? "";
                    const skill = skillMatch?.[1]?.replace(";", "") ?? "";
                    const key = `${session}|||${skill}`;
                    return [groups.get(key) ?? []];
                }

                // UPDATE / executeStatementsWith chunks
                return [[]];
            }),
    } as unknown as typeof SurrealClient.Service;

    return mockDb;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backfillInvokedPositions (R4)", () => {
    test("computes correct turn_index, total_turns, and is_first for 2 sessions × 2 skills", async () => {
        // All rows have NONE positions - both pairs are affected.
        const affectedPairs: AffectedPairRow[] = [
            { session: "session:A", skill: "skill:alpha" },
            { session: "session:A", skill: "skill:beta" },
            { session: "session:B", skill: "skill:alpha" },
            { session: "session:B", skill: "skill:beta" },
        ];

        const turnCounts: TurnCountRow[] = [
            { session: "session:A", n: 10 },
            { session: "session:B", n: 8 },
        ];

        const groups = new Map<string, GroupRow[]>([
            [
                "session:A|||skill:alpha",
                [
                    { id: "invoked:edge_a1", seq: 3, turn_index: null, total_turns: null, is_first: null },
                    { id: "invoked:edge_a2", seq: 7, turn_index: null, total_turns: null, is_first: null },
                ],
            ],
            [
                "session:A|||skill:beta",
                [
                    { id: "invoked:edge_a3", seq: 5, turn_index: null, total_turns: null, is_first: null },
                ],
            ],
            [
                "session:B|||skill:alpha",
                [
                    { id: "invoked:edge_b1", seq: 2, turn_index: null, total_turns: null, is_first: null },
                ],
            ],
            [
                "session:B|||skill:beta",
                [
                    { id: "invoked:edge_b2", seq: 4, turn_index: null, total_turns: null, is_first: null },
                    { id: "invoked:edge_b3", seq: 6, turn_index: null, total_turns: null, is_first: null },
                ],
            ],
        ]);

        const issued: string[] = [];
        const mockDb = makeDb({ affectedPairs, turnCounts, groups, issued });

        const result = await Effect.runPromise(
            backfillInvokedPositions().pipe(
                Effect.provideService(SurrealClient, mockDb),
            ),
        );

        expect(result.backfilled).toBe(6);
        expect(result.sessions).toBe(2);

        const allSql = issued.join(" ");
        const updateMatches = allSql.matchAll(
            /UPDATE (invoked:\S+) SET turn_index = (\d+), total_turns = (\d+), is_first = (true|false)/g,
        );
        const parsed = [...updateMatches].map((m) => ({
            id: m[1]!,
            turnIndex: Number(m[2]),
            totalTurns: Number(m[3]),
            isFirst: m[4] === "true",
        }));

        // session-A, skill-alpha: seq 3 is first, seq 7 is not
        const edgeA1 = parsed.find((p) => p.id === "invoked:edge_a1");
        expect(edgeA1).toBeDefined();
        expect(edgeA1!.turnIndex).toBe(3);
        expect(edgeA1!.totalTurns).toBe(10);
        expect(edgeA1!.isFirst).toBe(true);

        const edgeA2 = parsed.find((p) => p.id === "invoked:edge_a2");
        expect(edgeA2).toBeDefined();
        expect(edgeA2!.turnIndex).toBe(7);
        expect(edgeA2!.totalTurns).toBe(10);
        expect(edgeA2!.isFirst).toBe(false);

        // session-A, skill-beta: seq 5, only one → is_first=true
        const edgeA3 = parsed.find((p) => p.id === "invoked:edge_a3");
        expect(edgeA3).toBeDefined();
        expect(edgeA3!.turnIndex).toBe(5);
        expect(edgeA3!.totalTurns).toBe(10);
        expect(edgeA3!.isFirst).toBe(true);

        // session-B, skill-alpha: seq 2, only one → is_first=true
        const edgeB1 = parsed.find((p) => p.id === "invoked:edge_b1");
        expect(edgeB1).toBeDefined();
        expect(edgeB1!.turnIndex).toBe(2);
        expect(edgeB1!.totalTurns).toBe(8);
        expect(edgeB1!.isFirst).toBe(true);

        // session-B, skill-beta: seq 4 is first, seq 6 is not
        const edgeB2 = parsed.find((p) => p.id === "invoked:edge_b2");
        expect(edgeB2).toBeDefined();
        expect(edgeB2!.turnIndex).toBe(4);
        expect(edgeB2!.totalTurns).toBe(8);
        expect(edgeB2!.isFirst).toBe(true);

        const edgeB3 = parsed.find((p) => p.id === "invoked:edge_b3");
        expect(edgeB3).toBeDefined();
        expect(edgeB3!.turnIndex).toBe(6);
        expect(edgeB3!.totalTurns).toBe(8);
        expect(edgeB3!.isFirst).toBe(false);
    });

    test("returns backfilled=0 when no rows need backfilling (idempotent second run)", async () => {
        const issued: string[] = [];
        const mockDb = {
            query: (sql: string) =>
                Effect.sync(() => {
                    issued.push(sql);
                    if (
                        sql.includes("FROM invoked") &&
                        sql.includes("turn_index IS NONE") &&
                        sql.includes("DISTINCT")
                    ) {
                        return [[]]; // no affected pairs
                    }
                    return [[]];
                }),
        } as unknown as typeof SurrealClient.Service;

        const result = await Effect.runPromise(
            backfillInvokedPositions().pipe(
                Effect.provideService(SurrealClient, mockDb),
            ),
        );

        expect(result.backfilled).toBe(0);
        expect(result.sessions).toBe(0);

        const allSql = issued.join(" ");
        expect(allSql).not.toContain("UPDATE invoked:");
    });

    test("emits no UPDATE when existing row values already match desired state (diff-based idempotency)", async () => {
        // One affected pair (flagged because its turn_index IS NONE… wait,
        // we need at least one NONE row to show up in affectedPairs).
        // To simulate the edge case where the per-group fetch returns a row
        // that already has everything correct (e.g. was fixed by a concurrent
        // write between Q1 and Q3), the group row has all fields set correctly.
        const affectedPairs: AffectedPairRow[] = [
            { session: "session:X", skill: "skill:foo" },
        ];
        const turnCounts: TurnCountRow[] = [{ session: "session:X", n: 3 }];

        // Row already has correct values - backfill should not emit an UPDATE.
        const groups = new Map<string, GroupRow[]>([
            [
                "session:X|||skill:foo",
                [
                    { id: "invoked:x1", seq: 1, turn_index: 1, total_turns: 3, is_first: true },
                ],
            ],
        ]);

        const issued: string[] = [];
        const mockDb = makeDb({ affectedPairs, turnCounts, groups, issued });

        const result = await Effect.runPromise(
            backfillInvokedPositions().pipe(
                Effect.provideService(SurrealClient, mockDb),
            ),
        );

        expect(result.backfilled).toBe(0);
        // sessions is counted from affectedPairs, not from emitted UPDATEs.
        expect(result.sessions).toBe(1);

        const allSql = issued.join(" ");
        expect(allSql).not.toContain("UPDATE invoked:x1");
    });

    // -------------------------------------------------------------------------
    // NEW: incremental scenario (the R4 motivating bug)
    // -------------------------------------------------------------------------

    test("incremental scenario: new invocation does NOT become is_first when an earlier row exists", async () => {
        /**
         * Situation:
         *   - session s1, skill A has an already-filled row at seq=10
         *     (turn_index=10, total_turns=20, is_first=true).
         *   - A new transcript appended a second invocation at seq=15 with
         *     all position fields NONE (total_turns=25 now).
         *   - The affected-pairs SELECT sees the pair (s1, A) because the new
         *     row has NONE fields.
         *   - The group-fetch returns BOTH rows.
         *   - Expected outcome after backfill:
         *       seq=10 row: turn_index=10 (unchanged), total_turns=25 (refreshed),
         *                   is_first=true (still earliest).
         *       seq=15 row: turn_index=15 (filled from seq), total_turns=25,
         *                   is_first=false (NOT earliest).
         */
        const affectedPairs: AffectedPairRow[] = [
            { session: "session:s1", skill: "skill:A" },
        ];
        const turnCounts: TurnCountRow[] = [
            // Session now has 25 turns (grew since last backfill).
            { session: "session:s1", n: 25 },
        ];
        const groups = new Map<string, GroupRow[]>([
            [
                "session:s1|||skill:A",
                [
                    // Already-filled row (earliest).
                    { id: "invoked:old", seq: 10, turn_index: 10, total_turns: 20, is_first: true },
                    // New row with missing positions.
                    { id: "invoked:new", seq: 15, turn_index: null, total_turns: null, is_first: null },
                ],
            ],
        ]);

        const issued: string[] = [];
        const mockDb = makeDb({ affectedPairs, turnCounts, groups, issued });

        const result = await Effect.runPromise(
            backfillInvokedPositions().pipe(
                Effect.provideService(SurrealClient, mockDb),
            ),
        );

        const allSql = issued.join(" ");

        // Both rows need an UPDATE:
        //   - old row: total_turns changed 20→25
        //   - new row: all three fields were NONE
        expect(result.backfilled).toBe(2);
        expect(result.sessions).toBe(1);

        const updateMatches = allSql.matchAll(
            /UPDATE (invoked:\S+) SET turn_index = (\d+), total_turns = (\d+), is_first = (true|false)/g,
        );
        const parsed = [...updateMatches].map((m) => ({
            id: m[1]!,
            turnIndex: Number(m[2]),
            totalTurns: Number(m[3]),
            isFirst: m[4] === "true",
        }));

        // Old row: turn_index preserved, total_turns refreshed, is_first=true.
        const oldRow = parsed.find((p) => p.id === "invoked:old");
        expect(oldRow).toBeDefined();
        expect(oldRow!.turnIndex).toBe(10); // MUST NOT change
        expect(oldRow!.totalTurns).toBe(25); // refreshed
        expect(oldRow!.isFirst).toBe(true); // still earliest

        // New row: filled from seq, is_first=false (seq=10 is earlier).
        const newRow = parsed.find((p) => p.id === "invoked:new");
        expect(newRow).toBeDefined();
        expect(newRow!.turnIndex).toBe(15);
        expect(newRow!.totalTurns).toBe(25);
        expect(newRow!.isFirst).toBe(false); // CRITICAL: must be false
    });

    // -------------------------------------------------------------------------
    // NEW: stable turn_index - no wasted UPDATE when seq matches existing value
    // -------------------------------------------------------------------------

    test("re-ingest with stable seq does not emit UPDATE when turn_index already set and all fields correct", async () => {
        /**
         * A row already has turn_index=10 (RELATE-time snapshot). After re-ingest
         * the in.seq is still 10 and total_turns and is_first are already correct.
         * Backfill must skip the UPDATE entirely (idempotent).
         */
        const affectedPairs: AffectedPairRow[] = [
            { session: "session:stable", skill: "skill:bar" },
        ];
        const turnCounts: TurnCountRow[] = [
            { session: "session:stable", n: 5 },
        ];
        const groups = new Map<string, GroupRow[]>([
            [
                "session:stable|||skill:bar",
                [
                    // All fields already correct.
                    { id: "invoked:stable1", seq: 10, turn_index: 10, total_turns: 5, is_first: true },
                ],
            ],
        ]);

        const issued: string[] = [];
        const mockDb = makeDb({ affectedPairs, turnCounts, groups, issued });

        const result = await Effect.runPromise(
            backfillInvokedPositions().pipe(
                Effect.provideService(SurrealClient, mockDb),
            ),
        );

        expect(result.backfilled).toBe(0);

        const allSql = issued.join(" ");
        // No UPDATE should be emitted because nothing changed.
        expect(allSql).not.toContain("UPDATE invoked:stable1");
    });

    test("turn_index is NOT overwritten when already set, even if seq differs", async () => {
        /**
         * Edge case: turn_index was captured at RELATE time as 10, but the
         * seq on in (the turn record) may differ. Backfill must preserve the
         * RELATE-time snapshot.
         *
         * Here seq=12 but turn_index=10 (they differ). Backfill should keep
         * turn_index=10 in the UPDATE (if total_turns or is_first needs fixing).
         */
        const affectedPairs: AffectedPairRow[] = [
            { session: "session:drift", skill: "skill:baz" },
        ];
        const turnCounts: TurnCountRow[] = [
            { session: "session:drift", n: 15 }, // grew - total_turns needs update
        ];
        const groups = new Map<string, GroupRow[]>([
            [
                "session:drift|||skill:baz",
                [
                    // turn_index is set but total_turns is stale (10 vs current 15).
                    { id: "invoked:drift1", seq: 12, turn_index: 10, total_turns: 8, is_first: true },
                ],
            ],
        ]);

        const issued: string[] = [];
        const mockDb = makeDb({ affectedPairs, turnCounts, groups, issued });

        await Effect.runPromise(
            backfillInvokedPositions().pipe(
                Effect.provideService(SurrealClient, mockDb),
            ),
        );

        const allSql = issued.join(" ");
        // UPDATE must be emitted (total_turns changed).
        expect(allSql).toContain("UPDATE invoked:drift1");
        // turn_index must be preserved as 10, NOT overwritten with 12 (seq).
        expect(allSql).toContain("turn_index = 10");
        expect(allSql).not.toContain("turn_index = 12");
        // total_turns must be refreshed to 15.
        expect(allSql).toContain("total_turns = 15");
    });
});
