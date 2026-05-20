/**
 * Per-session deep view. Each subquery is bounded by the session id so the
 * cost stays in the session-touching indexes. Used by /api/sessions/:id and
 * the dashboard's session-detail page.
 *
 * Bindings: $sessionId (record reference, e.g. session:⟨…⟩).
 */
import { defineQuery, defineSingleQuery } from "./query.ts";
import {
    isRecord,
    stringField,
    dateField,
    recordIdString,
} from "../lib/shared/row-fields.ts";
import { toBareSessionId } from "../lib/shared/session-id.ts";
import { decodeJsonOrNull } from "../lib/decode.ts";
import type {
    SessionAgentDelegation,
    SessionLink,
    SessionOverview,
    SessionToolCall,
    SessionTopSkill,
} from "../lib/shared/dashboard-types.ts";

export const SESSION_OVERVIEW_SQL = `
SELECT
    id,
    project,
    cwd,
    model,
    source,
    started_at,
    ended_at
FROM $sessionId;`;

export const SESSION_TOP_SKILLS_SQL = `
SELECT
    out.name AS skill,
    count() AS count,
    time::max(ts) AS last_used
FROM invoked
WHERE in.session = $sessionId AND out.name IS NOT NONE
GROUP BY skill
ORDER BY count DESC
LIMIT 20;`;

export const SESSION_TOOL_CALLS_SQL = `
SELECT
    (command_norm ?? name) AS label,
    count() AS count,
    math::sum(IF has_error = true THEN 1 ELSE 0 END) AS failures,
    time::max(ts) AS last_used
FROM tool_call
WHERE session = $sessionId AND (command_norm ?? name) IS NOT NONE
GROUP BY label
ORDER BY count DESC
LIMIT 25;`;

export const SESSION_CHILDREN_SQL = `
SELECT
    out AS child,
    out.project AS project,
    out.started_at AS started_at,
    nickname,
    tool,
    ts
FROM spawned
WHERE in = $sessionId
ORDER BY ts ASC
LIMIT 100;`;

export const SESSION_PARENT_SQL = `
SELECT
    in AS parent,
    in.project AS project,
    in.started_at AS started_at,
    nickname,
    tool,
    ts
FROM spawned
WHERE out = $sessionId
LIMIT 1;`;

/**
 * Claude `Agent` tool calls. Each is one inline subagent dispatch - there's
 * no separate session record but the prompt + result still tell us *what*
 * was delegated.
 */
export const SESSION_AGENT_DELEGATIONS_SQL = `
SELECT
    id,
    ts,
    input_json,
    output_excerpt
FROM tool_call
WHERE session = $sessionId AND name = "Agent"
ORDER BY ts ASC
LIMIT 50;`;

// ---------------------------------------------------------------------------
// Typed Query seam
// ---------------------------------------------------------------------------

/** Params carry a pre-validated, pre-built record-id literal (e.g.
 *  `session:⟨uuid⟩`). The caller must validate + construct before passing. */
export interface SessionDetailParams {
    readonly recordRef: string;
}

const subst = (sql: string, ref: string): string =>
    sql.replace(/\$sessionId/g, ref);

const truncate = (s: string, n: number): string =>
    s.length <= n ? s : `${s.slice(0, n - 1)}…`;

const numericField = (row: Record<string, unknown>, key: string): number => {
    const v = Number(row[key] ?? 0);
    return Number.isFinite(v) ? v : 0;
};

function classifyAgentDescription(
    desc: string | null,
): SessionAgentDelegation["phase"] {
    if (!desc) return "other";
    const lower = desc.toLowerCase();
    if (/(plan|brainstorm|research|design|spec|architecture)/.test(lower)) return "plan";
    if (/(review|audit|verify|check|qa|simplify|diagnose)/.test(lower)) return "review";
    if (/(merge|ship|release|deploy)/.test(lower)) return "merge";
    if (/(implement|build|fix|edit|write|migrate|refactor|integrate|wire|add|execute)/.test(lower)) return "execute";
    return "other";
}

export const sessionOverviewQuery = defineSingleQuery<
    SessionDetailParams,
    Record<string, unknown>,
    SessionOverview | null
>({
    name: "session-detail.overview",
    sql: (p) => subst(SESSION_OVERVIEW_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const id = recordIdString(raw.id);
        if (!id) return null;
        return {
            id: toBareSessionId(id),
            project: stringField(raw, "project"),
            cwd: stringField(raw, "cwd"),
            model: stringField(raw, "model"),
            source: stringField(raw, "source") ?? "claude",
            started_at: dateField(raw, "started_at"),
            ended_at: dateField(raw, "ended_at"),
        };
    },
});

export const sessionTopSkillsQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    SessionTopSkill | null
>({
    name: "session-detail.top_skills",
    sql: (p) => subst(SESSION_TOP_SKILLS_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const skill = stringField(raw, "skill");
        if (!skill) return null;
        return {
            skill,
            count: numericField(raw, "count"),
            last_used: dateField(raw, "last_used"),
        };
    },
});

export const sessionToolCallsQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    SessionToolCall | null
>({
    name: "session-detail.tool_calls",
    sql: (p) => subst(SESSION_TOOL_CALLS_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const label = stringField(raw, "label");
        if (!label) return null;
        return {
            label,
            count: numericField(raw, "count"),
            failures: numericField(raw, "failures"),
            last_used: dateField(raw, "last_used"),
        };
    },
});

export const sessionChildrenQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    SessionLink | null
>({
    name: "session-detail.children",
    sql: (p) => subst(SESSION_CHILDREN_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const sid = recordIdString(raw["child"]);
        if (!sid) return null;
        return {
            session_id: toBareSessionId(sid),
            project: stringField(raw, "project"),
            started_at: dateField(raw, "started_at"),
            nickname: stringField(raw, "nickname"),
            tool: stringField(raw, "tool"),
            ts: dateField(raw, "ts"),
        };
    },
});

export const sessionParentQuery = defineSingleQuery<
    SessionDetailParams,
    Record<string, unknown>,
    SessionLink | null
>({
    name: "session-detail.parent",
    sql: (p) => subst(SESSION_PARENT_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const sid = recordIdString(raw["parent"]);
        if (!sid) return null;
        return {
            session_id: toBareSessionId(sid),
            project: stringField(raw, "project"),
            started_at: dateField(raw, "started_at"),
            nickname: stringField(raw, "nickname"),
            tool: stringField(raw, "tool"),
            ts: dateField(raw, "ts"),
        };
    },
});

export const sessionAgentDelegationsQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    SessionAgentDelegation | null
>({
    name: "session-detail.agent_delegations",
    sql: (p) => subst(SESSION_AGENT_DELEGATIONS_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const id = recordIdString(raw.id);
        const ts = dateField(raw, "ts");
        if (!id || !ts) return null;
        const rawInput = stringField(raw, "input_json");
        let subagent_type: string | null = null;
        let description: string | null = null;
        let prompt: string | null = null;
        if (rawInput) {
            const parsed = decodeJsonOrNull(rawInput);
            if (isRecord(parsed)) {
                subagent_type = stringField(parsed, "subagent_type");
                description = stringField(parsed, "description");
                const p = stringField(parsed, "prompt");
                if (p) prompt = truncate(p, 280);
            }
        }
        const outputRaw = stringField(raw, "output_excerpt");
        return {
            id,
            ts,
            subagent_type,
            description,
            prompt_excerpt: prompt,
            output_excerpt: outputRaw ? truncate(outputRaw, 280) : null,
            phase: classifyAgentDescription(description ?? subagent_type),
        };
    },
});
