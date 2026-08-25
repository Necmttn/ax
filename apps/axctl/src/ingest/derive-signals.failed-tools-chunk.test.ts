/**
 * The failed-tool-calls read that feeds friction/diagnostic events was a
 * SEPARATE, still-unbounded materialisation from the turns fetch (#1021
 * chunked turns; #1043 chunks this): `fetchFailedToolCalls` pulled every
 * error `tool_call` in the window - 17 columns, including the text columns
 * `output_excerpt` / `error_text` - into one JS array via a single
 * `write.rows(...)`. Past ~60-90 days of history that crossed a threshold
 * that segfaulted the DuckDB->JS bridge at ~2.5 GB RSS, even though the
 * turns pass itself was already chunked and healthy.
 *
 * This suite pins the property that MUST survive folding that fetch into the
 * per-{@link SESSION_BATCH_SIZE} chunk loop: every error tool_call across
 * every chunk (a full batch plus a short remainder batch) is still captured
 * exactly once as a friction event AND a diagnostic event - chunking must
 * change memory shape, not output. It derives against a REAL DuckDB (the
 * same fixture harness `derive-signals.chunk.test.ts` and
 * `derive-signals.window.test.ts` use).
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { deriveSignals, SESSION_BATCH_SIZE, type DeriveStats } from "./derive-signals.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("derive signals failed-tools chunking", { requireFts: true });

// One full batch plus a remainder, so the loop crosses a chunk boundary and
// the last chunk is short - the two cases a boundary bug hits. Every session
// carries exactly one failed tool_call, so the expected friction/diagnostic
// count is known up front: SESSION_COUNT of each, no more, no less.
const SESSION_COUNT = SESSION_BATCH_SIZE + 7;
const RECENT = new Date();

const runFixture = (): Promise<DeriveStats> =>
    runWithPlatform(Effect.gen(function* () {
        let stats: DeriveStats | undefined;
        yield* publishCacheFixture(tempDir("ax-signals-failed-tools-chunk-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => ({
                    id: `s${String(i).padStart(4, "0")}`,
                    source: "claude",
                    started_at: RECENT,
                }));
                yield* write.putMany("session", sessions);
                const turns = sessions.map((s) => ({
                    id: `${s.id}-t0`,
                    session: s.id,
                    seq: 1n,
                    ts: RECENT,
                    role: "user",
                    text_excerpt: "work",
                }));
                yield* write.putMany("turn", turns);
                const toolCalls = sessions.map((s) => ({
                    id: `${s.id}-tc0`,
                    session: s.id,
                    turn: `${s.id}-t0`,
                    name: "Bash",
                    seq: 1n,
                    command_norm: "bun test",
                    ts: RECENT,
                    has_error: true,
                    error_text: "exit 1",
                    exit_code: 1n,
                }));
                yield* write.putMany("tool_call", toolCalls);
                stats = yield* deriveSignals(write, {});
            }));
        if (stats === undefined) return yield* Effect.die("fixture body did not run");
        return stats;
    }));

describe("deriveSignals failed-tool-calls chunking (#1043)", () => {
    dtest("captures every error tool_call's friction + diagnostic event across chunk boundaries", async () => {
        const stats = await runFixture();
        expect(stats.sessions).toBe(SESSION_COUNT);
        // One error per session -> exactly one friction + one diagnostic
        // event per session, regardless of chunk boundaries. A dropped chunk
        // undercounts; a double-fetched chunk overcounts - both fail here.
        expect(stats.frictionEvents).toBe(SESSION_COUNT);
        expect(stats.diagnosticEvents).toBe(SESSION_COUNT);
    });
});
