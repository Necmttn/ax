import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { deriveMetrics } from "./derive-metrics.ts";
import { SurrealClient } from "@ax/lib/db";

// Capture UPSERTs to session_metrics; serve canned reads. The query-routing
// order matters: the dirty-set query (`... FROM session WHERE ... OR id IN
// (SELECT VALUE in FROM produced WHERE out.reverted = true)`) contains BOTH
// `FROM session` and `FROM produced`, so it must be matched (by `FROM session
// WHERE`) BEFORE the durability/time-to-land `FROM produced` branch.
const makeDb = (sink: string[]) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/UPSERT session_metrics|UPDATE commit/.test(sql)) {
                sink.push(sql);
                return Effect.succeed([[]] as unknown as T);
            }
            // commit-reverted existing-true set; "WHERE out.reverted" won't match.
            if (/WHERE reverted = true/.test(sql)) return Effect.succeed([[]] as unknown as T);
            // dirty-set: a VALUE select returning one dirty session id.
            if (/FROM session WHERE/.test(sql)) return Effect.succeed([["session:`s1`"]] as unknown as T);
            if (/FROM commit\b/.test(sql)) return Effect.succeed([[]] as unknown as T);
            if (/FROM touched/.test(sql)) return Effect.succeed([[]] as unknown as T);
            if (/FROM session_health/.test(sql)) return Effect.succeed([[]] as unknown as T);
            // durability (and time-to-land, harmlessly) aggregate.
            if (/FROM produced/.test(sql)) {
                return Effect.succeed([[{ session: "session:`s1`", produced: 2, reverted: 0 }]] as unknown as T);
            }
            if (/FROM tool_call/.test(sql)) return Effect.succeed([[]] as unknown as T);
            // wave-2: delegation spawn edges (none) - keeps the compute deref-free.
            if (/FROM spawned/.test(sql)) return Effect.succeed([[]] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

describe("deriveMetrics", () => {
    test("recomputes commit.reverted then UPSERTs one row per dirty session", async () => {
        const sink: string[] = [];
        const stats = await Effect.runPromise(deriveMetrics({ sinceDays: 1 }).pipe(Effect.provide(makeDb(sink))));
        expect(sink.some((s) => /UPSERT session_metrics/.test(s) && s.includes("session:`s1`"))).toBe(true);
        // wave-2 fields are present in the UPSERT CONTENT.
        expect(sink.some((s) => /cold_start_reads:/.test(s) && /delegation_ratio:/.test(s) && /time_to_first_edit_ms:/.test(s)))
            .toBe(true);
        expect(stats.sessionsWritten).toBe(1);
    });
});
