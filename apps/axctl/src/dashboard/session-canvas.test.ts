/**
 * Tests for src/dashboard/session-canvas.ts orchestration task fetch.
 *
 * Regression guard for the per-child dispatch-task read: the orch task fetch
 * must hit each child with its own `session = ?` LIMIT 1 query (indexed),
 * never a single `turn WHERE session IN (<all children>)` membership scan
 * over the 560k-row turn table (~1.3s for 117 children in dogfood). Under
 * DuckDB this is true by construction (ORCH_TASK_SQL always binds exactly
 * one session id per call, fanned out via Effect.forEach) - this test pins
 * the OUTCOME (each child gets its own correct task) against a real fixture.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { fetchSessionOrchestration } from "./session-canvas.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("session-canvas", { requireFts: true });

const FIXTURE = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [
            { id: "parent", project: "ax", started_at: new Date("2026-05-01T00:00:00Z"), ended_at: new Date("2026-05-01T01:00:00Z") },
            { id: "c1", project: null, started_at: new Date("2026-05-01T00:05:00Z"), ended_at: new Date("2026-05-01T00:10:00Z") },
            { id: "c2", project: null, started_at: new Date("2026-05-01T00:06:00Z"), ended_at: new Date("2026-05-01T00:12:00Z") },
        ]);
        yield* w.putMany("spawned", [
            { id: "sp1", in_id: "parent", out_id: "c1", nickname: "scout", ts: new Date("2026-05-01T00:05:00Z") },
            { id: "sp2", in_id: "parent", out_id: "c2", nickname: null, ts: new Date("2026-05-01T00:06:00Z") },
        ]);
        yield* w.putMany("turn", [
            { id: "t1", session: "c1", seq: 0, ts: new Date("2026-05-01T00:05:00Z"), role: "user", text_excerpt: "do task A" },
            { id: "t2", session: "c2", seq: 0, ts: new Date("2026-05-01T00:06:00Z"), role: "user", text_excerpt: "do task B" },
            // A later user turn in c1 must NOT win (seq ASC LIMIT 1 - first wins).
            { id: "t3", session: "c1", seq: 1, ts: new Date("2026-05-01T00:07:00Z"), role: "user", text_excerpt: "do task A, follow-up" },
        ]);
    });

describe("fetchSessionOrchestration", () => {
    dtest("maps each child's own first-user-turn dispatch task, not a cross-child mixup", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-session-canvas-"), dylibPath, FIXTURE));
        const orch = await readThroughFixture(fixture, dylibPath, fetchSessionOrchestration("parent"));

        expect(orch.session_id).toBe("parent");
        expect(orch.subagents.length).toBe(2);

        const byId = new Map(orch.subagents.map((sub) => [sub.id, sub.task]));
        expect(byId.get("c1")).toBe("do task A");
        expect(byId.get("c2")).toBe("do task B");

        const c1 = orch.subagents.find((s) => s.id === "c1");
        expect(c1?.nickname).toBe("scout");
        expect(c1?.duration_ms).toBe(5 * 60_000);
    });

    dtest("a parent with no children returns an empty subagent list", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-session-canvas-solo-"), dylibPath, (w: CacheWriteService) =>
                w.putMany("session", [{ id: "solo-parent" }]),
            ),
        );
        const orch = await readThroughFixture(fixture, dylibPath, fetchSessionOrchestration("solo-parent"));

        expect(orch.subagents).toEqual([]);
    });
});
