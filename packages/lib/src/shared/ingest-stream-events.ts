/**
 * Live-ingest progress event contract, shared between the producer (the daemon's
 * ingest workflow in `apps/axctl`) and consumers (the studio SPA's live view).
 *
 * Lives in `@ax/lib/shared` so both the CLI/daemon and the standalone
 * `@ax/studio` package can depend on a single source of truth. The runtime
 * translation from live-trace events (`ingestStreamEventFromTrace`) stays in
 * `apps/axctl/src/ingest/stream-events.ts`, which re-exports this type.
 */
export type IngestStreamEvent =
    | { readonly kind: "run_started"; readonly runId: string; readonly label: string }
    | { readonly kind: "stage_started"; readonly runId: string; readonly stage: string }
    | { readonly kind: "stage_finished"; readonly runId: string; readonly stage: string; readonly status: "ok" | "error"; readonly durationMs: number }
    | { readonly kind: "run_finished"; readonly runId: string; readonly status: "completed" | "failed"; readonly durationMs: number };
