/**
 * Shared contract for live ingest progress events streamed to the studio SPA
 * over Durable Streams. Lives in @ax/lib/shared so both the axctl daemon
 * (producer, apps/axctl/src/ingest/stream-events.ts) and the studio SPA
 * (consumer, apps/studio/src/use-ingest-stream.ts) can import it without
 * reaching across workspace boundaries.
 */
/** One skipped file's failure detail, as recorded by the ingest stage's
 *  per-file failure collector (apps/axctl/src/ingest/file-isolation.ts). */
export interface IngestFileFailure {
    readonly filePath: string;
    /** Error tag (`DbError`, `SkillParseError`, ...) or constructor name. */
    readonly tag: string;
    readonly message: string;
}

export type IngestStreamEvent =
    | { readonly kind: "run_started"; readonly runId: string; readonly label: string }
    | { readonly kind: "stage_started"; readonly runId: string; readonly stage: string }
    | {
        readonly kind: "stage_progress";
        readonly runId: string;
        readonly stage: string;
        readonly current: number;
        readonly total: number;
        readonly ratePerSec: number;
        readonly etaLeftMs: number | null;
        /** 1-based index of this stage among those started so far. */
        readonly stageIndex: number;
    }
    | {
        /**
         * Cumulative skipped-file snapshot for one stage. Re-published on each
         * new failure (each snapshot supersedes the previous one for the same
         * stage), so the Live tab shows the count climb while the stage runs
         * AND a Durable Stream replay reconverges on the final list. `failures`
         * is capped by the collector (25 details); `total` is not.
         */
        readonly kind: "stage_file_failures";
        readonly runId: string;
        readonly stage: string;
        readonly total: number;
        readonly failures: ReadonlyArray<IngestFileFailure>;
    }
    | { readonly kind: "stage_finished"; readonly runId: string; readonly stage: string; readonly status: "ok" | "error"; readonly durationMs: number }
    | { readonly kind: "run_finished"; readonly runId: string; readonly status: "completed" | "failed"; readonly durationMs: number };
