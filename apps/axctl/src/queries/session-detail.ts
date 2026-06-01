/**
 * Per-session deep view. Each subquery is bounded by the session id so the
 * cost stays in the session-touching indexes. Used by /api/sessions/:id and
 * the dashboard's session-detail page.
 *
 * Bindings: $sessionId (record reference, e.g. session:⟨…⟩).
 */
import { defineQuery, defineSingleQuery } from "@ax/lib/shared/query";
import {
    isRecord,
    stringField,
    dateField,
    recordIdString,
} from "@ax/lib/shared/row-fields";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import { decodeJsonOrNull } from "@ax/lib/decode";
import type {
    SessionAgentDelegation,
    SessionLink,
    SessionOverview,
    SessionTokenUsageDetail,
    SessionToolCall,
    SessionTopSkill,
    TurnTokenUsageDetail,
} from "@ax/lib/shared/dashboard-types";
import type { ShareEvent, ShareFile, ShareTurn } from "../share/artifact.ts";

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

export const SESSION_TOKEN_USAGE_SQL = `
SELECT
    model,
    prompt_tokens,
    completion_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
    estimated_tokens,
    estimated_input_cost_usd,
    estimated_output_cost_usd,
    estimated_cache_creation_cost_usd,
    estimated_cache_read_cost_usd,
    estimated_cost_usd,
    pricing_source
FROM session_token_usage
WHERE session = $sessionId
LIMIT 1;`;

export const SESSION_TURN_TOKEN_USAGE_SQL = `
SELECT
    seq,
    model,
    prompt_tokens,
    completion_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
    fresh_input_tokens,
    estimated_tokens,
    estimated_input_cost_usd,
    estimated_output_cost_usd,
    estimated_cache_creation_cost_usd,
    estimated_cache_read_cost_usd,
    estimated_cost_usd,
    pricing_source,
    usage_source,
    usage_quality
FROM turn_token_usage
WHERE session = $sessionId
ORDER BY seq ASC
LIMIT 2000;`;

/**
 * Provider-neutral file evidence. Edit evidence is turn-scoped; read/search
 * evidence is tool-call-scoped. All three relation tables point at the shared
 * `file` records, so callers should not branch on Claude/Codex/Pi.
 */
export const SESSION_FILE_EVIDENCE_SQL = `
SELECT
    "edited" AS relation,
    out AS file,
    out.path AS path,
    tool AS tool,
    path_seen,
    absolute_path_seen,
    ts
FROM edited
WHERE in.session = $sessionId
ORDER BY ts DESC
LIMIT 100;

SELECT
    "read_file" AS relation,
    out AS file,
    out.path AS path,
    in.name AS tool,
    path_seen,
    absolute_path_seen,
    evidence,
    excerpt,
    ts
FROM read_file
WHERE in.session = $sessionId
ORDER BY ts DESC
LIMIT 100;

SELECT
    "searched_file" AS relation,
    out AS file,
    out.path AS path,
    in.name AS tool,
    path_seen,
    absolute_path_seen,
    evidence,
    excerpt,
    ts
FROM searched_file
WHERE in.session = $sessionId
ORDER BY ts DESC
LIMIT 100;`;

export const SESSION_SHARE_TIMELINE_SQL = `
SELECT
    id,
    ts,
    "tool_call" AS kind,
    (command_norm ?? name) AS title,
    output_excerpt AS summary
FROM tool_call
WHERE session = $sessionId
ORDER BY ts ASC
LIMIT 200;`;

export const SESSION_SHARE_TURNS_SQL = `
SELECT
    id,
    seq,
    ts,
    role,
    message_kind,
    intent_kind,
    text,
    text_excerpt,
    has_tool_use,
    has_error
FROM turn
WHERE session = $sessionId AND text IS NOT NONE
ORDER BY seq ASC
LIMIT 250;`;

export const SESSION_SHARE_FILES_SQL = `
SELECT
    ts,
    (path_seen ?? out.path) AS path,
    out.lang AS lang,
    "edited" AS role,
    NONE AS additions,
    NONE AS deletions
FROM edited
WHERE in.session = $sessionId
ORDER BY ts ASC
LIMIT 200;`;

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

const nullableNumberField = (row: Record<string, unknown>, key: string): number | null => {
    const raw = row[key];
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
};

const optionalNumericField = (
    row: Record<string, unknown>,
    key: string,
): number | undefined => {
    const value = row[key];
    if (value === null || value === undefined) return undefined;
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
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

export function mapSessionShareTurnRow(
    raw: Record<string, unknown>,
): ShareTurn | null {
    if (!isRecord(raw)) return null;
    const id = recordIdString(raw.id);
    const role = stringField(raw, "role");
    const text = stringField(raw, "text");
    if (!id || !role || !text) return null;

    const seq = numericField(raw, "seq");
    const ts = dateField(raw, "ts") ?? undefined;
    const message_kind = stringField(raw, "message_kind") ?? undefined;
    const intent_kind = stringField(raw, "intent_kind") ?? undefined;
    const text_excerpt = stringField(raw, "text_excerpt") ?? undefined;
    const has_tool_use = typeof raw.has_tool_use === "boolean" ? raw.has_tool_use : undefined;
    const has_error = typeof raw.has_error === "boolean" ? raw.has_error : undefined;

    return {
        id,
        seq,
        role,
        text,
        ...(ts ? { ts } : {}),
        ...(message_kind ? { message_kind } : {}),
        ...(intent_kind ? { intent_kind } : {}),
        ...(text_excerpt ? { text_excerpt } : {}),
        ...(has_tool_use !== undefined ? { has_tool_use } : {}),
        ...(has_error !== undefined ? { has_error } : {}),
    };
}

export function mapSessionShareTimelineRow(
    raw: Record<string, unknown>,
): ShareEvent | null {
    if (!isRecord(raw)) return null;
    const id = recordIdString(raw.id);
    const title = stringField(raw, "title");
    if (!id || !title) return null;
    const ts = dateField(raw, "ts") ?? undefined;
    const summary = stringField(raw, "summary") ?? undefined;
    const event: ShareEvent = {
        id,
        kind: "tool_call",
        actor: "agent",
        title,
    };
    if (ts) return summary ? { ...event, ts, summary } : { ...event, ts };
    return summary ? { ...event, summary } : event;
}

export function mapSessionShareFileRow(
    raw: Record<string, unknown>,
): ShareFile | null {
    if (!isRecord(raw)) return null;
    const path = stringField(raw, "path");
    if (!path) return null;
    const file: ShareFile = {
        path,
        role: "edited",
    };
    const lang = stringField(raw, "lang");
    const additions = optionalNumericField(raw, "additions");
    const deletions = optionalNumericField(raw, "deletions");
    return {
        ...file,
        ...(lang ? { lang } : {}),
        ...(additions !== undefined ? { additions } : {}),
        ...(deletions !== undefined ? { deletions } : {}),
    };
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

export const sessionShareTurnsQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    ShareTurn | null
>({
    name: "session-detail.share_turns",
    sql: (p) => subst(SESSION_SHARE_TURNS_SQL, p.recordRef),
    mapRow: mapSessionShareTurnRow,
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

export const sessionTokenUsageQuery = defineSingleQuery<
    SessionDetailParams,
    Record<string, unknown>,
    SessionTokenUsageDetail | null
>({
    name: "session-detail.token_usage",
    sql: (p) => subst(SESSION_TOKEN_USAGE_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        return {
            model: stringField(raw, "model"),
            prompt_tokens: nullableNumberField(raw, "prompt_tokens"),
            completion_tokens: nullableNumberField(raw, "completion_tokens"),
            cache_creation_input_tokens: nullableNumberField(raw, "cache_creation_input_tokens"),
            cache_read_input_tokens: nullableNumberField(raw, "cache_read_input_tokens"),
            estimated_tokens: numericField(raw, "estimated_tokens"),
            estimated_input_cost_usd: nullableNumberField(raw, "estimated_input_cost_usd"),
            estimated_output_cost_usd: nullableNumberField(raw, "estimated_output_cost_usd"),
            estimated_cache_creation_cost_usd: nullableNumberField(raw, "estimated_cache_creation_cost_usd"),
            estimated_cache_read_cost_usd: nullableNumberField(raw, "estimated_cache_read_cost_usd"),
            estimated_cost_usd: nullableNumberField(raw, "estimated_cost_usd"),
            pricing_source: stringField(raw, "pricing_source"),
        };
    },
});

export const sessionTurnTokenUsageQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    TurnTokenUsageDetail | null
>({
    name: "session-detail.turn_token_usage",
    sql: (p) => subst(SESSION_TURN_TOKEN_USAGE_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        return {
            seq: numericField(raw, "seq"),
            model: stringField(raw, "model"),
            prompt_tokens: nullableNumberField(raw, "prompt_tokens"),
            completion_tokens: nullableNumberField(raw, "completion_tokens"),
            cache_creation_input_tokens: nullableNumberField(raw, "cache_creation_input_tokens"),
            cache_read_input_tokens: nullableNumberField(raw, "cache_read_input_tokens"),
            fresh_input_tokens: nullableNumberField(raw, "fresh_input_tokens"),
            estimated_tokens: numericField(raw, "estimated_tokens"),
            estimated_input_cost_usd: nullableNumberField(raw, "estimated_input_cost_usd"),
            estimated_output_cost_usd: nullableNumberField(raw, "estimated_output_cost_usd"),
            estimated_cache_creation_cost_usd: nullableNumberField(raw, "estimated_cache_creation_cost_usd"),
            estimated_cache_read_cost_usd: nullableNumberField(raw, "estimated_cache_read_cost_usd"),
            estimated_cost_usd: nullableNumberField(raw, "estimated_cost_usd"),
            pricing_source: stringField(raw, "pricing_source"),
            usage_source: stringField(raw, "usage_source") ?? "unknown",
            usage_quality: stringField(raw, "usage_quality") ?? "unknown",
        };
    },
});

export const sessionShareTimelineQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    ShareEvent | null
>({
    name: "session-detail.share_timeline",
    sql: (p) => subst(SESSION_SHARE_TIMELINE_SQL, p.recordRef),
    mapRow: (raw) => mapSessionShareTimelineRow(raw),
});

export const sessionShareFilesQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    ShareFile | null
>({
    name: "session-detail.share_files",
    sql: (p) => subst(SESSION_SHARE_FILES_SQL, p.recordRef),
    mapRow: (raw) => mapSessionShareFileRow(raw),
});
