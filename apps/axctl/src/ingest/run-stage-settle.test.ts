import { describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { settleStage } from "./run.ts";
import { BaseStageStats } from "./stage/types.ts";
import { CacheWriteUnlockedError } from "@ax/lib/duckdb/seam";
import type { IngestStageError } from "./stage/registry.ts";

class FailedOpenStats extends BaseStageStats.extend<FailedOpenStats>("FailedOpenStats")({
    failedFiles: Schema.Number,
}) {}

/** A concrete member of the `IngestStageError` union (it is a type union, not a
 *  class), so a typed-failure Exit can actually be constructed. */
const stageFailure = (message: string) =>
    new CacheWriteUnlockedError({ livePath: "/tmp/live.duckdb", lockPath: "/tmp/ingest.lock", message });

/**
 * #840. A stage row opens at `running` and must be replaced on EVERY exit path.
 * The wrapper had a success arm (`Effect.tap`) and a typed-failure arm
 * (`Effect.catch`) and nothing else, so an INTERRUPTED stage reached neither -
 * 38 rows accumulated at `running` with no `ended_at` and no reason, 3 of them
 * inside a run that reported `ok`.
 *
 * Interruption is the case no end-to-end ingest test triggers reliably, so
 * these craft the `Exit` directly. That is the whole point: the arm that was
 * missing is the arm that is hardest to reach by accident.
 */

interface Recorded {
    readonly finishes: Array<{ readonly status: unknown; readonly errorText: unknown; readonly counts: unknown }>;
    readonly events: Array<Record<string, unknown>>;
}

/**
 * Minimal recording stub. `writeIngestStageFinish` is one `exec` plus a
 * heartbeat `exec`; `writeIngestEvent` is one `put`. Anything else is a
 * genuine failure of this test's assumptions and should throw loudly rather
 * than silently record nothing.
 */
const recordingWrite = (): { readonly write: CacheWriteService; readonly rec: Recorded } => {
    const rec: Recorded = { finishes: [], events: [] };
    const write = {
        exec: (sql: string, params?: ReadonlyArray<unknown>) =>
            Effect.sync(() => {
                if (sql.includes("UPDATE ingest_stage SET status")) {
                    rec.finishes.push({ status: params?.[0], errorText: params?.[2], counts: params?.[1] });
                }
            }),
        put: (table: string, row: Record<string, unknown>) =>
            Effect.sync(() => {
                if (table === "ingest_event") rec.events.push(row);
            }),
    } as unknown as CacheWriteService;
    return { write, rec };
};

const ledgerKey = { runId: "run1", source: "claude", stage: "transcripts" } as const;
const eventName = { source: "claude", stage: "transcripts" } as const;

const settle = (exit: Exit.Exit<BaseStageStats, IngestStageError>) =>
    Effect.gen(function* () {
        const { write, rec } = recordingWrite();
        yield* settleStage(write, ledgerKey, eventName, exit);
        return rec;
    });

describe("settleStage", () => {
    it("settles an INTERRUPTED stage instead of stranding it at running", async () => {
        const rec = await Effect.runPromise(settle(Exit.interrupt(1 as never)));
        expect(rec.finishes).toHaveLength(1);
        expect(rec.finishes[0]?.status).toBe("interrupted");
        // A terminal row with no reason is the defect; the reason must name the
        // plausible causes because the stage itself cannot tell them apart.
        expect(String(rec.finishes[0]?.errorText)).toContain("interrupted");
        expect(rec.finishes[0]?.errorText).not.toBeNull();
    });

    it("records ok with counts on success", async () => {
        const rec = await Effect.runPromise(
            settle(Exit.succeed(BaseStageStats.make({ durationMs: 5, summary: "done" }))),
        );
        expect(rec.finishes[0]?.status).toBe("ok");
        // `ok` carries no error text - the union forbids supplying one, and the
        // writer nulls the column.
        expect(rec.finishes[0]?.errorText).toBeNull();
        expect(rec.events).toHaveLength(1);
    });

    it("records a failed-open success as an error and warning with counts", async () => {
        const rec = await Effect.runPromise(
            settle(Exit.succeed(FailedOpenStats.make({
                durationMs: 5,
                summary: "skipped",
                failedOpenError: "PermissionDenied: /spool",
                failedFiles: 1,
            }))),
        );
        expect(rec.finishes[0]?.status).toBe("error");
        expect(String(rec.finishes[0]?.errorText)).toContain("PermissionDenied");
        expect(String(rec.finishes[0]?.counts)).toContain("failedFiles");
        expect(rec.events[0]?.level).toBe("warn");
        expect(rec.events[0]?.message).toContain("PermissionDenied");
    });

    it("records error with the failure text on a typed failure", async () => {
        const rec = await Effect.runPromise(
            settle(Exit.fail(stageFailure("boom"))),
        );
        expect(rec.finishes[0]?.status).toBe("error");
        expect(String(rec.finishes[0]?.errorText)).toContain("boom");
    });

    it("settles a DEFECT as error rather than leaving the row open", async () => {
        const rec = await Effect.runPromise(
            settle(Exit.failCause(Cause.die(new Error("unexpected")))),
        );
        expect(rec.finishes[0]?.status).toBe("error");
        expect(String(rec.finishes[0]?.errorText)).toContain("unexpected");
    });

    it("never leaves a settled row without a status", async () => {
        // The property that matters across all four arms, stated once.
        const exits: ReadonlyArray<Exit.Exit<BaseStageStats, IngestStageError>> = [
            Exit.succeed(BaseStageStats.make({ durationMs: 0, summary: "s" })),
            Exit.fail(stageFailure("m")),
            Exit.interrupt(1 as never),
            Exit.failCause(Cause.die(new Error("d"))),
        ];
        for (const exit of exits) {
            const rec = await Effect.runPromise(settle(exit));
            expect(rec.finishes).toHaveLength(1);
            expect(rec.finishes[0]?.status).not.toBe("running");
            expect(typeof rec.finishes[0]?.status).toBe("string");
        }
    });

    it("does not fail the caller when the bookkeeping write fails during interruption", async () => {
        // A run already being torn down must not have its cause replaced by a
        // write error - that is why the interrupt arm ignores failures.
        const write = {
            exec: () => Effect.fail(new Error("db gone") as never),
            put: () => Effect.fail(new Error("db gone") as never),
        } as unknown as CacheWriteService;
        const exit = await Effect.runPromiseExit(
            settleStage(write, ledgerKey, eventName, Exit.interrupt(1 as never)),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
    });
});
