export const INSIGHT_VIEWS = [
    "schema",
    "repositories",
    "checkouts",
    "git",
    "friction",
    "tools",
    "sessions",
    "feedback-loops",
    "verification-gaps",
    "user-language",
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
    { table: "session", stage: "active", note: "Claude and Codex transcript sessions." },
    { table: "turn", stage: "active", note: "Transcript turns and tool result turns." },
    { table: "file", stage: "active", note: "Canonical repository-relative files plus legacy file rows." },
    { table: "commit", stage: "active", note: "Git commits imported from tracked repositories." },
    { table: "repository", stage: "active", note: "Stable repository identities, preferring normalized remotes." },
    { table: "checkout", stage: "active", note: "Local checkout/worktree paths for repositories." },
    { table: "tool", stage: "active", note: "Normalized CLI, MCP, and agent tool identities." },
    { table: "tool_call", stage: "active", note: "Claude and Codex tool calls with errors and command fields." },
    { table: "plan", stage: "active", note: "Current plan state per session/source." },
    { table: "plan_item", stage: "active", note: "Latest stable plan items for each plan." },
    { table: "plan_snapshot", stage: "active", note: "Point-in-time TodoWrite/update_plan snapshots." },
    { table: "insight", stage: "active", note: "Imported Claude usage-data insight facets." },
    { table: "friction_event", stage: "active", note: "Tool failures, imported insight friction, and derived friction." },
    { table: "diagnostic_event", stage: "active", note: "Derived diagnostics from failed commands and friction." },
    { table: "recommendation", stage: "conditional", note: "Only written when repeated friction crosses a threshold." },
    { table: "invoked", stage: "active", note: "Turn-to-skill invocation edges." },
    { table: "proposed", stage: "active", note: "Skills mentioned but not invoked." },
    { table: "edited", stage: "active", note: "Turn-to-file edit edges." },
    { table: "corrected_by", stage: "active", note: "Assistant turns followed by user correction signals." },
    { table: "produced", stage: "active", note: "Session-to-commit edges." },
    { table: "touched", stage: "active", note: "Commit-to-file edges with additions/deletions/status." },
    { table: "has_checkout", stage: "active", note: "Repository-to-checkout edges." },
    { table: "concerns", stage: "active", note: "Generic evidence edges, currently used for tool/skill and insight/session links." },
    { table: "skill_paired", stage: "active", note: "Derived skill co-occurrence edges." },
    { table: "recovered_by", stage: "active", note: "Derived recovery edges after an error turn." },
    { table: "workspace", stage: "staged", note: "Reserved for cross-checkout workspace grouping." },
    { table: "changeset", stage: "staged", note: "Reserved for activity-first semantic memory." },
    { table: "file_memory", stage: "staged", note: "Reserved for per-file tribal knowledge and BM25 search." },
    { table: "artifact", stage: "staged", note: "Reserved for generated reports, patches, and external artifacts." },
    { table: "feedback_event", stage: "staged", note: "Reserved for explicit user feedback separate from friction." },
    { table: "guidance", stage: "staged", note: "Persisted behavior controls such as rules, skills, hooks, and commands." },
    { table: "guidance_version", stage: "staged", note: "Legacy guidance history table kept until migration to guidance_revision." },
    { table: "guidance_source", stage: "staged", note: "Observed repo-local and global storage authorities for Guidance." },
    { table: "guidance_revision", stage: "staged", note: "Content-hashed observed Guidance revisions with evidence strength." },
    { table: "stack", stage: "staged", note: "Lean technology/platform records for applicability matching." },
    { table: "agent_tooling", stage: "staged", note: "Tools exposed to agents by harness layer." },
    { table: "harness_learning", stage: "staged", note: "Local/share-candidate/shared evidence-backed Harness Learnings." },
    { table: "intervention", stage: "staged", note: "Approval-gated behavior-change experiments." },
    { table: "intervention_observation", stage: "staged", note: "Measured before/after effects of Interventions." },
    { table: "command_outcome", stage: "staged", note: "Semantic command result classifications." },
    { table: "user_message_ngram", stage: "staged", note: "Derived user-language n-grams for preference and correction mining." },
    { table: "includes", stage: "staged", note: "Reserved changeset-to-file-memory relation." },
    { table: "involves", stage: "staged", note: "Reserved changeset-to-file relation." },
    { table: "resulted_in", stage: "staged", note: "Reserved generic outcome relation." },
    { table: "supersedes", stage: "staged", note: "Reserved memory/guidance replacement relation." },
    { table: "produced_artifact", stage: "staged", note: "Reserved producer-to-artifact relation." },
    { table: "has_artifact", stage: "staged", note: "Reserved owner-to-artifact relation." },
    { table: "derived_from", stage: "staged", note: "Reserved provenance relation for derived records." },
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
        case "feedback-loops":
            return feedbackLoopsSql(limit);
        case "verification-gaps":
            return verificationGapsSql(limit);
        case "user-language":
            return userLanguageSql(limit);
        case "graph-health":
            return graphHealthSql(limit);
    }
}
