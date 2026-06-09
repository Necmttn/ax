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
    HookFireDto,
    SessionAgentDelegation,
    SessionCompaction,
    SessionHealthSummary,
    SessionLink,
    SessionOverview,
    SessionTokenUsageDetail,
    SessionToolCall,
    SessionTopSkill,
    TurnTokenUsageDetail,
} from "@ax/lib/shared/dashboard-types";
import type { ShareEvent, ShareFile, ShareHarnessHook, ShareTurn } from "../share/artifact.ts";

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
WHERE session = $sessionId AND out.name IS NOT NONE
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

/** Context-compaction boundaries recorded for this session, oldest first. */
export const SESSION_COMPACTIONS_SQL = `
SELECT
    harness,
    type::string(ts) AS ts,
    strategy,
    trigger,
    tokens_before,
    kept_count,
    summary
FROM compaction
WHERE session = $sessionId
ORDER BY ts ASC
LIMIT 100;`;

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

/** Per-session health aggregate. One row/session, UNIQUE on session. Powers
 *  the compare view's turns / errors / corrections / interruptions axes. */
export const SESSION_HEALTH_SQL = `
SELECT
    turns,
    tool_calls,
    tool_errors,
    user_corrections,
    interruptions,
    subagent_dispatches,
    task_label
FROM session_health
WHERE session = $sessionId
LIMIT 1;`;

/** Count of commits this session produced (session → commit `produced` edge). */
export const SESSION_PRODUCED_COUNT_SQL = `
SELECT count() AS count
FROM produced
WHERE in = $sessionId
GROUP ALL;`;

/** Per-turn spine for the compare view: every turn in seq order with its
 *  timestamp + error flag. Token/cost is merged in from turn_token_usage by
 *  seq on the caller side (not every turn has a usage row). */
export const SESSION_COMPARE_TURNS_SQL = `
SELECT
    seq,
    ts,
    role,
    has_error
FROM turn
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
WHERE session = $sessionId
    AND message_kind NOT IN ["system", "attachment", "queue-operation", "tool_result"]
ORDER BY seq ASC
LIMIT 2000;`;

/**
 * Per-turn tool calls for a shared session. The call record carries both the
 * invocation (name + command) and its result (output_excerpt), keyed to the
 * turn seq it ran in - so the exporter can synthesize a readable tool line on
 * the otherwise text-less tool-call turns (keeps the shared transcript from
 * jumping over the agent's actual work).
 */
/** Harness hook invocations that DID something (blocked / modified input /
 *  injected context / notified) for a shared session - the guardrail hooks the
 *  user configured. Passthrough (allowed / no_op / unknown) is excluded to keep
 *  the transcript readable. */
export const SESSION_SHARE_HARNESS_HOOKS_SQL = `
SELECT
    ts,
    event_name,
    hook_name,
    effect,
    provider_status,
    command,
    stdout_excerpt,
    content_excerpt,
    blocking_error_excerpt,
    stderr_excerpt
FROM hook_command_invocation
WHERE session = $sessionId
    AND effect IN ["blocked", "modified_input", "injected_context", "notified"]
ORDER BY ts ASC
LIMIT 2000;`;

/** Runtime hook-fire decisions for a shared session (file-context injections
 *  etc.), ordered by time so the viewer can interleave + jump to them. */
export const SESSION_SHARE_HOOK_FIRES_SQL = `
SELECT
    ts,
    event,
    file_path,
    inject,
    reason,
    latency_ms,
    injected_titles
FROM hook_fire
WHERE session = $sessionId
ORDER BY ts ASC
LIMIT 2000;`;

export const SESSION_SHARE_TURN_TOOLCALLS_SQL = `
SELECT
    seq,
    name,
    command_norm,
    command_text,
    input_json,
    output_excerpt,
    has_error
FROM tool_call
WHERE session = $sessionId AND seq IS NOT NONE
ORDER BY seq ASC
LIMIT 4000;`;

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
    // Tool-call / tool-result turns carry no top-level `text` (their detail
    // lives in dissected content blocks attached later). Keep them so the
    // shared transcript shows the agent's actual tool activity instead of
    // jumping straight from one assistant message to the next; fall back to
    // the excerpt, then to an empty string the renderer can handle.
    const rawText = stringField(raw, "text");
    const text_excerpt = stringField(raw, "text_excerpt") ?? undefined;
    if (!id || !role) return null;
    const text = rawText ?? text_excerpt ?? "";

    const seq = numericField(raw, "seq");
    const ts = dateField(raw, "ts") ?? undefined;
    const message_kind = stringField(raw, "message_kind") ?? undefined;
    const intent_kind = stringField(raw, "intent_kind") ?? undefined;
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

export interface ShareTurnToolCall {
    readonly seq: number;
    readonly name: string;
    readonly command: string | null;
    /** JSON-encoded tool input/arguments, as recorded. */
    readonly input_json: string | null;
    readonly output: string | null;
    readonly has_error: boolean;
}

export const sessionShareTurnToolCallsQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    ShareTurnToolCall | null
>({
    name: "session-detail.share_turn_toolcalls",
    sql: (p) => subst(SESSION_SHARE_TURN_TOOLCALLS_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const name = stringField(raw, "name");
        if (name === null) return null;
        return {
            seq: numericField(raw, "seq"),
            name,
            command: stringField(raw, "command_norm") ?? stringField(raw, "command_text"),
            input_json: stringField(raw, "input_json"),
            output: stringField(raw, "output_excerpt"),
            has_error: raw.has_error === true,
        };
    },
});

/** Hook fire without the SPA-only `idx` (assigned by the exporter in ts order). */
export type ShareHookFire = Omit<HookFireDto, "idx">;

/** Harness hook row before the exporter assigns idx + anchor turn. */
export type ShareHarnessHookRow = Omit<ShareHarnessHook, "idx" | "anchor_turn_seq">;

const HARNESS_DETAIL_MAX = 600;

/** Pull `additionalContext` out of a hook's stdout JSON (the text Claude/Codex
 *  actually saw injected), tolerating a missing/malformed payload. */
const extractInjectedContext = (stdout: string | null): string | null => {
    if (!stdout) return null;
    const parsed = decodeJsonOrNull(stdout);
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Record<string, unknown>;
    const hso = rec.hookSpecificOutput;
    if (hso && typeof hso === "object" && typeof (hso as Record<string, unknown>).additionalContext === "string") {
        return (hso as Record<string, unknown>).additionalContext as string;
    }
    return typeof rec.additionalContext === "string" ? rec.additionalContext : null;
};

/** The most informative excerpt of what a hook did: blocking reason, injected
 *  context, or raw output. Clipped so a big file-memory block stays bounded. */
const harnessHookDetail = (raw: Record<string, unknown>): string | null => {
    const detail = stringField(raw, "blocking_error_excerpt")
        ?? stringField(raw, "content_excerpt")
        ?? extractInjectedContext(stringField(raw, "stdout_excerpt"))
        ?? stringField(raw, "stderr_excerpt");
    if (!detail) return null;
    const trimmed = detail.trim();
    return trimmed.length > HARNESS_DETAIL_MAX ? `${trimmed.slice(0, HARNESS_DETAIL_MAX - 1)}…` : trimmed;
};

export const sessionShareHarnessHooksQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    ShareHarnessHookRow | null
>({
    name: "session-detail.share_harness_hooks",
    sql: (p) => subst(SESSION_SHARE_HARNESS_HOOKS_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const ts = dateField(raw, "ts");
        const event_name = stringField(raw, "event_name");
        const hook_name = stringField(raw, "hook_name");
        const effect = stringField(raw, "effect");
        if (!ts || !event_name || !hook_name || !effect) return null;
        const command = stringField(raw, "command");
        const detail = harnessHookDetail(raw);
        return {
            ts,
            event_name,
            hook_name,
            effect,
            status: stringField(raw, "provider_status") ?? "",
            ...(command ? { command } : {}),
            ...(detail ? { detail } : {}),
        };
    },
});

export const sessionShareHookFiresQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    ShareHookFire | null
>({
    name: "session-detail.share_hook_fires",
    sql: (p) => subst(SESSION_SHARE_HOOK_FIRES_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const ts = dateField(raw, "ts");
        const event = stringField(raw, "event");
        if (!ts || !event) return null;
        return {
            ts,
            event,
            file_path: stringField(raw, "file_path") ?? "",
            inject: raw.inject === true,
            reason: stringField(raw, "reason") ?? "",
            latency_ms: numericField(raw, "latency_ms"),
            injected_titles: Array.isArray(raw.injected_titles)
                ? (raw.injected_titles as unknown[]).filter((t): t is string => typeof t === "string")
                : [],
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

export const sessionCompactionsQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    SessionCompaction | null
>({
    name: "session-detail.compactions",
    sql: (p) => subst(SESSION_COMPACTIONS_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const harness = stringField(raw, "harness");
        const ts = dateField(raw, "ts");
        const strategy = stringField(raw, "strategy");
        if (!harness || !ts || !strategy) return null;
        return {
            harness,
            ts,
            strategy,
            trigger: stringField(raw, "trigger"),
            tokens_before: nullableNumberField(raw, "tokens_before"),
            kept_count: nullableNumberField(raw, "kept_count"),
            summary: stringField(raw, "summary"),
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

export const sessionHealthQuery = defineSingleQuery<
    SessionDetailParams,
    Record<string, unknown>,
    SessionHealthSummary | null
>({
    name: "session-detail.health",
    sql: (p) => subst(SESSION_HEALTH_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        return {
            turns: numericField(raw, "turns"),
            tool_calls: numericField(raw, "tool_calls"),
            tool_errors: numericField(raw, "tool_errors"),
            user_corrections: numericField(raw, "user_corrections"),
            interruptions: numericField(raw, "interruptions"),
            subagent_dispatches: numericField(raw, "subagent_dispatches"),
            task_label: stringField(raw, "task_label"),
        };
    },
});

export const sessionProducedCountQuery = defineSingleQuery<
    SessionDetailParams,
    Record<string, unknown>,
    number
>({
    name: "session-detail.produced_count",
    sql: (p) => subst(SESSION_PRODUCED_COUNT_SQL, p.recordRef),
    mapRow: (raw) => (isRecord(raw) ? numericField(raw, "count") : 0),
});

/** Lean per-turn row (seq + ts + error flag). Token/cost merged in by seq. */
export interface CompareTurnRow {
    readonly seq: number;
    readonly ts: string | null;
    readonly role: string | null;
    readonly has_error: boolean;
}

export const sessionCompareTurnsQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    CompareTurnRow | null
>({
    name: "session-detail.compare_turns",
    sql: (p) => subst(SESSION_COMPARE_TURNS_SQL, p.recordRef),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        return {
            seq: numericField(raw, "seq"),
            ts: dateField(raw, "ts"),
            role: stringField(raw, "role"),
            has_error: raw.has_error === true,
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
