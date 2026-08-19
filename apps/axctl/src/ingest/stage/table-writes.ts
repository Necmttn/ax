// apps/axctl/src/ingest/stage/table-writes.ts
/**
 * The event-layer write contract (#893 slice 1, #897).
 *
 * Every DuckDB cache writer declares its writes as `TableWrite` rows
 * ({ table, mode }) - stages on `StageMeta.writes`, everything else in
 * `NON_STAGE_WRITERS` below. `table-writes.test.ts` checks each declared
 * mode against the table's `layer` in `@ax/schema/duckdb-tables`:
 *
 *   parse    -> event tables only
 *   enrich   -> event tables with a non-empty ENRICHMENT_COLUMNS entry
 *   derive   -> derived tables, or an enumerated WRITE_MODE_EXCEPTIONS pair
 *   bookkeep -> bookkeeping tables only
 *
 * The contract binds WRITES, not stage tags - the review round on #893
 * proved tags do not map onto the layer boundary (the `subagents` stage is
 * tagged derive but IS a parser; `usage`/`advice` are external-ledger
 * loaders; `git` is tagged ingest but draws derived `produced` edges).
 */
import { SEGMENT_TABLES } from "../../segment/contract.ts";
import type { TableWrite } from "./types.ts";

const w = (table: string, mode: TableWrite["mode"]): TableWrite => ({ table, mode });

/**
 * Tables reachable through `writeNormalizedTranscriptBatch`
 * (ingest/normalized/transcripts.ts) + the evidence writers it calls. Every
 * transcript provider shares this set; providers whose batches carry empty
 * arrays for a family (e.g. opencode's `toolFileEvidence: []`) still declare
 * the tables - the writer is reached, the row count happens to be zero.
 */
export const NORMALIZED_BATCH_WRITES: readonly TableWrite[] = [
    w("session", "parse"),
    w("agent_provider", "parse"),
    w("agent_session", "parse"),
    w("agent_event", "parse"),
    w("agent_event_child", "parse"),
    w("turn", "parse"),
    w("tool", "parse"),
    w("tool_call", "parse"),
    w("file", "parse"),
    w("edited", "parse"),
    w("read_file", "parse"),
    w("searched_file", "parse"),
    w("skill", "parse"),
    w("invoked", "parse"),
    w("concerns", "parse"),
    w("plan", "parse"),
    w("plan_snapshot", "parse"),
    w("plan_item", "parse"),
    w("compaction", "parse"),
];

/** Watermark + heartbeat bookkeeping written by the shared jsonl work-unit
 *  (ingest/jsonl-work-unit.ts). */
export const JSONL_WORK_UNIT_WRITES: readonly TableWrite[] = [
    w("ingest_file_state", "bookkeep"),
    w("ingest_run", "bookkeep"),
];

/**
 * Enumerated exceptions to the mode-vs-layer base rules - today's known
 * cross-writes, legalized EXPLICITLY (#893 [R#3]) instead of smuggled.
 * Adding a pair here is a design decision, not a fix for a failing test.
 */
export const WRITE_MODE_EXCEPTIONS: readonly {
    readonly writer: string;
    readonly table: string;
    readonly mode: TableWrite["mode"];
    readonly why: string;
}[] = [
    {
        writer: "stage:spawned",
        table: "spawned",
        mode: "derive",
        why: "derive-spawned inserts derived dispatch edges into the event table the subagents parser also writes - no single-writer assumption survives.",
    },
    {
        writer: "stage:session-health",
        table: "session_token_usage",
        mode: "derive",
        why: "session-health upserts ESTIMATED usage rows into the event table, read-modify-write preserving parsed actuals.",
    },
    {
        writer: "cli:ingest-insights",
        table: "friction_event",
        mode: "parse",
        why: "imported Claude usage-data friction lands in the derived table the signals stage wipes on full re-derive (pre-existing).",
    },
];

/**
 * Cache writers that live OUTSIDE the StageDef list (#893 [R#5]). Coarse
 * grain: one entry per writer module/verb. Sidecar-only writers are not
 * listed - the contract covers the DuckDB cache.
 */
export const NON_STAGE_WRITERS: readonly {
    readonly writer: string;
    readonly writes: readonly TableWrite[];
}[] = [
    {
        // run.ts orchestration: run/stage/event telemetry (ingest/telemetry.ts,
        // reap-runs.ts), the OTLP correlation pass (otel/correlate.ts), OTLP
        // 30d retention (otel/retention.ts - a lifecycle delete by the same
        // owner that loads the spool), and the `--reset` wipe-before-reparse.
        writer: "ingest-run",
        writes: [
            w("ingest_run", "bookkeep"),
            w("ingest_stage", "bookkeep"),
            w("ingest_event", "bookkeep"),
            w("telemetry_of", "derive"),
            w("otel_metric_point", "parse"),
            w("otel_span", "parse"),
            w("otel_log_event", "parse"),
            // --reset deletes: event tables ahead of a reparse...
            w("invoked", "parse"),
            w("concerns", "parse"),
            w("skill", "parse"),
            // ...and derived tables (always safe to wipe).
            w("loaded", "derive"),
            w("proposed", "derive"),
            w("recovered_by", "derive"),
            w("skill_paired", "derive"),
        ],
    },
    {
        // cli/commands/ingest.ts maintenance verbs: blob-GC afterWork,
        // onTimeout stamp, `ax ingest reap`, telemetryStage for the
        // derive-signals/insights verbs.
        writer: "cli:ingest-maintenance",
        writes: [w("ingest_run", "bookkeep"), w("ingest_stage", "bookkeep"), w("ingest_event", "bookkeep")],
    },
    {
        // `ax ingest --dry-run` calibrates its ETA by running the claude and
        // codex parsers over a capped file set - REAL writes (ingest/dry-run.ts).
        writer: "cli:ingest-dry-run",
        writes: [
            ...NORMALIZED_BATCH_WRITES,
            w("session_token_usage", "parse"),
            w("turn_token_usage", "parse"),
            w("harness_hook_event", "parse"),
            w("hook_command_invocation", "parse"),
            ...JSONL_WORK_UNIT_WRITES,
        ],
    },
    {
        // `ax sessions here|around|near` transcript auto-backfill
        // (cli/commands/sessions.ts -> ingestTranscripts).
        writer: "cli:sessions-backfill",
        writes: [
            ...NORMALIZED_BATCH_WRITES,
            w("session_token_usage", "parse"),
            w("turn_token_usage", "parse"),
            w("harness_hook_event", "parse"),
            w("hook_command_invocation", "parse"),
            ...JSONL_WORK_UNIT_WRITES,
        ],
    },
    {
        // `ax derive-intents` (CLI-only, no stage): stamps turn.intent_kind.
        writer: "cli:derive-intents",
        writes: [w("turn", "enrich")],
    },
    {
        // `ax ingest --insights-only` (ingest/claude-insights.ts): imports
        // Claude usage-data facets; placeholder session rows for linkage.
        writer: "cli:ingest-insights",
        writes: [w("session", "parse"), w("insight", "parse"), w("concerns", "parse"), w("friction_event", "parse")],
    },
    {
        // `ax wrapped publish` (dashboard/wrapped-cards.ts): replace-all of
        // the agent-authored recap cards.
        writer: "cli:wrapped-publish",
        writes: [w("wrapped_card", "parse")],
    },
    {
        // `ax skills reconcile|rm` / `ax agents reconcile|rm` catalog
        // lifecycle (config-core/reconcile.ts three-pass tombstone).
        writer: "cli:catalog-reconcile",
        writes: [w("skill", "parse"), w("agent_def", "parse")],
    },
    {
        // Classifier CLI writers: workflow-candidates apply, label-mining
        // projectReviewed --apply, package-service execution plans.
        writer: "cli:classifiers",
        writes: [
            w("classifier_graph_node", "derive"),
            w("classifier_graph_edge", "derive"),
            w("classifier_graph_fact", "derive"),
            w("transcript_label_vector", "derive"),
            w("cites_evidence", "derive"),
        ],
    },
    {
        // `ax segment import` (#902): loads session-scoped EVENT rows from a
        // segment directory (column-intersection loader over the contract's
        // table list) and writes the `__imported__/<kind>/<sha>` watermark
        // handshake marks. The write set IS the segment contract, imported so
        // the two cannot drift.
        writer: "cli:segment-import",
        writes: [
            ...SEGMENT_TABLES.map((spec) => w(spec.table, "parse")),
            w("ingest_file_state", "bookkeep"),
        ],
    },
    {
        // The seam's own open path (packages/lib/src/duckdb/seam.ts): DDL
        // replay + COMMENT ON apply hash.
        writer: "seam:open",
        writes: [w("schema_comment_state", "bookkeep")],
    },
];
