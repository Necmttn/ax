export const INSIGHT_VIEWS = [
    "schema",
    "repositories",
    "checkouts",
    "git",
    "friction",
    "tools",
    "sessions",
    "file-evidence",
    "feedback-loops",
    "feedback-language",
    "message-signals",
    "reactions",
    "reaction-themes",
    "reaction-events",
    "reaction-event-themes",
    "classifier-results",
    "classifier-facts",
    "correction-contexts",
    "classifier-outcomes",
    "harness-candidates",
    "classifier-themes",
    "verification-gaps",
    "user-language",
    "token-impact",
    "cache-health",
    "workflow-impact",
    "codex-health",
    "closure",
    "post-feature-fixes",
    "skill-candidates",
    "graph-health",
] as const;

export type InsightView = (typeof INSIGHT_VIEWS)[number];

export interface SchemaTableSpec {
    readonly table: string;
    readonly stage: "active" | "conditional" | "staged";
    readonly note: string;
}

import { graphHealthSql } from "./graph-health.ts";
import { CODEX_SOURCES_SQL } from "../ingest/source-origin.ts";

export const SCHEMA_TABLES: readonly SchemaTableSpec[] = [
    { table: "advice", stage: "active", note: "Hook advice ledger rows from ~/.ax/hooks/advise-log.jsonl (route-dispatch additionalContext)." },
    { table: "skill", stage: "active", note: "Installed skills and slash commands." },
    { table: "skill_revision", stage: "active", note: "Append-only skill content-change log (drift over time)." },
    { table: "agent_def", stage: "active", note: "Agent definition files (~/.claude/agents) with reconcile lifecycle." },
    { table: "role", stage: "active", note: "Skill role labels used for weighting and grouping." },
    { table: "session", stage: "active", note: "Claude and Codex transcript sessions." },
    { table: "claude_sidecar_artifact", stage: "active", note: "Metadata-only Claude project sidecars linked to sessions when safe." },
    { table: "used_sidecar_artifact", stage: "active", note: "Tool calls that produced, read, searched, or inspected Claude sidecar artifacts." },
    { table: "agent_provider", stage: "active", note: "Agent transcript provider identities." },
    { table: "agent_model", stage: "active", note: "Agent model catalogue with pricing and context metadata." },
    { table: "agent_session", stage: "active", note: "Provider-native session rows linked to normalized sessions." },
    { table: "agent_event", stage: "active", note: "Provider-native event stream rows." },
    { table: "turn", stage: "active", note: "Transcript turns and tool result turns." },
    { table: "file", stage: "active", note: "Canonical repository-relative files plus legacy file rows." },
    { table: "symbol", stage: "staged", note: "Reserved symbol mention catalogue for code-context queries." },
    { table: "error_signature", stage: "staged", note: "Reserved normalized error signatures for recurrence queries." },
    { table: "commit", stage: "active", note: "Git commits imported from tracked repositories." },
    { table: "repository", stage: "active", note: "Stable repository identities, preferring normalized remotes." },
    { table: "checkout", stage: "active", note: "Local checkout/worktree paths for repositories." },
    { table: "workspace", stage: "staged", note: "Reserved for cross-checkout workspace grouping." },
    { table: "tool", stage: "active", note: "Normalized CLI, MCP, and agent tool identities." },
    { table: "tool_call", stage: "active", note: "Claude and Codex tool calls with errors and command fields." },
    { table: "ax_invocation", stage: "active", note: "ax's own CLI invocations (redacted) for self-telemetry / utilization." },
    { table: "plan", stage: "active", note: "Current plan state per session/source." },
    { table: "plan_item", stage: "active", note: "Latest stable plan items for each plan." },
    { table: "artifact", stage: "active", note: "Generated reports, dogfood artifacts, and guidance evidence." },
    { table: "content_document", stage: "active", note: "Parsed document containers for markdown artifacts and plans." },
    { table: "content_block", stage: "active", note: "Searchable markdown block chunks with source offsets." },
    { table: "content_atom", stage: "active", note: "Fine-grained parsed document facts and evidence atoms." },
    { table: "plan_snapshot", stage: "active", note: "Point-in-time TodoWrite/update_plan snapshots." },
    { table: "compaction", stage: "active", note: "Context-compaction events per harness (summarize/history-replacement/encrypted)." },
    { table: "insight", stage: "active", note: "Imported Claude usage-data insight facets." },
    { table: "friction_event", stage: "active", note: "Tool failures, imported insight friction, and derived friction." },
    { table: "turn_analysis", stage: "active", note: "Per-turn message analysis for sparse user feedback and assistant behavior." },
    { table: "reaction_event", stage: "active", note: "Context-aware user reaction events built from prior assistant/tool context." },
    { table: "classifier_definition", stage: "active", note: "Installed classifier definitions and declared label/target contracts." },
    { table: "classifier_run", stage: "active", note: "Classifier execution runs over transcript event windows." },
    { table: "classifier_result", stage: "active", note: "Versioned classifier labels attached to turns and other subjects." },
    { table: "classifier_graph_node", stage: "active", note: "Generic classifier graph nodes projected from package operations." },
    { table: "classifier_graph_edge", stage: "active", note: "Generic classifier graph edges projected from package operations." },
    { table: "classifier_graph_fact", stage: "active", note: "Generic classifier graph facts projected from package operations." },
    { table: "transcript_label_review", stage: "active", note: "Human/agent review verdicts for mined transcript label candidates." },
    { table: "transcript_label_vector", stage: "active", note: "Embedding vectors and nearest-neighbor refs for transcript label candidates." },
    { table: "semantic_signal", stage: "active", note: "Reusable meanings promoted from analyzed turns." },
    { table: "diagnostic_event", stage: "active", note: "Derived diagnostics from failed commands and friction." },
    { table: "guidance", stage: "staged", note: "Persisted behavior controls such as rules, skills, hooks, and commands." },
    { table: "guidance_version", stage: "staged", note: "Legacy guidance history table kept until migration to guidance_revision." },
    { table: "guidance_source", stage: "active", note: "Observed repo-local and global storage authorities for Guidance." },
    { table: "guidance_revision", stage: "active", note: "Content-hashed observed Guidance revisions with evidence strength." },
    { table: "guidance_config_artifact", stage: "active", note: "Metadata-only inventory of provider guidance/config artifacts." },
    { table: "stack", stage: "active", note: "Lean technology/platform records for applicability matching." },
    { table: "command_outcome", stage: "active", note: "Semantic command result classifications." },
    { table: "user_message_ngram", stage: "active", note: "Derived user-language n-grams for preference and correction mining." },
    { table: "directive_ngram", stage: "active", note: "Per-user n-gram lift table: which user-turn markers predict captured outcomes (directive mining v2, #587)." },
    { table: "workflow_epoch", stage: "active", note: "Derived workflow eras for before/after comparisons." },
    { table: "session_token_usage", stage: "active", note: "Actual or estimated session token/cache usage." },
    { table: "turn_token_usage", stage: "active", note: "Provider-derived per-turn token/cache usage and priced cost estimates." },
    { table: "session_health", stage: "active", note: "Derived session-level workflow, context, and interruption health." },
    { table: "session_metrics", stage: "active", note: "Graph-derived per-session metrics (durability, time-to-land, loc)." },
    { table: "fragility_cascade", stage: "active", note: "Precomputed cross-session fragility-cascade signal edges (origin session -> downstream fixer)." },
    { table: "commit_classification", stage: "active", note: "Commit message lifecycle classification." },
    { table: "branch", stage: "staged", note: "GitHub branch state for delivery analytics." },
    { table: "pull_request", stage: "staged", note: "GitHub pull request state for delivery analytics." },
    { table: "review_event", stage: "staged", note: "GitHub review events for delivery analytics." },
    { table: "check_run", stage: "staged", note: "GitHub check runs for delivery analytics." },
    { table: "delivery_outcome", stage: "staged", note: "Session delivery/promotion outcome summaries." },
    { table: "workflow_snapshot", stage: "active", note: "Precomputed dashboard workflow payload used by /api/workflow." },
    { table: "phase_span", stage: "staged", note: "Session workflow phase spans and phase-level counters." },
    { table: "skill_candidate", stage: "active", note: "Evidence-backed candidate skills or guardrails." },
    { table: "proposal", stage: "active", note: "Polymorphic shortlist of repeated workflow improvement candidates." },
    { table: "skill_proposal", stage: "active", note: "Typed payload rows for skill-form proposals." },
    { table: "subagent_proposal", stage: "active", note: "Typed payload rows for subagent-form proposals." },
    { table: "hook_proposal", stage: "active", note: "Typed payload rows for hook-form proposals." },
    { table: "guidance_proposal", stage: "active", note: "Typed payload rows for guidance-file proposals." },
    { table: "automation_proposal", stage: "active", note: "Typed payload rows for automation-form proposals." },
    { table: "experiment", stage: "active", note: "Accepted proposals and scaffold/verdict state." },
    { table: "session_label", stage: "active", note: "Labels stamped on a cache session (spar), durable across a cache rebuild. Sidecar-only - it has no v1 counterpart, which is how it stayed unregistered here." },
    { table: "checkpoint", stage: "active", note: "Experiment measurement snapshots and user verdicts." },
    { table: "retro", stage: "active", note: "Structured session retrospectives." },
    { table: "skill_triage_decision", stage: "active", note: "Dashboard keep/archive/review decisions per skill." },
    { table: "harness_hook_event", stage: "active", note: "Native agent harness hook lifecycle events." },
    { table: "hook_command_invocation", stage: "active", note: "Commands invoked by native harness hooks." },
    { table: "feedback_case_type", stage: "active", note: "Feedback backtest case definitions." },
    { table: "feedback_case_result", stage: "active", note: "Feedback backtest results." },
    { table: "hook_fire", stage: "active", note: "Runtime file-context hook decisions." },
    { table: "dogfood_run", stage: "active", note: "Terminal dogfood scenario results." },
    { table: "ingest_run", stage: "active", note: "Top-level ingest execution telemetry." },
    { table: "ingest_stage", stage: "active", note: "Per-stage ingest execution telemetry." },
    { table: "ingest_event", stage: "active", note: "Append-like ingest progress events." },
    { table: "ingest_file_state", stage: "active", note: "Per-source ingest watermark (mtime/size/sha) for skip-unchanged re-ingest." },
    { table: "query_sample", stage: "staged", note: "Reserved query execution samples." },
    { table: "graph_health_check", stage: "staged", note: "Persisted graph health check rows." },
    { table: "invoked", stage: "active", note: "Turn-to-skill invocation edges." },
    { table: "loaded", stage: "active", note: "Session-to-skill auto-load activations (subagent skills: frontmatter); separate from invoked." },
    { table: "plays_role", stage: "active", note: "Skill-to-role classification edges." },
    { table: "proposed", stage: "active", note: "Skills mentioned but not invoked." },
    { table: "edited", stage: "active", note: "Turn-to-file edit edges." },
    { table: "mentioned_file", stage: "staged", note: "Reserved turn-to-file mention edges." },
    { table: "mentioned_symbol", stage: "staged", note: "Reserved turn-to-symbol mention edges." },
    { table: "mentioned_error", stage: "staged", note: "Reserved turn-to-error mention edges." },
    { table: "read_file", stage: "staged", note: "Reserved tool-call-to-file read evidence edges." },
    { table: "searched_file", stage: "staged", note: "Reserved tool-call-to-file search evidence edges." },
    { table: "corrected_by", stage: "active", note: "Assistant turns followed by user correction signals." },
    { table: "expresses", stage: "active", note: "Turn-to-semantic-signal evidence edges." },
    { table: "reacts_to", stage: "active", note: "User reaction turns linked to the prior assistant turn they approve, reject, or revise." },
    { table: "has_classification", stage: "active", note: "Turn-to-classifier-result edges for versioned labels." },
    { table: "mentions_file", stage: "active", note: "Content atom to file mention edges." },
    { table: "mentions_commit", stage: "active", note: "Content atom to commit mention edges." },
    { table: "mentions_artifact", stage: "active", note: "Content atom to artifact mention edges." },
    { table: "produced", stage: "active", note: "Session-to-commit edges." },
    { table: "touched", stage: "active", note: "Commit-to-file edges with additions/deletions/status." },
    { table: "later_fixed_by", stage: "active", note: "Feature commit to later overlapping fix commit relation." },
    { table: "suggests_skill", stage: "active", note: "Fix or evidence commit to skill candidate relation." },
    { table: "has_checkout", stage: "active", note: "Repository-to-checkout edges." },
    { table: "concerns", stage: "active", note: "Generic evidence edges, currently used for tool/skill and insight/session links." },
    { table: "resulted_in", stage: "staged", note: "Reserved generic outcome relation." },
    { table: "produced_artifact", stage: "staged", note: "Reserved producer-to-artifact relation." },
    { table: "has_artifact", stage: "staged", note: "Reserved owner-to-artifact relation." },
    { table: "derived_from", stage: "active", note: "Provenance relation for derived guidance and artifacts." },
    { table: "skill_paired", stage: "active", note: "Derived skill co-occurrence edges." },
    { table: "recovered_by", stage: "active", note: "Derived recovery edges after an error turn." },
    { table: "spawned", stage: "active", note: "Parent-to-child delegated session edges." },
    { table: "agent_event_child", stage: "active", note: "Provider-event parent-child edges." },
    { table: "used_model", stage: "active", note: "Session-to-agent-model usage edges." },
    { table: "agent_used_model", stage: "active", note: "Provider-session-to-agent-model usage edges." },
    { table: "cites_evidence", stage: "active", note: "Proposal-to-evidence edges." },
    { table: "opportunity", stage: "active", note: "Experiment trigger recurrence evidence edges." },
    { table: "reviewed", stage: "active", note: "Session-to-retro review edges." },
    { table: "wrapped_card", stage: "active", note: "Agent-authored Wrapped recap cards (ax wrapped publish)." },
    { table: "otel_metric_point", stage: "active", note: "Harness OTLP metric data points (cost/token/usage)." },
    { table: "otel_span", stage: "active", note: "Harness OTLP trace spans (Codex session_loop + children)." },
    { table: "otel_log_event", stage: "active", note: "Harness OTLP log events (codex events incl. token usage)." },
    { table: "harness_run_context", stage: "active", note: "Shared run context projection from transcript and OTLP startup events." },
    { table: "harness_tool_event", stage: "active", note: "Shared tool decision/result projection from transcript, hooks, and OTLP events." },
    { table: "telemetry_of", stage: "active", note: "Edge: session -> otel telemetry row (drawn at ingest)." },
    { table: "content_type", stage: "active", note: "Closed content-type taxonomy for tool outputs." },
    { table: "has_content", stage: "active", note: "tool_call -> content_type edge; denormalizes session + bytes." },
    { table: "run_evidence_event", stage: "active", note: "Run evidence ledger (#578): normalized claim/observation/verification/boundary events over the graph; backing distinguishes model claim vs tool-backed." },
    { table: "run_evidence_ref", stage: "active", note: "Run evidence ledger (#578): structural refs/hashes off an evidence event; privacy_level keeps payloads out by default." },
    { table: "schema_comment_state", stage: "active", note: "Self-documenting catalog bookkeeping (#869): hash of the last-applied COMMENT ON script, so routine opens skip re-applying (WAL crash-safety)." },
    { table: "cache_bust_event", stage: "active", note: "Cache-bust ledger (#868): one row per usage row carrying a cache_miss_reason, priced (ingest cost + independent flat-rate corroboration); derived by the cache-bust SQL model, id == turn_token_usage.id." },
    { table: "fts_index_state", stage: "active", note: "Skip-unchanged bookkeeping for the FTS rebuild (#909): per-target content digest, so buildFtsIndexes only reruns PRAGMA create_fts_index when the indexed table actually changed." },
] as const;

export function isInsightView(value: string): value is InsightView {
    return (INSIGHT_VIEWS as readonly string[]).includes(value);
}

function checkedLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new RangeError(`limit must be a positive integer (got ${limit})`);
    }
    return limit;
}

export function repositoryOverviewSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    r.id AS id,
    r.name AS name,
    r.remote_url AS remote_url,
    r.root_path AS root_path,
    r.initial_commit AS initial_commit,
    r.default_branch AS default_branch,
    r.created_at AS created_at,
    r.updated_at AS updated_at,
    COALESCE(r.updated_at, r.created_at) AS last_seen,
    COUNT(c.id) AS checkout_count,
    -- LIST columns are not decodable by the CacheRead wrapper (row-decode.ts
    -- unsupportedColumns) - to_json() renders them as JSON-array VARCHAR
    -- instead. SHAPE CHANGE from the original native array: callers must
    -- JSON.parse checkout_paths/checkout_branches.
    to_json(array_agg(c.path) FILTER (WHERE c.path IS NOT NULL)) AS checkout_paths,
    to_json(array_agg(c.branch) FILTER (WHERE c.branch IS NOT NULL)) AS checkout_branches
FROM repository r
LEFT JOIN has_checkout hc ON hc.in_id = r.id
LEFT JOIN checkout c ON c.id = hc.out_id
GROUP BY r.id, r.name, r.remote_url, r.root_path, r.initial_commit, r.default_branch, r.created_at, r.updated_at
ORDER BY last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function checkoutActivitySql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    c.id AS id,
    c.repository AS repository,
    r.name AS repository_name,
    r.remote_url AS remote_url,
    c.path AS path,
    c.branch AS branch,
    c.worktree_name AS worktree_name,
    c.head_sha AS head_sha,
    c.dirty AS dirty,
    c.created_at AS created_at,
    c.updated_at AS updated_at,
    COALESCE(c.updated_at, c.created_at) AS last_seen,
    (SELECT COUNT(*) FROM session s WHERE s.checkout = c.id) AS session_count,
    (SELECT COUNT(*) FROM turn t JOIN session s ON s.id = t.session WHERE s.checkout = c.id) AS turn_count,
    (SELECT COUNT(*) FROM tool_call tc JOIN session s ON s.id = tc.session WHERE s.checkout = c.id) AS tool_call_count,
    (SELECT COUNT(*) FROM tool_call tc JOIN session s ON s.id = tc.session WHERE s.checkout = c.id AND tc.has_error = TRUE) AS tool_failure_count,
    -- produced denormalises checkout directly onto the edge (see schema) -
    -- equivalent to the original's in.checkout deref, no join needed.
    (SELECT COUNT(*) FROM produced p WHERE p.checkout = c.id) AS produced_count,
    (SELECT COUNT(*) FROM touched WHERE checkout = c.id) AS touched_count
FROM checkout c
LEFT JOIN repository r ON r.id = c.repository
ORDER BY session_count DESC, turn_count DESC, produced_count DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function gitCorrelationSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    r.id AS id,
    r.name AS name,
    r.remote_url AS remote_url,
    r.root_path AS root_path,
    COALESCE(r.updated_at, r.created_at) AS last_seen,
    (SELECT COUNT(*) FROM has_checkout hc WHERE hc.in_id = r.id) AS checkout_count,
    (SELECT COUNT(*) FROM session s WHERE s.repository = r.id) AS session_count,
    (SELECT COUNT(*) FROM session s WHERE s.repository = r.id AND s.checkout IS NOT NULL) AS checkout_linked_session_count,
    (SELECT COUNT(*) FROM "commit" cm WHERE cm.repository = r.id) AS commit_count,
    (SELECT COUNT(*) FROM touched WHERE repository = r.id) AS touched_count,
    -- produced denormalises repository directly onto the edge - equivalent
    -- to the original's out.repository (the commit's repository) deref.
    (SELECT COUNT(*) FROM produced WHERE repository = r.id) AS produced_count
FROM repository r
ORDER BY session_count DESC, produced_count DESC, commit_count DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function recentFrictionSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    fe.id AS id,
    fe.ts AS ts,
    fe.kind AS kind,
    fe.text AS text,
    fe.labels AS labels,
    fe.metrics AS metrics,
    fe.raw AS raw,
    fe.session AS session,
    fe.session AS session_ref,
    s.project AS project,
    s.cwd AS cwd,
    fe.turn AS turn,
    t.seq AS turn_seq
FROM friction_event fe
LEFT JOIN session s ON s.id = fe.session
LEFT JOIN turn t ON t.id = fe.turn
ORDER BY fe.ts DESC
LIMIT ${safeLimit};`.trim();
}

export function toolFailuresSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    name,
    command_norm,
    command_tool,
    exit_code,
    COUNT(*) AS failure_count,
    MAX(ts) AS last_seen,
    COUNT(*) FILTER (WHERE status = 'error') AS status_error_count
FROM tool_call
WHERE has_error = TRUE
GROUP BY name, command_norm, command_tool, exit_code
ORDER BY failure_count DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function sessionEvidenceSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    s.id AS id,
    s.project AS project,
    s.cwd AS cwd,
    s.model AS model,
    s.started_at AS started_at,
    s.ended_at AS ended_at,
    s.repository AS repository,
    s.checkout AS checkout,
    COALESCE(s.ended_at, s.started_at) AS last_seen,
    (SELECT COUNT(*) FROM tool_call tc WHERE tc.session = s.id) AS tool_call_count,
    (SELECT COUNT(*) FROM tool_call tc WHERE tc.session = s.id AND tc.has_error = TRUE) AS tool_failure_count,
    (SELECT COUNT(*) FROM friction_event fe WHERE fe.session = s.id) AS friction_event_count,
    (SELECT COUNT(*) FROM plan_snapshot ps WHERE ps.session = s.id) AS plan_snapshot_count
FROM session s
ORDER BY last_seen DESC
LIMIT ${safeLimit};`.trim();
}

/**
 * A single statement can't return a nested array of result sets, so this
 * UNIONs the three grouped queries into one flat rowset instead, with
 * `relation` as the discriminator column (each caller filters/groups by it
 * client-side).
 */
export function fileEvidenceSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT * FROM (
    SELECT
        'edited' AS relation,
        s.source AS source,
        e.tool AS tool,
        CAST(NULL AS VARCHAR) AS evidence,
        COUNT(*) AS edge_count,
        MAX(e.ts) AS last_seen
    FROM edited e
    JOIN turn t ON t.id = e.in_id
    JOIN session s ON s.id = t.session
    GROUP BY s.source, e.tool
    ORDER BY edge_count DESC, last_seen DESC
    LIMIT ${safeLimit}
)
UNION ALL
SELECT * FROM (
    SELECT
        'read_file' AS relation,
        s.source AS source,
        tc.name AS tool,
        rf.evidence AS evidence,
        COUNT(*) AS edge_count,
        MAX(rf.ts) AS last_seen
    FROM read_file rf
    JOIN tool_call tc ON tc.id = rf.in_id
    JOIN session s ON s.id = tc.session
    GROUP BY s.source, tc.name, rf.evidence
    ORDER BY edge_count DESC, last_seen DESC
    LIMIT ${safeLimit}
)
UNION ALL
SELECT * FROM (
    SELECT
        'searched_file' AS relation,
        s.source AS source,
        tc.name AS tool,
        sf.evidence AS evidence,
        COUNT(*) AS edge_count,
        MAX(sf.ts) AS last_seen
    FROM searched_file sf
    JOIN tool_call tc ON tc.id = sf.in_id
    JOIN session s ON s.id = tc.session
    GROUP BY s.source, tc.name, sf.evidence
    ORDER BY edge_count DESC, last_seen DESC
    LIMIT ${safeLimit}
);`.trim();
}

export function feedbackLoopsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    kind,
    command_norm,
    COUNT(*) AS runs,
    COUNT(*) FILTER (WHERE status = 'error') AS errors,
    MAX(ts) AS last_seen
FROM command_outcome
WHERE kind != 'success' AND command_norm IS NOT NULL
GROUP BY kind, command_norm
ORDER BY errors DESC, runs DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function verificationGapsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    // "Sessions that edited but never verified." (1) anti-join against the
    // verified-session set computed ONCE; (2) filter + limit on the cheap
    // (session, edits) projection, join session meta only for the final N
    // rows. verification_commands is 0 by construction of the filter. `edited`
    // has no denormalised session (unlike `invoked`), so `in.session` is a
    // join through `turn`, same as the original's deref.
    return `
SELECT
    x.session AS id,
    s.project AS project,
    s.cwd AS cwd,
    s.started_at AS started_at,
    s.ended_at AS ended_at,
    x.edits AS edits,
    0 AS verification_commands
FROM (
    SELECT t.session AS session, COUNT(*) AS edits
    FROM edited e
    JOIN turn t ON t.id = e.in_id
    GROUP BY t.session
) x
JOIN session s ON s.id = x.session
WHERE x.edits > 0
  AND x.session NOT IN (
    SELECT session FROM command_outcome
    WHERE kind IN ('expected_feedback', 'product_bug_signal', 'guardrail')
    GROUP BY session
  )
ORDER BY x.edits DESC, s.ended_at DESC
LIMIT ${safeLimit};`.trim();
}

export function userLanguageSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    ngram,
    n,
    count,
    near_correction_count,
    near_failed_tool_count,
    near_edit_count,
    near_verification_count,
    (near_correction_count + near_failed_tool_count + near_edit_count + near_verification_count) AS signal_count,
    first_seen,
    last_seen
FROM user_message_ngram
ORDER BY signal_count DESC, count DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function feedbackLanguageSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    ss.id AS signal,
    ss.kind AS kind,
    ss.label AS label,
    ss.canonical_text AS canonical_text,
    (SELECT COUNT(*) FROM expresses e JOIN turn t ON t.id = e.in_id WHERE e.out_id = ss.id AND t.role = 'user') AS turns,
    (SELECT COUNT(DISTINCT e.session) FROM expresses e JOIN turn t ON t.id = e.in_id WHERE e.out_id = ss.id AND t.role = 'user') AS sessions,
    ss.last_seen AS last_seen,
    -- LIST<STRUCT> is not decodable by the CacheRead wrapper - to_json()
    -- renders it as JSON-array VARCHAR. SHAPE CHANGE: callers JSON.parse.
    (
        SELECT to_json(array_agg(x ORDER BY x.ts DESC)) FROM (
            SELECT t.id AS turn, e.session AS session, t.seq AS seq, t.text_excerpt AS text, e.ts AS ts
            FROM expresses e
            JOIN turn t ON t.id = e.in_id
            WHERE e.out_id = ss.id AND t.role = 'user'
            ORDER BY e.ts DESC
            LIMIT 5
        ) x
    ) AS examples
FROM semantic_signal ss
WHERE ss.kind IN ('feedback', 'correction')
ORDER BY turns DESC, sessions DESC, ss.last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function messageSignalsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    ss.id AS signal,
    ss.kind AS kind,
    ss.label AS label,
    ss.canonical_text AS canonical_text,
    (SELECT COUNT(*) FROM expresses e WHERE e.out_id = ss.id) AS turns,
    (SELECT COUNT(DISTINCT e.session) FROM expresses e WHERE e.out_id = ss.id) AS sessions,
    (SELECT COUNT(*) FROM turn_analysis ta WHERE ta.turn IN (SELECT e.in_id FROM expresses e WHERE e.out_id = ss.id)) AS analyses,
    (SELECT AVG(e.confidence) FROM expresses e WHERE e.out_id = ss.id) AS avg_confidence,
    ss.last_seen AS last_seen,
    -- LIST<STRUCT> is not decodable by the CacheRead wrapper - to_json()
    -- renders it as JSON-array VARCHAR. SHAPE CHANGE: callers JSON.parse.
    (
        SELECT to_json(array_agg(x ORDER BY x.ts DESC)) FROM (
            SELECT t.id AS turn, e.session AS session, t.role AS role, t.seq AS seq, t.text_excerpt AS text, e.ts AS ts
            FROM expresses e
            JOIN turn t ON t.id = e.in_id
            WHERE e.out_id = ss.id
            ORDER BY e.ts DESC
            LIMIT 5
        ) x
    ) AS examples
FROM semantic_signal ss
ORDER BY turns DESC, sessions DESC, ss.last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function reactionsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    rt.id AS id,
    rt.polarity AS polarity,
    rt.act AS act,
    rt.confidence AS confidence,
    ss.label AS signal,
    rt.session AS session,
    rt.in_id AS user_turn,
    ut.seq AS user_seq,
    ut.text_excerpt AS user_text,
    rt.out_id AS assistant_turn,
    atn.seq AS assistant_seq,
    atn.text_excerpt AS assistant_text,
    rt.ts AS ts
FROM reacts_to rt
LEFT JOIN semantic_signal ss ON ss.id = rt.signal
LEFT JOIN turn ut ON ut.id = rt.in_id
LEFT JOIN turn atn ON atn.id = rt.out_id
ORDER BY rt.ts DESC
LIMIT ${safeLimit};`.trim();
}

export function reactionThemesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT signal, kind, label, canonical_text, reactions, sessions, accept, revise, reject, last_seen, examples
FROM (
    SELECT
        ss.id AS signal,
        ss.kind AS kind,
        ss.label AS label,
        ss.canonical_text AS canonical_text,
        (SELECT COUNT(*) FROM reacts_to rt WHERE rt.signal = ss.id) AS reactions,
        (SELECT COUNT(DISTINCT rt.session) FROM reacts_to rt WHERE rt.signal = ss.id) AS sessions,
        (SELECT COUNT(*) FROM reacts_to rt WHERE rt.signal = ss.id AND rt.polarity = 'accept') AS accept,
        (SELECT COUNT(*) FROM reacts_to rt WHERE rt.signal = ss.id AND rt.polarity = 'revise') AS revise,
        (SELECT COUNT(*) FROM reacts_to rt WHERE rt.signal = ss.id AND rt.polarity = 'reject') AS reject,
        (SELECT MAX(rt.ts) FROM reacts_to rt WHERE rt.signal = ss.id) AS last_seen,
        -- LIST<STRUCT> is not decodable by the CacheRead wrapper - to_json()
        -- renders it as JSON-array VARCHAR. SHAPE CHANGE: callers JSON.parse.
        (
            SELECT to_json(array_agg(x ORDER BY x.ts DESC)) FROM (
                SELECT
                    rt.polarity AS polarity,
                    rt.act AS act,
                    rt.in_id AS user_turn,
                    ut.seq AS user_seq,
                    ut.text_excerpt AS user_text,
                    rt.out_id AS assistant_turn,
                    atn.seq AS assistant_seq,
                    atn.text_excerpt AS assistant_text,
                    rt.ts AS ts
                FROM reacts_to rt
                LEFT JOIN turn ut ON ut.id = rt.in_id
                LEFT JOIN turn atn ON atn.id = rt.out_id
                WHERE rt.signal = ss.id
                ORDER BY rt.ts DESC
                LIMIT 3
            ) x
        ) AS examples
    FROM semantic_signal ss
    WHERE ss.kind IN ('feedback', 'correction')
) y
WHERE reactions > 0
ORDER BY reactions DESC, sessions DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function reactionEventsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id,
    reaction_type,
    target,
    polarity,
    durability,
    confidence,
    user_turn,
    assistant_turn,
    session,
    user_text,
    assistant_text,
    context_json,
    signals,
    ts
FROM reaction_event
ORDER BY ts DESC
LIMIT ${safeLimit};`.trim();
}

export function reactionEventThemesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    reaction_type,
    target,
    durability,
    COUNT(*) AS events,
    COUNT(DISTINCT session) AS sessions,
    AVG(confidence) AS avg_confidence,
    MAX(ts) AS last_seen
FROM reaction_event
GROUP BY reaction_type, target, durability
ORDER BY events DESC, sessions DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function classifierResultsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id,
    classifier_key,
    classifier_version,
    label,
    target,
    polarity,
    durability,
    confidence,
    subject_type,
    subject_id,
    turn,
    session,
    evidence_json,
    signals,
    ts
FROM classifier_result
ORDER BY ts DESC
LIMIT ${safeLimit};`.trim();
}

// NOTE (classifier-facts / correction-contexts / classifier-outcomes): the
// per-row context (previous assistant turn, recent failures, later activity)
// is resolved AFTER this query by `enrichInsightRows` (insights-enrich.ts)
// using literal session ids, rather than as a correlated per-row subquery
// here - a correlated form cost ~1s of partial scans per row (~20-38s per
// view at LIMIT 20).
export function classifierFactsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    cr.id AS id,
    cr.classifier_key AS classifier_key,
    cr.classifier_version AS classifier_version,
    cr.label AS label,
    cr.target AS target,
    cr.polarity AS polarity,
    cr.durability AS durability,
    cr.confidence AS confidence,
    cr.subject_type AS subject_type,
    cr.subject_id AS subject_id,
    cr.turn AS turn,
    t.seq AS user_seq,
    t.text_excerpt AS user_text,
    cr.session AS session,
    s.project AS project,
    s.cwd AS cwd,
    cr.evidence_json AS evidence_json,
    cr.signals AS signals,
    cr.ts AS ts
FROM classifier_result cr
LEFT JOIN turn t ON t.id = cr.turn
LEFT JOIN session s ON s.id = cr.session
WHERE cr.turn IS NOT NULL
ORDER BY cr.ts DESC
LIMIT ${safeLimit};`.trim();
}

export function correctionContextsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    cr.id AS id,
    cr.classifier_key AS classifier_key,
    cr.classifier_version AS classifier_version,
    cr.label AS label,
    cr.target AS target,
    cr.polarity AS polarity,
    cr.durability AS durability,
    cr.confidence AS confidence,
    cr.turn AS turn,
    t.seq AS user_seq,
    t.text_excerpt AS user_text,
    cr.session AS session,
    s.project AS project,
    s.cwd AS cwd,
    cr.evidence_json AS evidence_json,
    cr.signals AS signals,
    cr.ts AS ts
FROM classifier_result cr
LEFT JOIN turn t ON t.id = cr.turn
LEFT JOIN session s ON s.id = cr.session
WHERE cr.classifier_key = 'correction-event' OR cr.label = 'correction'
ORDER BY cr.ts DESC
LIMIT ${safeLimit};`.trim();
}

export function classifierOutcomesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    cr.id AS id,
    cr.classifier_key AS classifier_key,
    cr.classifier_version AS classifier_version,
    cr.label AS label,
    cr.target AS target,
    cr.polarity AS polarity,
    cr.durability AS durability,
    cr.confidence AS confidence,
    cr.turn AS turn,
    t.seq AS user_seq,
    t.text_excerpt AS user_text,
    cr.session AS session,
    s.project AS project,
    s.cwd AS cwd,
    cr.ts AS ts
FROM classifier_result cr
LEFT JOIN turn t ON t.id = cr.turn
LEFT JOIN session s ON s.id = cr.session
WHERE cr.turn IS NOT NULL
ORDER BY cr.ts DESC
LIMIT ${safeLimit};`.trim();
}

export function classifierThemesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    classifier_key,
    label,
    target,
    durability,
    COUNT(*) AS results,
    COUNT(DISTINCT session) AS sessions,
    AVG(confidence) AS avg_confidence,
    MAX(ts) AS last_seen
FROM classifier_result
GROUP BY classifier_key, label, target, durability
ORDER BY results DESC, sessions DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function harnessCandidatesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    // LIST columns are not decodable by the CacheRead wrapper - to_json()
    // renders them as JSON-array VARCHAR. SHAPE CHANGE from the original
    // native arrays: callers JSON.parse candidate_id/dedupe_signature.
    return `
SELECT
    to_json(['classifier_harness_candidate', g.classifier_key, g.label, g.target, g.durability]) AS candidate_id,
    to_json([g.classifier_key, g.label, g.target, g.durability]) AS dedupe_signature,
    g.classifier_key AS classifier_key,
    g.label AS label,
    g.target AS target,
    g.durability AS durability,
    g.facts AS facts,
    g.sessions AS sessions,
    g.avg_confidence AS avg_confidence,
    g.last_seen AS last_seen,
    CASE
        WHEN g.target IN ('test_required', 'output_required', 'regression_guard', 'verification') OR g.label = 'verification_request' THEN 'verification'
        WHEN g.target IN ('tooling_preference', 'dev_environment', 'environment_setup') THEN 'environment'
        WHEN g.target IN ('wrong_artifact', 'wrong_output', 'missing_context', 'misclassified_intent', 'prototype_completeness') OR g.label = 'correction' THEN 'representation'
        WHEN g.durability IN ('repo_preference', 'global_preference') OR g.label = 'direction' THEN 'guidance'
        ELSE 'triage'
    END AS proposed_layer,
    CASE
        WHEN g.target IN ('test_required', 'output_required', 'regression_guard', 'verification') OR g.label = 'verification_request' THEN 'add_verification_gate'
        WHEN g.target IN ('tooling_preference', 'dev_environment', 'environment_setup') THEN 'record_environment_preference'
        WHEN g.target IN ('wrong_artifact', 'wrong_output', 'missing_context', 'misclassified_intent', 'prototype_completeness') OR g.label = 'correction' THEN 'add_context_guardrail'
        WHEN g.durability IN ('repo_preference', 'global_preference') OR g.label = 'direction' THEN 'record_guidance'
        ELSE 'review_pattern'
    END AS proposed_action,
    -- LIST<STRUCT> is not decodable by the CacheRead wrapper - to_json()
    -- renders it as JSON-array VARCHAR. SHAPE CHANGE: callers JSON.parse
    -- examples (and, nested inside each example, evidence).
    (
        SELECT to_json(array_agg(ex ORDER BY ex.ts DESC)) FROM (
            SELECT
                cr2.id AS id,
                cr2.classifier_key AS classifier_key,
                cr2.label AS label,
                cr2.target AS target,
                cr2.durability AS durability,
                cr2.confidence AS confidence,
                cr2.turn AS turn,
                t2.seq AS user_seq,
                t2.text_excerpt AS user_text,
                cr2.session AS session,
                cr2.ts AS ts,
                (
                    SELECT to_json(array_agg(ev ORDER BY ev.ts DESC)) FROM (
                        SELECT ce.kind AS kind, ce.out_id AS evidence, ce.ts AS ts
                        FROM cites_evidence ce
                        WHERE ce.in_id = cr2.id
                        ORDER BY ce.ts DESC
                        LIMIT 3
                    ) ev
                ) AS evidence
            FROM classifier_result cr2
            LEFT JOIN turn t2 ON t2.id = cr2.turn
            WHERE cr2.classifier_key = g.classifier_key
              AND cr2.label = g.label
              AND cr2.target = g.target
              AND cr2.durability = g.durability
            ORDER BY cr2.ts DESC
            LIMIT 3
        ) ex
    ) AS examples
FROM (
    SELECT
        classifier_key,
        label,
        target,
        durability,
        COUNT(*) AS facts,
        COUNT(DISTINCT session) AS sessions,
        AVG(confidence) AS avg_confidence,
        MAX(ts) AS last_seen
    FROM classifier_result
    WHERE turn IS NOT NULL
      AND (
        durability IN ('candidate_guidance', 'repo_preference', 'global_preference')
        OR label IN ('correction', 'direction', 'verification_request')
      )
    GROUP BY classifier_key, label, target, durability
) g
ORDER BY g.facts DESC, g.sessions DESC, g.avg_confidence DESC, g.last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function tokenImpactSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    we.name AS workflow_epoch,
    stu.source AS source,
    COUNT(*) AS sessions,
    AVG(stu.estimated_tokens) AS avg_estimated_tokens,
    CAST(SUM(stu.estimated_tokens) AS BIGINT) AS total_estimated_tokens,
    AVG(COALESCE(stu.prompt_tokens, stu.estimated_tokens)) AS avg_prompt_or_estimated_tokens,
    MAX(stu.ts) AS last_seen
FROM session_token_usage stu
LEFT JOIN workflow_epoch we ON we.id = stu.workflow_epoch
GROUP BY we.name, stu.source
ORDER BY last_seen DESC, sessions DESC
LIMIT ${safeLimit};`.trim();
}

export function cacheHealthSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    stu.session AS session,
    stu.source AS source,
    we.name AS workflow_epoch,
    stu.model AS model,
    stu.prompt_tokens AS prompt_tokens,
    stu.completion_tokens AS completion_tokens,
    stu.cache_read_input_tokens AS cache_read_input_tokens,
    stu.cache_creation_input_tokens AS cache_creation_input_tokens,
    CAST(stu.cache_read_input_tokens AS DOUBLE) / NULLIF(stu.prompt_tokens, 0) AS cache_read_ratio,
    CAST(stu.cache_creation_input_tokens AS DOUBLE) / NULLIF(stu.prompt_tokens, 0) AS cache_creation_ratio,
    stu.estimated_tokens AS estimated_tokens,
    stu.transcript_bytes AS transcript_bytes,
    stu.ts AS ts
FROM session_token_usage stu
LEFT JOIN workflow_epoch we ON we.id = stu.workflow_epoch
WHERE stu.prompt_tokens IS NOT NULL OR stu.cache_read_input_tokens IS NOT NULL OR stu.estimated_tokens > 40000
ORDER BY cache_read_ratio ASC, stu.estimated_tokens DESC, stu.ts DESC
LIMIT ${safeLimit};`.trim();
}

export function workflowImpactSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    we.name AS workflow_epoch,
    sh.source AS source,
    COUNT(*) AS sessions,
    AVG(sh.turns) AS avg_turns,
    AVG(sh.tool_calls) AS avg_tool_calls,
    AVG(sh.tool_errors) AS avg_tool_errors,
    AVG(sh.user_corrections) AS avg_user_corrections,
    AVG(sh.interruptions) AS avg_interruptions,
    AVG(sh.subagent_dispatches) AS avg_subagent_dispatches,
    AVG(sh.estimated_tokens) AS avg_estimated_tokens,
    MAX(sh.ts) AS last_seen
FROM session_health sh
LEFT JOIN workflow_epoch we ON we.id = sh.workflow_epoch
GROUP BY we.name, sh.source
ORDER BY last_seen DESC, sessions DESC
LIMIT ${safeLimit};`.trim();
}

export function codexHealthSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    sh.session AS session,
    we.name AS workflow_epoch,
    sh.turns AS turns,
    sh.tool_calls AS tool_calls,
    sh.tool_errors AS tool_errors,
    sh.interruptions AS interruptions,
    sh.subagent_dispatches AS subagent_dispatches,
    sh.plan_snapshots AS plan_snapshots,
    sh.estimated_tokens AS estimated_tokens,
    sh.context_pressure AS context_pressure,
    sh.ts AS ts
FROM session_health sh
LEFT JOIN workflow_epoch we ON we.id = sh.workflow_epoch
WHERE sh.source IN ${CODEX_SOURCES_SQL} AND sh.estimated_tokens > 0
ORDER BY sh.estimated_tokens DESC, sh.tool_errors DESC, sh.turns DESC, sh.ts DESC
LIMIT ${safeLimit};`.trim();
}

export function closureSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    kind,
    COUNT(*) AS commits,
    COUNT(*) FILTER (WHERE confidence = 'high') AS high_confidence,
    MAX(ts) AS last_seen
FROM commit_classification
GROUP BY kind
ORDER BY commits DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function postFeatureFixesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    lfb.in_id AS feature_commit,
    fc.message AS feature_message,
    lfb.out_id AS fix_commit,
    xc.message AS fix_message,
    lfb.repository AS repository,
    lfb.overlap_count AS overlap_count,
    lfb.overlap_files AS overlap_files,
    lfb.days_between AS days_between,
    lfb.confidence AS confidence,
    lfb.reason AS reason,
    lfb.ts AS ts
FROM later_fixed_by lfb
LEFT JOIN "commit" fc ON fc.id = lfb.in_id
LEFT JOIN "commit" xc ON xc.id = lfb.out_id
ORDER BY lfb.overlap_count DESC, lfb.days_between ASC, lfb.ts DESC
LIMIT ${safeLimit};`.trim();
}

export function skillCandidatesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id,
    name,
    trigger_pattern,
    suspected_gap,
    proposed_behavior,
    confidence,
    CASE WHEN confidence = 'high' THEN 3 WHEN confidence = 'medium' THEN 2 ELSE 1 END AS confidence_score,
    expected_impact,
    status,
    metrics,
    created_at
FROM skill_candidate
ORDER BY confidence_score DESC, created_at DESC
LIMIT ${safeLimit};`.trim();
}

// DuckDB string literals are SINGLE-quoted (double quotes denote an
// IDENTIFIER); doubling an embedded quote is the standard SQL escape - no
// backslash processing.
const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * SCHEMA_TABLES entries with no DuckDB DDL yet, discovered by cross-checking
 * every `SCHEMA_TABLES` name against `packages/schema/src/schema.duckdb.sql`
 * (owned by not-yet-ported subsystems - improve/proposal/experiment/retro/
 * dogfood, the skill role-weighting edge). `schemaCoverageSql` degrades their
 * count to a literal 0 instead of a live subquery: DuckDB errors the WHOLE
 * UNION ALL statement on one nonexistent-table reference, so a single missing
 * table would otherwise break every count in the view. Re-check this list
 * each time a chunk lands its own schema.duckdb.sql tables.
 */
const TABLES_PENDING_DUCKDB_SCHEMA = new Set<string>([
    "role",
    "transcript_label_review",
    "proposal",
    "skill_proposal",
    "subagent_proposal",
    "hook_proposal",
    "guidance_proposal",
    "automation_proposal",
    "experiment",
    "checkpoint",
    "retro",
    "skill_triage_decision",
    "dogfood_run",
    "plays_role",
]);

/**
 * UNIONs one `SELECT '<table>', ..., (SELECT COUNT(*) FROM <table>)` per
 * registered table into a flat rowset (~140 inline correlated-subquery
 * counts). Every table name is double-quoted since `"commit"` is a reserved
 * word DuckDB requires quoted (harmless for the rest).
 */
export function schemaCoverageSql(): string {
    const rows = SCHEMA_TABLES.map((spec) => {
        const countExpr = TABLES_PENDING_DUCKDB_SCHEMA.has(spec.table)
            ? "0"
            : `(SELECT COUNT(*) FROM "${spec.table}")`;
        return `SELECT ${sqlString(spec.table)} AS table_name, ${sqlString(spec.stage)} AS stage, ${sqlString(spec.note)} AS note, ${countExpr} AS count`;
    }).join("\nUNION ALL\n");
    return `${rows};`;
}

export function insightSqlForView(view: InsightView, limit: number): string {
    switch (view) {
        case "schema":
            return schemaCoverageSql();
        case "repositories":
            return repositoryOverviewSql(limit);
        case "checkouts":
            return checkoutActivitySql(limit);
        case "git":
            return gitCorrelationSql(limit);
        case "friction":
            return recentFrictionSql(limit);
        case "tools":
            return toolFailuresSql(limit);
        case "sessions":
            return sessionEvidenceSql(limit);
        case "file-evidence":
            return fileEvidenceSql(limit);
        case "feedback-loops":
            return feedbackLoopsSql(limit);
        case "feedback-language":
            return feedbackLanguageSql(limit);
        case "message-signals":
            return messageSignalsSql(limit);
        case "reactions":
            return reactionsSql(limit);
        case "reaction-themes":
            return reactionThemesSql(limit);
        case "reaction-events":
            return reactionEventsSql(limit);
        case "reaction-event-themes":
            return reactionEventThemesSql(limit);
        case "classifier-results":
            return classifierResultsSql(limit);
        case "classifier-facts":
            return classifierFactsSql(limit);
        case "correction-contexts":
            return correctionContextsSql(limit);
        case "classifier-outcomes":
            return classifierOutcomesSql(limit);
        case "harness-candidates":
            return harnessCandidatesSql(limit);
        case "classifier-themes":
            return classifierThemesSql(limit);
        case "verification-gaps":
            return verificationGapsSql(limit);
        case "user-language":
            return userLanguageSql(limit);
        case "token-impact":
            return tokenImpactSql(limit);
        case "cache-health":
            return cacheHealthSql(limit);
        case "workflow-impact":
            return workflowImpactSql(limit);
        case "codex-health":
            return codexHealthSql(limit);
        case "closure":
            return closureSql(limit);
        case "post-feature-fixes":
            return postFeatureFixesSql(limit);
        case "skill-candidates":
            return skillCandidatesSql(limit);
        case "graph-health":
            return graphHealthSql(limit);
    }
}
