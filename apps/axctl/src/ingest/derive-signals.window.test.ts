/**
 * The `--since` window of the signals derive, exercised against a REAL DuckDB.
 *
 * Both filters here are `ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL
 * 'N days'`. The CAST is load-bearing: `CURRENT_TIMESTAMP` is TIMESTAMPTZ, and
 * TIMESTAMPTZ minus INTERVAL binds only when the ICU extension is present. The
 * ax static build ships WITHOUT ICU, so the uncast form is a binder error there
 * - while the dylib these tests resolve DOES carry ICU, so this suite cannot
 * fail on the ICU question itself. What it does pin is the SEMANTICS: a windowed
 * derive must see the recent rows and not the old ones. A revert to a broken
 * spelling that still binds (or a filter dropped entirely) is caught here; a
 * revert to the uncast TIMESTAMPTZ form is caught only on an ICU-less build.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { deriveSignals, type DeriveStats } from "./derive-signals.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("derive signals window", { requireFts: true });

const RECENT = new Date();
const ANCIENT = new Date(Date.now() - 90 * 86_400_000);

interface Runs {
    readonly windowed: DeriveStats;
    readonly allTime: DeriveStats;
}

const runFixture = (): Promise<Runs> =>
    runWithPlatform(Effect.gen(function* () {
        let runs: Runs | undefined;
        yield* publishCacheFixture(tempDir("ax-signals-window-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("session", { id: "s1", source: "claude", started_at: ANCIENT });
                yield* write.putMany("turn", [
                    { id: "turn-old", session: "s1", seq: 1n, ts: ANCIENT, role: "user", text_excerpt: "old work" },
                    { id: "turn-new", session: "s1", seq: 2n, ts: RECENT, role: "user", text_excerpt: "new work" },
                ]);
                yield* write.putMany("tool_call", [
                    {
                        id: "call-old", session: "s1", turn: "turn-old", name: "Bash", seq: 1n,
                        command_norm: "bun test", ts: ANCIENT, has_error: true,
                        error_text: "exit 1", exit_code: 1n,
                    },
                    {
                        id: "call-new", session: "s1", turn: "turn-new", name: "Bash", seq: 2n,
                        command_norm: "bun test", ts: RECENT, has_error: true,
                        error_text: "exit 1", exit_code: 1n,
                    },
                ]);
                const windowed = yield* deriveSignals(write, { sinceDays: 7 }).pipe(Effect.provide(BunFileSystem.layer));
                const allTime = yield* deriveSignals(write, {}).pipe(Effect.provide(BunFileSystem.layer));
                runs = { windowed, allTime };
            }));
        if (runs === undefined) return yield* Effect.die("fixture body did not run");
        return runs;
    }));

describe("deriveSignals --since window", () => {
    dtest("a 7-day window reads the recent turn and skips the 90-day-old one", async () => {
        const runs = await runFixture();
        expect(runs.windowed.turns).toBe(1);
        expect(runs.allTime.turns).toBe(2);
    });

    dtest("a 7-day window reads the recent failed tool call and skips the old one", async () => {
        const runs = await runFixture();
        expect(runs.windowed.frictionEvents).toBe(1);
        expect(runs.allTime.frictionEvents).toBe(2);
    });
});
