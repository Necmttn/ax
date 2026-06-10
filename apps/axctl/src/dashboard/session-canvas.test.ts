/**
 * Tests for src/dashboard/session-canvas.ts orchestration task fetch.
 *
 * Regression guard for the per-child indexed dispatch-task read: the orch task
 * fetch must hit each child with `session = <ref> ... LIMIT 1` (turn_session_seq),
 * never `turn WHERE session IN [<all children>]` (a membership scan over the
 * 560k-row turn table, ~1.3s for 117 children).
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { fetchSessionOrchestration } from "./session-canvas.ts";

function makeMockDb(): { layer: Layer.Layer<SurrealClient>; captured: string[] } {
    const captured: string[] = [];
    const impl: SurrealClientShape = {
        query: <T extends unknown[] = unknown[]>(sql: string) => {
            captured.push(sql);
            if (sql.includes("FROM session WHERE <string>id")) {
                return Effect.succeed([[
                    { id: "session:parent", label: "Parent", started_at: "2026-05-01T00:00:00.000Z", ended_at: "2026-05-01T01:00:00.000Z" },
                ]] as unknown as T);
            }
            if (sql.includes("FROM spawned")) {
                return Effect.succeed([[
                    { id: "session:`c1`", nickname: "scout", ts: "2026-05-01T00:05:00.000Z", started_at: "2026-05-01T00:05:00.000Z", ended_at: "2026-05-01T00:10:00.000Z" },
                    { id: "session:`c2`", nickname: null, ts: "2026-05-01T00:06:00.000Z", started_at: "2026-05-01T00:06:00.000Z", ended_at: "2026-05-01T00:12:00.000Z" },
                ]] as unknown as T);
            }
            if (sql.includes("FROM turn WHERE session = session:`c1`")) {
                return Effect.succeed([[{ s: "session:`c1`", text_excerpt: "do task A", seq: 0 }]] as unknown as T);
            }
            if (sql.includes("FROM turn WHERE session = session:`c2`")) {
                return Effect.succeed([[{ s: "session:`c2`", text_excerpt: "do task B", seq: 1 }]] as unknown as T);
            }
            return Effect.succeed([[]] as unknown as T);
        },
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    };
    return { layer: Layer.succeed(SurrealClient, impl), captured };
}

describe("fetchSessionOrchestration task fetch", () => {
    test("reads each child's dispatch task via per-child indexed query, never `session IN`", async () => {
        const { layer, captured } = makeMockDb();

        const orch = await Effect.runPromise(
            fetchSessionOrchestration("session:parent").pipe(Effect.provide(layer)),
        );

        // Regression: no membership scan over the turn table.
        for (const sql of captured) {
            if (sql.includes("FROM turn")) {
                expect(sql).not.toContain("session IN");
                expect(sql).toContain("LIMIT 1");
            }
        }
        // One indexed per-child read each.
        expect(captured.some((s) => s.includes("FROM turn WHERE session = session:`c1`"))).toBe(true);
        expect(captured.some((s) => s.includes("FROM turn WHERE session = session:`c2`"))).toBe(true);

        // Tasks mapped onto the right subagents.
        const byId = new Map(orch.subagents.map((sub) => [sub.id, sub.task]));
        expect(byId.get("session:`c1`")).toBe("do task A");
        expect(byId.get("session:`c2`")).toBe("do task B");
    });
});
