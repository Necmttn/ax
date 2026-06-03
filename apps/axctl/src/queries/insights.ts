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

export const SCHEMA_TABLES: readonly SchemaTableSpec[] = [
    { table: "skill", stage: "active", note: "Installed skills and slash commands." },
    { table: "role", stage: "active", note: "Skill role labels used for weighting and grouping." },
    { table: "session", stage: "active", note: "Claude and Codex transcript sessions." },
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
    { table: "changeset", stage: "staged", note: "Reserved for activity-first semantic memory." },
    { table: "file_memory", stage: "staged", note: "Reserved for per-file tribal knowledge and BM25 search." },
    { table: "tool", stage: "active", note: "Normalized CLI, MCP, and agent tool identities." },
    { table: "tool_call", stage: "active", note: "Claude and Codex tool calls with errors and command fields." },
    { table: "plan", stage: "active", note: "Current plan state per session/source." },
    { table: "plan_item", stage: "active", note: "Latest stable plan items for each plan." },
    { table: "artifact", stage: "active", note: "Generated reports, dogfood artifacts, and guidance evidence." },
    { table: "content_document", stage: "active", note: "Parsed document containers for markdown artifacts and plans." },
    { table: "content_block", stage: "active", note: "Searchable markdown block chunks with source offsets." },
    { table: "content_atom", stage: "active", note: "Fine-grained parsed document facts and evidence atoms." },
    { table: "plan_snapshot", stage: "active", note: "Point-in-time TodoWrite/update_plan snapshots." },
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
    { table: "stack", stage: "active", note: "Lean technology/platform records for applicability matching." },
    { table: "command_outcome", stage: "active", note: "Semantic command result classifications." },
    { table: "user_message_ngram", stage: "active", note: "Derived user-language n-grams for preference and correction mining." },
    { table: "workflow_epoch", stage: "active", note: "Derived workflow eras for before/after comparisons." },
    { table: "session_token_usage", stage: "active", note: "Actual or estimated session token/cache usage." },
    { table: "turn_token_usage", stage: "active", note: "Provider-derived per-turn token/cache usage and priced cost estimates." },
    { table: "session_health", stage: "active", note: "Derived session-level workflow, context, and interruption health." },
    { table: "commit_classification", stage: "active", note: "Commit message lifecycle classification." },
    { table: "branch", stage: "staged", note: "GitHub branch state for delivery analytics." },
    { table: "pull_request", stage: "staged", note: "GitHub pull request state for delivery analytics." },
    { table: "review_event", stage: "staged", note: "GitHub review events for delivery analytics." },
    { table: "check_run", stage: "staged", note: "GitHub check runs for delivery analytics." },
    { table: "delivery_outcome", stage: "staged", note: "Session delivery/promotion outcome summaries." },
    { table: "phase_span", stage: "staged", note: "Session workflow phase spans and phase-level counters." },
    { table: "skill_candidate", stage: "active", note: "Evidence-backed candidate skills or guardrails." },
    { table: "proposal", stage: "active", note: "Polymorphic shortlist of repeated workflow improvement candidates." },
    { table: "skill_proposal", stage: "active", note: "Typed payload rows for skill-form proposals." },
    { table: "subagent_proposal", stage: "active", note: "Typed payload rows for subagent-form proposals." },
    { table: "hook_proposal", stage: "active", note: "Typed payload rows for hook-form proposals." },
    { table: "guidance_proposal", stage: "active", note: "Typed payload rows for guidance-file proposals." },
    { table: "automation_proposal", stage: "active", note: "Typed payload rows for automation-form proposals." },
    { table: "experiment", stage: "active", note: "Accepted proposals and scaffold/verdict state." },
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
    { table: "query_sample", stage: "staged", note: "Reserved query execution samples." },
    { table: "graph_health_check", stage: "staged", note: "Persisted graph health check rows." },
    { table: "invoked", stage: "active", note: "Turn-to-skill invocation edges." },
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
    { table: "includes", stage: "staged", note: "Reserved changeset-to-file-memory relation." },
    { table: "involves", stage: "staged", note: "Reserved changeset-to-file relation." },
    { table: "resulted_in", stage: "staged", note: "Reserved generic outcome relation." },
    { table: "supersedes", stage: "staged", note: "Reserved memory/guidance replacement relation." },
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
    id,
    name,
    remote_url,
    root_path,
    initial_commit,
    default_branch,
    created_at,
    updated_at,
    (updated_at ?? created_at) AS last_seen,
    array::len(->has_checkout->checkout) AS checkout_count,
    ->has_checkout->checkout.path AS checkout_paths,
    ->has_checkout->checkout.branch AS checkout_branches
FROM repository
ORDER BY last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function checkoutActivitySql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id,
    repository,
    repository.name AS repository_name,
    repository.remote_url AS remote_url,
    path,
    branch,
    worktree_name,
    head_sha,
    dirty,
    created_at,
    updated_at,
    (updated_at ?? created_at) AS last_seen,
    array::len((SELECT id FROM session WHERE checkout = $parent.id)) AS session_count,
    array::len((SELECT id FROM turn WHERE session.checkout = $parent.id)) AS turn_count,
    array::len((SELECT id FROM tool_call WHERE session.checkout = $parent.id)) AS tool_call_count,
    array::len((SELECT id FROM tool_call WHERE session.checkout = $parent.id AND has_error = true)) AS tool_failure_count,
    array::len((SELECT id FROM produced WHERE in.checkout = $parent.id)) AS produced_count,
    array::len((SELECT id FROM touched WHERE checkout = $parent.id)) AS touched_count
FROM checkout
ORDER BY session_count DESC, turn_count DESC, produced_count DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function gitCorrelationSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id,
    name,
    remote_url,
    root_path,
    (updated_at ?? created_at) AS last_seen,
    array::len(->has_checkout->checkout) AS checkout_count,
    array::len((SELECT id FROM session WHERE repository = $parent.id)) AS session_count,
    array::len((SELECT id FROM session WHERE repository = $parent.id AND checkout IS NOT NONE)) AS checkout_linked_session_count,
    array::len((SELECT id FROM commit WHERE repository = $parent.id)) AS commit_count,
    array::len((SELECT id FROM touched WHERE repository = $parent.id)) AS touched_count,
    array::len((SELECT id FROM produced WHERE out.repository = $parent.id)) AS produced_count
FROM repository
ORDER BY session_count DESC, produced_count DESC, commit_count DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function recentFrictionSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id,
    ts,
    kind,
    text,
    labels,
    metrics,
    raw,
    session,
    session.project AS project,
    session.cwd AS cwd,
    turn,
    turn.seq AS turn_seq
FROM friction_event
ORDER BY ts DESC
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
    count() AS failure_count,
    time::max(ts) AS last_seen,
    math::sum(IF status = "error" THEN 1 ELSE 0 END) AS status_error_count
FROM tool_call
WHERE has_error = true
GROUP BY name, command_norm, command_tool, exit_code
ORDER BY failure_count DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function sessionEvidenceSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id,
    project,
    cwd,
    model,
    started_at,
    ended_at,
    repository,
    checkout,
    (ended_at ?? started_at) AS last_seen,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id)) AS tool_call_count,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id AND has_error = true)) AS tool_failure_count,
    array::len((SELECT id FROM friction_event WHERE session = $parent.id)) AS friction_event_count,
    array::len((SELECT id FROM plan_snapshot WHERE session = $parent.id)) AS plan_snapshot_count
FROM session
ORDER BY last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function fileEvidenceSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
RETURN [
    {
        relation: "edited",
        rows: (
            SELECT
                "edited" AS relation,
                session.source AS source,
                tool,
                count() AS edge_count,
                time::max(ts) AS last_seen
            FROM edited
            GROUP BY source, tool
            ORDER BY edge_count DESC, last_seen DESC
            LIMIT ${safeLimit}
        )
    },
    {
        relation: "read_file",
        rows: (
            SELECT
                "read_file" AS relation,
                in.session.source AS source,
                in.name AS tool,
                evidence,
                count() AS edge_count,
                time::max(ts) AS last_seen
            FROM read_file
            GROUP BY source, tool, evidence
            ORDER BY edge_count DESC, last_seen DESC
            LIMIT ${safeLimit}
        )
    },
    {
        relation: "searched_file",
        rows: (
            SELECT
                "searched_file" AS relation,
                in.session.source AS source,
                in.name AS tool,
                evidence,
                count() AS edge_count,
                time::max(ts) AS last_seen
            FROM searched_file
            GROUP BY source, tool, evidence
            ORDER BY edge_count DESC, last_seen DESC
            LIMIT ${safeLimit}
        )
    }
];`.trim();
}

export function feedbackLoopsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    kind,
    command_norm,
    count() AS runs,
    math::sum(IF status = "error" THEN 1 ELSE 0 END) AS errors,
    time::max(ts) AS last_seen
FROM command_outcome
WHERE kind != "success" AND command_norm IS NOT NONE
GROUP BY kind, command_norm
ORDER BY errors DESC, runs DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function verificationGapsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT * FROM (
    SELECT
        session AS id,
        session.project AS project,
        session.cwd AS cwd,
        session.started_at AS started_at,
        session.ended_at AS ended_at,
        edits,
        array::len((SELECT id FROM command_outcome WHERE session = $parent.session AND kind IN ["expected_feedback", "product_bug_signal", "guardrail"])) AS verification_commands
    FROM (
        SELECT in.session AS session, count() AS edits
        FROM edited
        GROUP BY session
    )
)
WHERE edits > 0 AND verification_commands = 0
ORDER BY edits DESC, ended_at DESC
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
    id AS signal,
    kind,
    label,
    canonical_text,
    array::len((SELECT id FROM expresses WHERE out = $parent.id AND in.role = "user")) AS turns,
    array::len((SELECT session FROM expresses WHERE out = $parent.id AND in.role = "user" GROUP BY session)) AS sessions,
    last_seen,
    (
        SELECT
            in AS turn,
            in.session AS session,
            in.seq AS seq,
            in.text_excerpt AS text,
            ts
        FROM expresses
        WHERE out = $parent.id AND in.role = "user"
        ORDER BY ts DESC
        LIMIT 5
    ) AS examples
FROM semantic_signal
WHERE kind IN ["feedback", "correction"]
ORDER BY turns DESC, sessions DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function messageSignalsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id AS signal,
    kind,
    label,
    canonical_text,
    array::len((SELECT id FROM expresses WHERE out = $parent.id)) AS turns,
    array::len((SELECT session FROM expresses WHERE out = $parent.id GROUP BY session)) AS sessions,
    array::len((SELECT id FROM turn_analysis WHERE turn IN (SELECT in FROM expresses WHERE out = $parent.id).in)) AS analyses,
    math::mean((SELECT confidence FROM expresses WHERE out = $parent.id).confidence) AS avg_confidence,
    last_seen,
    (
        SELECT
            in AS turn,
            in.session AS session,
            in.role AS role,
            in.seq AS seq,
            in.text_excerpt AS text,
            ts
        FROM expresses
        WHERE out = $parent.id
        ORDER BY ts DESC
        LIMIT 5
    ) AS examples
FROM semantic_signal
ORDER BY turns DESC, sessions DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function reactionsSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id,
    polarity,
    act,
    confidence,
    signal.label AS signal,
    session,
    in AS user_turn,
    in.seq AS user_seq,
    in.text_excerpt AS user_text,
    out AS assistant_turn,
    out.seq AS assistant_seq,
    out.text_excerpt AS assistant_text,
    ts
FROM reacts_to
ORDER BY ts DESC
LIMIT ${safeLimit};`.trim();
}

export function reactionThemesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id AS signal,
    kind,
    label,
    canonical_text,
    array::len((SELECT id FROM reacts_to WHERE signal = $parent.id)) AS reactions,
    array::len((SELECT session FROM reacts_to WHERE signal = $parent.id GROUP BY session)) AS sessions,
    array::len((SELECT id FROM reacts_to WHERE signal = $parent.id AND polarity = "accept")) AS accept,
    array::len((SELECT id FROM reacts_to WHERE signal = $parent.id AND polarity = "revise")) AS revise,
    array::len((SELECT id FROM reacts_to WHERE signal = $parent.id AND polarity = "reject")) AS reject,
    time::max((SELECT ts FROM reacts_to WHERE signal = $parent.id).ts) AS last_seen,
    (
        SELECT
            polarity,
            act,
            in AS user_turn,
            in.seq AS user_seq,
            in.text_excerpt AS user_text,
            out AS assistant_turn,
            out.seq AS assistant_seq,
            out.text_excerpt AS assistant_text,
            ts
        FROM reacts_to
        WHERE signal = $parent.id
        ORDER BY ts DESC
        LIMIT 3
    ) AS examples
FROM semantic_signal
WHERE kind IN ["feedback", "correction"] AND array::len((SELECT id FROM reacts_to WHERE signal = $parent.id)) > 0
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
    count() AS events,
    array::len(array::distinct(session)) AS sessions,
    math::mean(confidence) AS avg_confidence,
    time::max(ts) AS last_seen
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

export function classifierFactsSql(limit: number): string {
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
    turn.seq AS user_seq,
    turn.text_excerpt AS user_text,
    session,
    session.project AS project,
    session.cwd AS cwd,
    evidence_json,
    signals,
    ts,
    (
        SELECT
            id,
            seq,
            text_excerpt AS text
        FROM turn
        WHERE session = $parent.session
          AND role = "assistant"
          AND seq < $parent.turn.seq
        ORDER BY seq DESC
        LIMIT 1
    )[0] AS previous_assistant,
    (
        SELECT
            id,
            name,
            command_norm,
            error_text,
            output_excerpt,
            ts
        FROM tool_call
        WHERE session = $parent.session
          AND has_error = true
          AND ts <= $parent.ts
        ORDER BY ts DESC
        LIMIT 3
    ) AS recent_tool_failures
FROM classifier_result
WHERE turn IS NOT NONE
ORDER BY ts DESC
LIMIT ${safeLimit};`.trim();
}

export function correctionContextsSql(limit: number): string {
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
    turn,
    turn.seq AS user_seq,
    turn.text_excerpt AS user_text,
    session,
    session.project AS project,
    session.cwd AS cwd,
    evidence_json,
    signals,
    ts,
    (
        SELECT
            id,
            seq,
            text_excerpt AS text
        FROM turn
        WHERE session = $parent.session
          AND role = "assistant"
          AND seq < $parent.turn.seq
        ORDER BY seq DESC
        LIMIT 1
    )[0] AS previous_assistant,
    (
        SELECT
            id,
            name,
            command_norm,
            error_text,
            output_excerpt,
            ts
        FROM tool_call
        WHERE session = $parent.session
          AND has_error = true
          AND ts <= $parent.ts
        ORDER BY ts DESC
        LIMIT 5
    ) AS recent_tool_failures
FROM classifier_result
WHERE classifier_key = "correction-event" OR label = "correction"
ORDER BY ts DESC
LIMIT ${safeLimit};`.trim();
}

export function classifierOutcomesSql(limit: number): string {
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
    turn,
    turn.seq AS user_seq,
    turn.text_excerpt AS user_text,
    session,
    session.project AS project,
    session.cwd AS cwd,
    ts,
    (
        SELECT
            id,
            name,
            command_norm,
            has_error,
            status,
            exit_code,
            output_excerpt,
            error_text,
            ts
        FROM tool_call
        WHERE session = $parent.session
          AND ts > $parent.ts
        ORDER BY ts ASC
        LIMIT 5
    ) AS later_tool_calls,
    (
        SELECT
            id,
            kind,
            status,
            command_norm,
            command_tool,
            text,
            tool_call,
            ts
        FROM command_outcome
        WHERE session = $parent.session
          AND ts > $parent.ts
        ORDER BY ts ASC
        LIMIT 5
    ) AS later_command_outcomes,
    (
        SELECT
            id,
            seq,
            role,
            text_excerpt AS text,
            ts
        FROM turn
        WHERE session = $parent.session
          AND role = "user"
          AND seq > $parent.turn.seq
        ORDER BY seq ASC
        LIMIT 3
    ) AS later_user_turns
FROM classifier_result
WHERE turn IS NOT NONE
ORDER BY ts DESC
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
    count() AS results,
    array::len(array::distinct(session)) AS sessions,
    math::mean(confidence) AS avg_confidence,
    time::max(ts) AS last_seen
FROM classifier_result
GROUP BY classifier_key, label, target, durability
ORDER BY results DESC, sessions DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function harnessCandidatesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    ["classifier_harness_candidate", classifier_key, label, target, durability] AS candidate_id,
    [classifier_key, label, target, durability] AS dedupe_signature,
    classifier_key,
    label,
    target,
    durability,
    facts,
    sessions,
    avg_confidence,
    last_seen,
    IF target IN ["test_required", "output_required", "regression_guard", "verification"] OR label = "verification_request" THEN "verification"
    ELSE IF target IN ["tooling_preference", "dev_environment", "environment_setup"] THEN "environment"
    ELSE IF target IN ["wrong_artifact", "wrong_output", "missing_context", "misclassified_intent", "prototype_completeness"] OR label = "correction" THEN "representation"
    ELSE IF durability IN ["repo_preference", "global_preference"] OR label = "direction" THEN "guidance"
    ELSE "triage" END AS proposed_layer,
    IF target IN ["test_required", "output_required", "regression_guard", "verification"] OR label = "verification_request" THEN "add_verification_gate"
    ELSE IF target IN ["tooling_preference", "dev_environment", "environment_setup"] THEN "record_environment_preference"
    ELSE IF target IN ["wrong_artifact", "wrong_output", "missing_context", "misclassified_intent", "prototype_completeness"] OR label = "correction" THEN "add_context_guardrail"
    ELSE IF durability IN ["repo_preference", "global_preference"] OR label = "direction" THEN "record_guidance"
    ELSE "review_pattern" END AS proposed_action,
    (
        SELECT
            id,
            classifier_key,
            label,
            target,
            durability,
            confidence,
            turn,
            turn.seq AS user_seq,
            turn.text_excerpt AS user_text,
            session,
            ts,
            (
                SELECT
                    kind,
                    out AS evidence,
                    ts
                FROM cites_evidence
                WHERE in = $parent.id
                ORDER BY ts DESC
                LIMIT 3
            ) AS evidence
        FROM classifier_result
        WHERE classifier_key = $parent.classifier_key
          AND label = $parent.label
          AND target = $parent.target
          AND durability = $parent.durability
        ORDER BY ts DESC
        LIMIT 3
    ) AS examples
FROM (
    SELECT
        classifier_key,
        label,
        target,
        durability,
        count() AS facts,
        array::len(array::distinct(session)) AS sessions,
        math::mean(confidence) AS avg_confidence,
        time::max(ts) AS last_seen
    FROM classifier_result
    WHERE turn IS NOT NONE
      AND (
        durability IN ["candidate_guidance", "repo_preference", "global_preference"]
        OR label IN ["correction", "direction", "verification_request"]
      )
    GROUP BY classifier_key, label, target, durability
)
ORDER BY facts DESC, sessions DESC, avg_confidence DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function tokenImpactSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    workflow_epoch.name AS workflow_epoch,
    source,
    count() AS sessions,
    math::mean(estimated_tokens) AS avg_estimated_tokens,
    math::sum(estimated_tokens) AS total_estimated_tokens,
    math::mean(prompt_tokens ?? estimated_tokens) AS avg_prompt_or_estimated_tokens,
    time::max(ts) AS last_seen
FROM session_token_usage
GROUP BY workflow_epoch, source
ORDER BY last_seen DESC, sessions DESC
LIMIT ${safeLimit};`.trim();
}

export function cacheHealthSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    session,
    source,
    workflow_epoch.name AS workflow_epoch,
    model,
    prompt_tokens,
    completion_tokens,
    cache_read_input_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens / prompt_tokens AS cache_read_ratio,
    cache_creation_input_tokens / prompt_tokens AS cache_creation_ratio,
    estimated_tokens,
    transcript_bytes,
    ts
FROM session_token_usage
WHERE prompt_tokens IS NOT NONE OR cache_read_input_tokens IS NOT NONE OR estimated_tokens > 40000
ORDER BY cache_read_ratio ASC, estimated_tokens DESC, ts DESC
LIMIT ${safeLimit};`.trim();
}

export function workflowImpactSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    workflow_epoch.name AS workflow_epoch,
    source,
    count() AS sessions,
    math::mean(turns) AS avg_turns,
    math::mean(tool_calls) AS avg_tool_calls,
    math::mean(tool_errors) AS avg_tool_errors,
    math::mean(user_corrections) AS avg_user_corrections,
    math::mean(interruptions) AS avg_interruptions,
    math::mean(subagent_dispatches) AS avg_subagent_dispatches,
    math::mean(estimated_tokens) AS avg_estimated_tokens,
    time::max(ts) AS last_seen
FROM session_health
GROUP BY workflow_epoch, source
ORDER BY last_seen DESC, sessions DESC
LIMIT ${safeLimit};`.trim();
}

export function codexHealthSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    session,
    workflow_epoch.name AS workflow_epoch,
    turns,
    tool_calls,
    tool_errors,
    interruptions,
    subagent_dispatches,
    plan_snapshots,
    estimated_tokens,
    context_pressure,
    ts
FROM session_health
WHERE source = "codex" AND estimated_tokens > 0
ORDER BY estimated_tokens DESC, tool_errors DESC, turns DESC, ts DESC
LIMIT ${safeLimit};`.trim();
}

export function closureSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    kind,
    count() AS commits,
    math::sum(IF confidence = "high" THEN 1 ELSE 0 END) AS high_confidence,
    time::max(ts) AS last_seen
FROM commit_classification
GROUP BY kind
ORDER BY commits DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function postFeatureFixesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    in AS feature_commit,
    in.message AS feature_message,
    out AS fix_commit,
    out.message AS fix_message,
    repository,
    overlap_count,
    overlap_files,
    days_between,
    confidence,
    reason,
    ts
FROM later_fixed_by
ORDER BY overlap_count DESC, days_between ASC, ts DESC
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
    IF confidence = "high" THEN 3 ELSE IF confidence = "medium" THEN 2 ELSE 1 END AS confidence_score,
    expected_impact,
    status,
    metrics,
    created_at
FROM skill_candidate
ORDER BY confidence_score DESC, created_at DESC
LIMIT ${safeLimit};`.trim();
}

const sqlString = (value: string): string =>
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function schemaCoverageSql(): string {
    const rows = SCHEMA_TABLES.map(
        (spec) =>
            `{ table: ${sqlString(spec.table)}, stage: ${sqlString(
                spec.stage,
            )}, note: ${sqlString(
                spec.note,
            )}, count: ((SELECT count() AS count FROM ${spec.table} GROUP ALL)[0].count ?? 0) }`,
    ).join(", ");
    return `RETURN [${rows}];`;
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
