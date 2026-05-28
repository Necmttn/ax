/**
 * Unit tests for backfillInvokedPositions (P3.1).
 *
 * The SurrealClient is mocked: we capture the SQL statements issued and
 * control what the SELECT queries return. No live DB required.
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { backfillInvokedPositions } from "./backfill-invoked-positions.ts";

// ---------------------------------------------------------------------------
// Minimal SurrealClient mock
// ---------------------------------------------------------------------------

type QueryFn = (sql: string) => unknown;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type InvokedRow = {
    id: string;
    session: string;
    seq: number;
    skill: string;
};

type TurnCountRow = {
    session: string;
    n: number;
};

function makeQueryFn(
    invokedRows: InvokedRow[],
    turnCountRows: TurnCountRow[],
    secondRunInvokedRows: InvokedRow[] = [],
): { fn: QueryFn; callCount: { value: number } } {
    const callCount = { value: 0 };
    const fn: QueryFn = (sql: string) => {
        if (sql.includes("FROM invoked") && sql.includes("turn_index IS NONE")) {
            callCount.value += 1;
            // First call returns fixture rows; subsequent calls return empty (idempotency)
            if (callCount.value === 1) return [invokedRows];
            return [secondRunInvokedRows];
        }
        if (sql.includes("FROM turn") && sql.includes("GROUP BY session")) {
            return [turnCountRows];
        }
        // UPDATE statements (and statement-exec chunk calls) - return success
        return [[]];
    };
    return { fn, callCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backfillInvokedPositions", () => {
    test("computes correct turn_index, total_turns, and is_first for 2 sessions × 2 skills", async () => {
        const invokedRows: InvokedRow[] = [
            // session-A, skill-alpha: seq 3 and 7
            { id: "invoked:edge_a1", session: "session:A", seq: 3, skill: "skill:alpha" },
            { id: "invoked:edge_a2", session: "session:A", seq: 7, skill: "skill:alpha" },
            // session-A, skill-beta: seq 5
            { id: "invoked:edge_a3", session: "session:A", seq: 5, skill: "skill:beta" },
            // session-B, skill-alpha: seq 2
            { id: "invoked:edge_b1", session: "session:B", seq: 2, skill: "skill:alpha" },
            // session-B, skill-beta: seq 4 and 6
            { id: "invoked:edge_b2", session: "session:B", seq: 4, skill: "skill:beta" },
            { id: "invoked:edge_b3", session: "session:B", seq: 6, skill: "skill:beta" },
        ];

        const turnCountRows: TurnCountRow[] = [
            { session: "session:A", n: 10 },
            { session: "session:B", n: 8 },
        ];

        const issued: string[] = [];
        const { fn } = makeQueryFn(invokedRows, turnCountRows);

        const mockDb = {
            query: (sql: string) =>
                Effect.sync(() => {
                    issued.push(sql);
                    return fn(sql);
                }),
        } as unknown as typeof SurrealClient.Service;

        const result = await Effect.runPromise(
            backfillInvokedPositions().pipe(
                Effect.provideService(SurrealClient, mockDb),
            ),
        );

        expect(result.backfilled).toBe(6);
        expect(result.sessions).toBe(2);

        // The statements are batched into a single db.query() call by
        // executeStatementsWith (chunk.join("")). Split the combined string
        // back into individual UPDATE statements for inspection.
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
        // Return empty missing rows on the SELECT
        const mockDb = {
            query: (sql: string) =>
                Effect.sync(() => {
                    issued.push(sql);
                    if (sql.includes("FROM invoked") && sql.includes("turn_index IS NONE")) {
                        return [[]]; // no missing rows
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

        // No UPDATE statements should be issued.
        const allSql = issued.join(" ");
        expect(allSql).not.toContain("UPDATE invoked:");
    });

    test("all UPDATE statements carry a NONE-guard WHERE clause (idempotency guard)", async () => {
        const invokedRows: InvokedRow[] = [
            { id: "invoked:x1", session: "session:X", seq: 1, skill: "skill:foo" },
        ];
        const turnCountRows: TurnCountRow[] = [{ session: "session:X", n: 3 }];

        const issued: string[] = [];
        const { fn } = makeQueryFn(invokedRows, turnCountRows);

        const mockDb = {
            query: (sql: string) =>
                Effect.sync(() => {
                    issued.push(sql);
                    return fn(sql);
                }),
        } as unknown as typeof SurrealClient.Service;

        await Effect.runPromise(
            backfillInvokedPositions().pipe(
                Effect.provideService(SurrealClient, mockDb),
            ),
        );

        // All UPDATE clauses (batched into combined sql) carry the NONE-guard.
        const allSql = issued.join(" ");
        // There is exactly one UPDATE in this fixture.
        expect(allSql).toContain("UPDATE invoked:x1");
        expect(allSql).toContain("WHERE turn_index IS NONE OR total_turns IS NONE OR is_first IS NONE");
    });
});
