// packages/schema/src/duckdb-tables.ts
/** Manifest of every table in schema.duckdb.sql. Mirrors the SchemaTableSpec
 *  shape used by apps/axctl/src/queries/insights.ts (SCHEMA_TABLES) so the
 *  `ax insights schema` view can adopt it in wave 2. Exported, NOT wired. */
import { DUCKDB_TABLE_NAMES } from "./parse-duckdb-schema.ts";

/**
 * The event-layer freeze (#893). Every cache table belongs to exactly one
 * layer, and the layer - not a stage's ingest/derive TAG - is what the write
 * contract checks against (apps/axctl/src/ingest/stage/table-writes.ts):
 *
 * - `event`       - written from OUTSIDE-WORLD bytes: transcripts, git, the
 *                   skills catalog, the OTLP spool, external ledgers, hook
 *                   configs, the GitHub API. The source of truth. NOTE the
 *                   definition is "written from outside bytes", NOT
 *                   "re-readable from the world": some loaders CONSUME their
 *                   source (the usage stage truncates its log; OTLP retention
 *                   prunes), so for those the cache row is the only durable
 *                   copy - which makes them MORE event-like, not less.
 * - `derived`     - written by a derive from event-layer (or sidecar) rows,
 *                   rebuildable with no disk access. Wiping every `derived`
 *                   table is always safe.
 * - `bookkeeping` - the store's own state: watermarks, run/stage telemetry,
 *                   schema-comment state.
 */
export type DuckdbTableLayer = "event" | "derived" | "bookkeeping";

export interface DuckdbTableSpec {
    readonly table: string;
    readonly kind: "node" | "edge";
    /**
     * - `active`      - derived from files on disk (transcripts/git/skills/OTLP
     *                   spool); REBUILDABLE, dropped + re-derived on a cache rebuild.
     * - `conditional` - active, but only written under a runtime gate (e.g. a
     *                   GitHub remote + working `gh`).
     * - `staged`      - reserved/not-yet-wired; also rebuildable.
     *
     * There is no `sidecar` stage any more, and that is the point: durable
     * judgment is not a FLAG on a cache table, it is a table in a different
     * file and a different engine (schema.sidecar.sql, `SIDECAR_JUDGMENT_TABLES`
     * in ./sidecar-tables.ts). Every table in THIS manifest is rebuildable.
     */
    readonly stage: "active" | "conditional" | "staged";
    /** Event-layer classification (#893) - see {@link DuckdbTableLayer}. For
     *  `staged` (reserved) tables the layer records intent; nothing writes
     *  them, so no enforcement rides on it yet. */
    readonly layer: DuckdbTableLayer;
    readonly note: string;
}

// Durable judgment tables moved OUT of this manifest with the DDL that defined
// them: `SIDECAR_JUDGMENT_TABLES` now lives in ./sidecar-tables.ts, next to
// schema.sidecar.sql. Keeping the enumeration here while the tables lived
// elsewhere would have been a second source of truth for the boundary.

/**
 * Hand-authored editorial metadata (kind/stage/layer/note) keyed by table name -
 * real content the DDL itself does not carry, so it stays hand-maintained.
 * The exported `DUCKDB_SCHEMA_TABLES` manifest below is DERIVED from
 * `DUCKDB_TABLE_NAMES` (the parsed DDL), not from this map's own keys, so a
 * table the DDL adds with no entry here - or an entry here for a table the
 * DDL no longer has - fails at import time (see `buildManifest`) rather than
 * silently drifting until a test happens to catch it.
 */
const TABLE_METADATA: Readonly<Record<string, Omit<DuckdbTableSpec, "table">>> = {
    skill: { kind: "node", stage: "active", layer: "event", note: "Installed skills and slash commands. SEMANTICS (P2-2): ingested_at used Surreal `VALUE time::now()`, not a DEFAULT - the writer must stamp CURRENT_TIMESTAMP on every insert AND update, since DuckDB DEFAULT only fires on an omitted-column insert." },
    skill_revision: { kind: "node", stage: "active", layer: "event", note: "Append-only skill content-change log (drift over time). SEMANTICS (P2-2): `ts` used Surreal `VALUE time::now()` - the writer must stamp CURRENT_TIMESTAMP on every write, not rely on the DuckDB DEFAULT." },
    agent_def: { kind: "node", stage: "active", layer: "event", note: "Agent definition files (~/.claude/agents) with reconcile lifecycle. SEMANTICS (P2-2): ingested_at used Surreal `VALUE time::now()` - the writer must stamp CURRENT_TIMESTAMP on every write, not rely on the DuckDB DEFAULT." },
    session: { kind: "node", stage: "active", layer: "event", note: "Transcript sessions across all 6 harnesses: Claude Code, Codex, Pi, oh-my-pi/OMP, OpenCode, and Cursor." },
    claude_sidecar_artifact: { kind: "node", stage: "active", layer: "event", note: "Metadata-only Claude project sidecars linked to sessions when safe." },
    used_sidecar_artifact: { kind: "edge", stage: "active", layer: "event", note: "Tool calls that produced, read, searched, or inspected Claude sidecar artifacts." },
    agent_provider: { kind: "node", stage: "active", layer: "event", note: "Agent transcript provider identities." },
    agent_model: { kind: "node", stage: "active", layer: "event", note: "Agent model catalogue with pricing and context metadata." },
    agent_session: { kind: "node", stage: "active", layer: "event", note: "Provider-native session rows linked to normalized sessions." },
    agent_event: { kind: "node", stage: "active", layer: "event", note: "Provider-native event stream rows." },
    turn: { kind: "node", stage: "active", layer: "event", note: "Transcript turns and tool result turns." },
    file: { kind: "node", stage: "active", layer: "event", note: "Canonical repository-relative files plus legacy file rows." },
    symbol: { kind: "node", stage: "staged", layer: "derived", note: "Reserved symbol mention catalogue for code-context queries." },
    error_signature: { kind: "node", stage: "staged", layer: "derived", note: "Reserved normalized error signatures for recurrence queries." },
    commit: { kind: "node", stage: "active", layer: "event", note: "Git commits imported from tracked repositories." },
    repository: { kind: "node", stage: "active", layer: "event", note: "Stable repository identities, preferring normalized remotes." },
    checkout: { kind: "node", stage: "active", layer: "event", note: "Local checkout/worktree paths for repositories." },
    workspace: { kind: "node", stage: "staged", layer: "derived", note: "Reserved for cross-checkout workspace grouping." },
    tool: { kind: "node", stage: "active", layer: "event", note: "Normalized CLI, MCP, and agent tool identities." },
    tool_call: { kind: "node", stage: "active", layer: "event", note: "Tool calls with errors and command fields, from Claude Code, Codex, Pi, OMP, OpenCode, and Cursor." },
    content_type: { kind: "node", stage: "active", layer: "derived", note: "Closed content-type taxonomy for tool outputs." },
    has_content: { kind: "edge", stage: "active", layer: "derived", note: "tool_call -> content_type edge; denormalizes session + bytes." },
    plan: { kind: "node", stage: "active", layer: "event", note: "Current plan state per session/source." },
    plan_item: { kind: "node", stage: "active", layer: "event", note: "Latest stable plan items for each plan." },
    artifact: { kind: "node", stage: "active", layer: "event", note: "Generated reports, dogfood artifacts, and guidance evidence." },
    content_document: { kind: "node", stage: "active", layer: "derived", note: "Parsed document containers for markdown artifacts and plans." },
    content_block: { kind: "node", stage: "active", layer: "derived", note: "Searchable markdown block chunks with source offsets." },
    content_atom: { kind: "node", stage: "active", layer: "derived", note: "Fine-grained parsed document facts and evidence atoms." },
    mentions_file: { kind: "edge", stage: "active", layer: "derived", note: "Content atom to file mention edges." },
    mentions_commit: { kind: "edge", stage: "active", layer: "derived", note: "Content atom to commit mention edges." },
    mentions_artifact: { kind: "edge", stage: "active", layer: "derived", note: "Content atom to artifact mention edges." },
    plan_snapshot: { kind: "node", stage: "active", layer: "event", note: "Point-in-time TodoWrite/update_plan snapshots." },
    compaction: { kind: "node", stage: "active", layer: "event", note: "Context-compaction events per harness (summarize/history-replacement/encrypted)." },
    insight: { kind: "node", stage: "active", layer: "event", note: "Imported Claude usage-data insight facets." },
    friction_event: { kind: "node", stage: "active", layer: "derived", note: "Tool failures, imported insight friction, and derived friction. LAYER NOTE (#893): classified derived because the signals stage wipes + re-derives it, but the `ax ingest --insights-only` loader also parses IMPORTED rows into it - an enumerated exception in WRITE_MODE_EXCEPTIONS; a full signals re-derive drops the imported rows (pre-existing behavior)." },
    turn_analysis: { kind: "node", stage: "active", layer: "derived", note: "Per-turn message analysis for sparse user feedback and assistant behavior." },
    reaction_event: { kind: "node", stage: "active", layer: "derived", note: "Context-aware user reaction events built from prior assistant/tool context." },
    classifier_definition: { kind: "node", stage: "active", layer: "derived", note: "Installed classifier definitions and declared label/target contracts." },
    classifier_run: { kind: "node", stage: "active", layer: "derived", note: "Classifier execution runs over transcript event windows." },
    classifier_result: { kind: "node", stage: "active", layer: "derived", note: "Versioned classifier labels attached to turns and other subjects." },
    classifier_graph_node: { kind: "node", stage: "active", layer: "derived", note: "Generic classifier graph nodes projected from package operations." },
    classifier_graph_edge: { kind: "node", stage: "active", layer: "derived", note: "Generic classifier graph edges projected from package operations." },
    classifier_graph_fact: { kind: "node", stage: "active", layer: "derived", note: "Generic classifier graph facts projected from package operations." },
    transcript_label_vector: { kind: "node", stage: "active", layer: "derived", note: "Embedding vectors and nearest-neighbor refs for transcript label candidates." },
    semantic_signal: { kind: "node", stage: "active", layer: "derived", note: "Reusable meanings promoted from analyzed turns." },
    diagnostic_event: { kind: "node", stage: "active", layer: "derived", note: "Derived diagnostics from failed commands and friction." },
    guidance: { kind: "node", stage: "staged", layer: "event", note: "Persisted behavior controls such as rules, skills, hooks, and commands." },
    guidance_version: { kind: "node", stage: "staged", layer: "event", note: "Legacy guidance history table kept until migration to guidance_revision." },
    guidance_source: { kind: "node", stage: "active", layer: "event", note: "Observed repo-local and global storage authorities for Guidance." },
    guidance_revision: { kind: "node", stage: "active", layer: "event", note: "Content-hashed observed Guidance revisions with evidence strength." },
    guidance_config_artifact: { kind: "node", stage: "active", layer: "event", note: "Metadata-only inventory of provider guidance/config artifacts." },
    stack: { kind: "node", stage: "active", layer: "event", note: "Lean technology/platform records for applicability matching." },
    command_outcome: { kind: "node", stage: "active", layer: "derived", note: "Semantic command result classifications." },
    user_message_ngram: { kind: "node", stage: "active", layer: "derived", note: "Derived user-language n-grams for preference and correction mining." },
    workflow_epoch: { kind: "node", stage: "active", layer: "derived", note: "Derived workflow eras for before/after comparisons." },
    session_token_usage: { kind: "node", stage: "active", layer: "event", note: "Actual or estimated session token/cache usage. LAYER NOTE (#893): event (actuals parsed from transcripts), with two enumerated derived writers - session-health upserts ESTIMATED rows (WRITE_MODE_EXCEPTIONS) and derive-metrics backfills cost columns (ENRICHMENT_COLUMNS)." },
    turn_token_usage: { kind: "node", stage: "active", layer: "event", note: "Provider-derived per-turn token/cache usage. Derive-metrics can backfill its cost columns through ENRICHMENT_COLUMNS." },
    session_health: { kind: "node", stage: "active", layer: "derived", note: "Derived session-level workflow, context, and interruption health." },
    session_metrics: { kind: "node", stage: "active", layer: "derived", note: "Graph-derived per-session metrics (durability, time-to-land, loc)." },
    fragility_cascade: { kind: "node", stage: "active", layer: "derived", note: "Precomputed cross-session fragility-cascade signal edges (origin session -> downstream fixer)." },
    commit_classification: { kind: "node", stage: "active", layer: "derived", note: "Commit message lifecycle classification." },
    branch: { kind: "node", stage: "conditional", layer: "event", note: "GitHub branch state for delivery analytics; written by the github-pr stage (apps/axctl/src/ingest/github-pr-stage.ts, in ALL_STAGES) only for repos with a GitHub remote and a working `gh` CLI - silently skipped otherwise." },
    pull_request: { kind: "node", stage: "conditional", layer: "event", note: "GitHub pull request state for delivery analytics; same gh/GitHub-remote gating as `branch`." },
    review_event: { kind: "node", stage: "conditional", layer: "event", note: "GitHub review events for delivery analytics; same gh/GitHub-remote gating as `branch`." },
    check_run: { kind: "node", stage: "conditional", layer: "event", note: "GitHub check runs for delivery analytics; same gh/GitHub-remote gating as `branch`." },
    delivery_outcome: { kind: "node", stage: "conditional", layer: "event", note: "Session delivery/promotion outcome summaries, written by apps/axctl/src/ingest/github-pr-write.ts under the same gh/GitHub-remote gating as `branch`." },
    workflow_snapshot: { kind: "node", stage: "active", layer: "derived", note: "Precomputed dashboard workflow payload used by /api/workflow." },
    phase_span: { kind: "node", stage: "staged", layer: "derived", note: "Session workflow phase spans and phase-level counters." },
    skill_candidate: { kind: "node", stage: "active", layer: "derived", note: "Evidence-backed candidate skills or guardrails." },
    schema_comment_state: { kind: "node", stage: "active", layer: "bookkeeping", note: "Self-documenting catalog bookkeeping (#869): hash of the last-applied COMMENT ON script, so routine opens skip re-applying (WAL crash-safety)." },
    ingest_run: { kind: "node", stage: "active", layer: "bookkeeping", note: "Top-level ingest execution telemetry." },
    ingest_stage: { kind: "node", stage: "active", layer: "bookkeeping", note: "Per-stage ingest execution telemetry." },
    ingest_event: { kind: "node", stage: "active", layer: "bookkeeping", note: "Append-like ingest progress events." },
    query_sample: { kind: "node", stage: "staged", layer: "bookkeeping", note: "Reserved query execution samples." },
    graph_health_check: { kind: "node", stage: "staged", layer: "bookkeeping", note: "Persisted graph health check rows." },
    invoked: { kind: "edge", stage: "active", layer: "event", note: "Turn-to-skill invocation edges." },
    loaded: { kind: "edge", stage: "active", layer: "derived", note: "Session-to-skill auto-load activations (subagent skills: frontmatter); separate from invoked." },
    proposed: { kind: "edge", stage: "active", layer: "derived", note: "Skills mentioned but not invoked." },
    edited: { kind: "edge", stage: "active", layer: "event", note: "Turn-to-file edit edges." },
    mentioned_file: { kind: "edge", stage: "staged", layer: "event", note: "Reserved turn-to-file mention edges." },
    mentioned_symbol: { kind: "edge", stage: "staged", layer: "derived", note: "Reserved turn-to-symbol mention edges." },
    mentioned_error: { kind: "edge", stage: "staged", layer: "derived", note: "Reserved turn-to-error mention edges." },
    read_file: { kind: "edge", stage: "active", layer: "event", note: "Tool-call-to-file read evidence edges, written by apps/axctl/src/ingest/evidence-writers.ts." },
    searched_file: { kind: "edge", stage: "active", layer: "event", note: "Tool-call-to-file search evidence edges, written by apps/axctl/src/ingest/evidence-writers.ts." },
    corrected_by: { kind: "edge", stage: "active", layer: "derived", note: "Assistant turns followed by user correction signals." },
    expresses: { kind: "edge", stage: "active", layer: "derived", note: "Turn-to-semantic-signal evidence edges." },
    reacts_to: { kind: "edge", stage: "active", layer: "derived", note: "User reaction turns linked to the prior assistant turn they approve, reject, or revise." },
    has_classification: { kind: "edge", stage: "active", layer: "derived", note: "Turn-to-classifier-result edges for versioned labels." },
    produced: { kind: "edge", stage: "active", layer: "derived", note: "Session-to-commit edges." },
    touched: { kind: "edge", stage: "active", layer: "event", note: "Commit-to-file edges with additions/deletions/status." },
    later_fixed_by: { kind: "edge", stage: "active", layer: "derived", note: "Feature commit to later overlapping fix commit relation." },
    suggests_skill: { kind: "edge", stage: "active", layer: "derived", note: "Fix or evidence commit to skill candidate relation." },
    has_checkout: { kind: "edge", stage: "active", layer: "event", note: "Repository-to-checkout edges." },
    concerns: { kind: "edge", stage: "active", layer: "event", note: "Generic evidence edges, currently used for tool/skill and insight/session links." },
    resulted_in: { kind: "edge", stage: "staged", layer: "derived", note: "Reserved generic outcome relation." },
    produced_artifact: { kind: "edge", stage: "staged", layer: "derived", note: "Reserved producer-to-artifact relation." },
    has_artifact: { kind: "edge", stage: "staged", layer: "derived", note: "Reserved owner-to-artifact relation." },
    derived_from: { kind: "edge", stage: "active", layer: "derived", note: "Provenance relation for derived guidance and artifacts." },
    skill_paired: { kind: "edge", stage: "active", layer: "derived", note: "Derived skill co-occurrence edges." },
    recovered_by: { kind: "edge", stage: "active", layer: "derived", note: "Derived recovery edges after an error turn." },
    spawned: { kind: "edge", stage: "active", layer: "event", note: "Parent-to-child delegated session edges. LAYER NOTE (#893): event (the subagents parser writes it from agent-*.jsonl files); derive-spawned also inserts derived edges - an enumerated exception in WRITE_MODE_EXCEPTIONS." },
    advice: { kind: "node", stage: "active", layer: "event", note: "Hook advice ledger rows from ~/.ax/hooks/advise-log.jsonl (route-dispatch additionalContext)." },
    agent_event_child: { kind: "edge", stage: "active", layer: "event", note: "Provider-event parent-child edges." },
    used_model: { kind: "edge", stage: "active", layer: "event", note: "Session-to-agent-model usage edges." },
    agent_used_model: { kind: "edge", stage: "active", layer: "event", note: "Provider-session-to-agent-model usage edges." },
    harness_hook_event: { kind: "node", stage: "active", layer: "event", note: "Native agent harness hook lifecycle events." },
    hook_command_invocation: { kind: "node", stage: "active", layer: "event", note: "Commands invoked by native harness hooks." },
    ax_invocation: { kind: "node", stage: "active", layer: "event", note: "ax's own CLI invocations (redacted) for self-telemetry / utilization." },
    feedback_case_type: { kind: "node", stage: "active", layer: "derived", note: "Feedback backtest case definitions." },
    feedback_case_result: { kind: "node", stage: "active", layer: "derived", note: "Feedback backtest results." },
    hook_fire: { kind: "node", stage: "active", layer: "event", note: "Runtime file-context hook decisions." },
    directive_ngram: { kind: "node", stage: "active", layer: "derived", note: "Per-user n-gram lift table: which user-turn markers predict captured outcomes (directive mining v2, #587)." },
    cites_evidence: { kind: "edge", stage: "active", layer: "derived", note: "Proposal-to-evidence edges." },
    opportunity: { kind: "edge", stage: "active", layer: "derived", note: "Experiment trigger recurrence evidence edges." },
    reviewed: { kind: "edge", stage: "active", layer: "derived", note: "Session-to-retro review edges." },
    ingest_file_state: { kind: "node", stage: "active", layer: "bookkeeping", note: "Per-source ingest watermark (mtime/size/sha) for skip-unchanged re-ingest." },
    otel_metric_point: { kind: "node", stage: "active", layer: "event", note: "Harness OTLP metric data points (cost/token/usage)." },
    otel_span: { kind: "node", stage: "active", layer: "event", note: "Harness OTLP trace spans from generic OTLP span sources; Codex does NOT populate this table - it emits OTLP logs, not spans (see apps/axctl/src/otel/install-config.ts, [otel] exporter targets /v1/logs)." },
    otel_log_event: { kind: "node", stage: "active", layer: "event", note: "Harness OTLP log events (codex events incl. token usage)." },
    harness_tool_event: { kind: "node", stage: "active", layer: "derived", note: "Shared tool decision/result projection from transcript, hooks, and OTLP events." },
    harness_run_context: { kind: "node", stage: "active", layer: "derived", note: "Shared run context projection from transcript and OTLP startup events." },
    wrapped_card: { kind: "node", stage: "active", layer: "event", note: "Agent-authored Wrapped recap cards (ax wrapped publish)." },
    telemetry_of: { kind: "edge", stage: "active", layer: "derived", note: "Edge: session -> otel telemetry row (drawn at ingest)." },
    run_evidence_event: { kind: "node", stage: "active", layer: "derived", note: "Run evidence ledger (#578): normalized claim/observation/verification/boundary events over the graph; backing distinguishes model claim vs tool-backed." },
    run_evidence_ref: { kind: "node", stage: "active", layer: "derived", note: "Run evidence ledger (#578): structural refs/hashes off an evidence event; privacy_level keeps payloads out by default." },
    cache_bust_event: { kind: "node", stage: "active", layer: "derived", note: "Cache-bust ledger (#868): one row per usage row carrying a cache_miss_reason and its ingest-priced cache-creation cost. Queries corroborate against OTLP cost at root-session grain; derived by the cache-bust SQL model, id == turn_token_usage.id." },
    fts_index_state: { kind: "node", stage: "active", layer: "bookkeeping", note: "Skip-unchanged bookkeeping for the FTS rebuild (#909): per-target content digest, so buildFtsIndexes only reruns PRAGMA create_fts_index when the indexed table actually changed." },
    classifier_weights: { kind: "node", stage: "active", layer: "bookkeeping", note: "Learned judgment classifier weights (#911, Phase 5 landed slice): one row per (model_id, feature), seeded from the committed JUDGMENT_MODEL_SEED constants; classifyTurn's default path never reads it, only AX_JUDGMENT_MODEL=learned does." },
};

/**
 * The enumerated enrichment columns (#893): derived data at rest in EVENT
 * rows. An `enrich`-mode TableWrite is legal only on an event table listed
 * here, and only these columns may be UPDATEd by it. This legalizes today's
 * cross-writes EXPLICITLY instead of pretending they do not exist; moving
 * these columns into derived side-tables is out of Phase 4 scope (operator
 * decision on #893: permanent named exception).
 *
 * Writers, for the record:
 * - session.project/repository/checkout - git stage correlation;
 *   session.repository/checkout/cwd - subagents parent backfill (guarded
 *   `WHERE repository IS NULL`); session.reasoning_effort - claude effort
 *   stamp (currently nulled by a parser bug, #898).
 * - invoked.turn_index/total_turns/is_first - invoked-positions backfill;
 *   invoked.was_corrected - signals correction stamping.
 * - session_token_usage.estimated_cost_usd/pricing_source and
 *   turn_token_usage cost columns - derive-metrics cost backfill
 *   (`WHERE estimated_cost_usd IS NULL`).
 * - commit.reverted - derive-metrics revert detection.
 * - turn.intent_kind - `ax derive-intents` (CLI-only writer).
 */
export const ENRICHMENT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
    session: ["project", "repository", "checkout", "cwd", "reasoning_effort"],
    invoked: ["turn_index", "total_turns", "is_first", "was_corrected"],
    session_token_usage: ["estimated_cost_usd", "pricing_source"],
    turn_token_usage: [
        "estimated_input_cost_usd",
        "estimated_output_cost_usd",
        "estimated_cache_creation_cost_usd",
        "estimated_cache_read_cost_usd",
        "estimated_cost_usd",
        "pricing_source",
    ],
    commit: ["reverted"],
    turn: ["intent_kind"],
};

/** Builds the manifest from `DUCKDB_TABLE_NAMES` (the parsed DDL) joined
 *  against `TABLE_METADATA` (the hand-authored editorial content). Throws at
 *  import time - rather than only failing a test that happens to run - when
 *  either side has a table the other does not, so the two can never
 *  silently drift apart. */
function buildManifest(): readonly DuckdbTableSpec[] {
    const missingMetadata = [...DUCKDB_TABLE_NAMES].filter((table) => !(table in TABLE_METADATA));
    if (missingMetadata.length > 0) {
        throw new Error(
            `duckdb-tables.ts: DDL table(s) with no TABLE_METADATA entry: ${missingMetadata.join(", ")}. ` +
                "Add a { kind, stage, layer, note } entry for each before the manifest can build.",
        );
    }
    const staleMetadata = Object.keys(TABLE_METADATA).filter((table) => !DUCKDB_TABLE_NAMES.has(table));
    if (staleMetadata.length > 0) {
        throw new Error(
            `duckdb-tables.ts: TABLE_METADATA entry for table(s) no longer in the DDL: ${staleMetadata.join(", ")}. ` +
                "Remove the stale entry (or the table was renamed and the entry needs the new name).",
        );
    }
    return [...DUCKDB_TABLE_NAMES].map((table) => ({ table, ...TABLE_METADATA[table]! }));
}

export const DUCKDB_SCHEMA_TABLES: readonly DuckdbTableSpec[] = buildManifest();

/** Table -> layer lookup derived from the manifest. */
export const DUCKDB_TABLE_LAYERS: ReadonlyMap<string, DuckdbTableLayer> = new Map(
    DUCKDB_SCHEMA_TABLES.map((spec) => [spec.table, spec.layer]),
);
