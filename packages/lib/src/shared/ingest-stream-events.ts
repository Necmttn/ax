/**
 * Shared contract for live ingest progress events streamed to the studio SPA
 * over Durable Streams. Lives in @ax/lib/shared so both the axctl daemon
 * (producer, apps/axctl/src/ingest/stream-events.ts) and the studio SPA
 * (consumer, apps/studio/src/use-ingest-stream.ts) can import it without
 * reaching across workspace boundaries.
 */
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
    | { readonly kind: "stage_finished"; readonly runId: string; readonly stage: string; readonly status: "ok" | "error"; readonly durationMs: number }
    | { readonly kind: "run_finished"; readonly runId: string; readonly status: "completed" | "failed"; readonly durationMs: number };
