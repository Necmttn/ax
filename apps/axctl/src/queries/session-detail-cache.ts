/**
 * The per-session deep view, read from the published DuckDB snapshot.
 *
 * This is the DuckDB half of `queries/session-detail.ts`. The Surreal half is
 * still there because `share/exporter.ts` and `dashboard/session-compare.ts`
 * have not been ported (chunks 2c/2d own them); when they land, the Surreal
 * definitions and this file's `-cache` suffix both go away.
 *
 * WHAT CHANGED IN TRANSLATION, and why each one is not cosmetic:
 *
 *  1. THE SESSION ID IS A BOUND PARAMETER. The Surreal version could not bind a
 *     record id (`db.query(sql, { sid: new RecordId(...) })` returned empty
 *     results in this project), so it validated the id against a regex and
 *     SPLICED `session:⟨uuid⟩` into the statement text. DuckDB row ids are plain
 *     VARCHARs, so every id here is a `?` and the whole splice-plus-validate
 *     seam is deleted rather than carried across.
 *  2. DEREFS BECAME JOINS. `out.name` on the `invoked` edge and `out.project` on
 *     `spawned` were per-row record derefs; they are `JOIN skill` / `LEFT JOIN
 *     session` now. The LEFT on `spawned` is load-bearing: a child session row
 *     can be missing (its transcript was never ingested) and an inner join would
 *     drop the dispatch from the parent's children list entirely.
 *  3. EVERY COUNT DECODES AS BIGINT. `count(*)` is a BIGINT and `Schema.Number`
 *     on a BIGINT is a decode FAILURE, which the defensive read policy turns
 *     into an empty result rather than an error - so all of them go through
 *     `NumberFromBigIntColumn`. Same for `kept_count` / `tokens_before` /
 *     the token columns, which the DDL declares BIGINT.
 *  4. `sum(CASE WHEN has_error ...)` became `count(*) FILTER (WHERE has_error)`.
 *     `sum()` over an INTEGER widens to HUGEINT in DuckDB, which is a third
 *     numeric contract to get right for no benefit; a filtered count is a plain
 *     BIGINT.
 *  5. `message_kind NOT IN (...)` gained an explicit `IS NULL` arm. In SQL a
 *     NULL `NOT IN` list is NULL, i.e. excluded - so the direct translation
 *     would silently drop every turn whose `message_kind` was never set, which
 *     is most turns from several harnesses.
 */
import { Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { defineCacheQuery, defineCacheSingleQuery } from "@ax/lib/duckdb/query";
import { decodeJsonOrNull } from "@ax/lib/decode";
import { isRecord, stringField } from "@ax/lib/shared/row-fields";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import type {
    SessionAgentDelegation,
    SessionCompaction,
    SessionHealthSummary,
    SessionLink,
    SessionOverview,
    SessionTokenUsageDetail,
    SessionToolCall,
    SessionTopSkill,
} from "@ax/lib/shared/dashboard-types";
import type { ShareTurn } from "../share/artifact.ts";

/** The one parameter every query here takes: the BARE session id. */
export interface SessionCacheParams {
    readonly sessionId: string;
}

const sid = (p: SessionCacheParams): ReadonlyArray<string> => [toBareSessionId(p.sessionId)];

/** ISO string or null, from a decoded TIMESTAMP column. The dashboard payload
 *  types carry timestamps as ISO strings (they cross an HTTP boundary), so the
 *  conversion happens once, here, rather than at each renderer. */
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const NullableText = Schema.NullOr(Schema.String);
const NullableTimestamp = Schema.NullOr(TimestampColumn);
const NullableCount = Schema.NullOr(NumberFromBigIntColumn);
const NullableDouble = Schema.NullOr(Schema.Number);

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

const OverviewRow = Schema.Struct({
    id: Schema.String,
    project: NullableText,
    cwd: NullableText,
    model: NullableText,
    source: NullableText,
    started_at: NullableTimestamp,
    ended_at: NullableTimestamp,
});

export const sessionOverviewCacheQuery = defineCacheSingleQuery<
    SessionCacheParams,
    typeof OverviewRow,
    SessionOverview
>({
    name: "session-detail.overview",
    row: OverviewRow,
    clause: (p) => ({
        sql: `SELECT id, project, cwd, model, source, started_at, ended_at
              FROM session WHERE id = ? LIMIT 1`,
        params: sid(p),
    }),
    mapRow: (row) => ({
        id: toBareSessionId(row.id),
        project: row.project,
        cwd: row.cwd,
        model: row.model,
        source: row.source ?? "claude",
        started_at: iso(row.started_at),
        ended_at: iso(row.ended_at),
    }),
});

// ---------------------------------------------------------------------------
// top skills
// ---------------------------------------------------------------------------

const TopSkillRow = Schema.Struct({
    skill: Schema.String,
    count: NumberFromBigIntColumn,
    last_used: NullableTimestamp,
});

export const sessionTopSkillsCacheQuery = defineCacheQuery<
    SessionCacheParams,
    typeof TopSkillRow,
    SessionTopSkill
>({
    name: "session-detail.top_skills",
    row: TopSkillRow,
    clause: (p) => ({
        sql: `SELECT sk.name AS skill, count(*) AS count, max(i.ts) AS last_used
              FROM invoked i JOIN skill sk ON sk.id = i.out_id
              WHERE i.session = ? AND sk.name IS NOT NULL
              GROUP BY sk.name
              ORDER BY count DESC
              LIMIT 20`,
        params: sid(p),
    }),
    mapRow: (row) => ({
        skill: row.skill,
        count: row.count,
        last_used: iso(row.last_used),
    }),
});

// ---------------------------------------------------------------------------
// tool calls
// ---------------------------------------------------------------------------

const ToolCallRow = Schema.Struct({
    label: Schema.String,
    count: NumberFromBigIntColumn,
    failures: NumberFromBigIntColumn,
    last_used: NullableTimestamp,
});

export const sessionToolCallsCacheQuery = defineCacheQuery<
    SessionCacheParams,
    typeof ToolCallRow,
    SessionToolCall
>({
    name: "session-detail.tool_calls",
    row: ToolCallRow,
    clause: (p) => ({
        sql: `SELECT coalesce(command_norm, name) AS label,
                     count(*) AS count,
                     count(*) FILTER (WHERE has_error) AS failures,
                     max(ts) AS last_used
              FROM tool_call
              WHERE session = ? AND coalesce(command_norm, name) IS NOT NULL
              GROUP BY label
              ORDER BY count DESC
              LIMIT 25`,
        params: sid(p),
    }),
    mapRow: (row) => ({
        label: row.label,
        count: row.count,
        failures: row.failures,
        last_used: iso(row.last_used),
    }),
});

// ---------------------------------------------------------------------------
// children / parent (the `spawned` edge, both directions)
// ---------------------------------------------------------------------------

const LinkRow = Schema.Struct({
    session_id: Schema.String,
    project: NullableText,
    started_at: NullableTimestamp,
    nickname: NullableText,
    tool: NullableText,
    ts: NullableTimestamp,
});

const toLink = (row: typeof LinkRow.Type): SessionLink => ({
    session_id: toBareSessionId(row.session_id),
    project: row.project,
    started_at: iso(row.started_at),
    nickname: row.nickname,
    tool: row.tool,
    ts: iso(row.ts),
});

export const sessionChildrenCacheQuery = defineCacheQuery<
    SessionCacheParams,
    typeof LinkRow,
    SessionLink
>({
    name: "session-detail.children",
    row: LinkRow,
    clause: (p) => ({
        sql: `SELECT sp.out_id AS session_id, s.project AS project,
                     s.started_at AS started_at, sp.nickname, sp.tool, sp.ts
              FROM spawned sp LEFT JOIN session s ON s.id = sp.out_id
              WHERE sp.in_id = ?
              ORDER BY sp.ts ASC
              LIMIT 100`,
        params: sid(p),
    }),
    mapRow: toLink,
});

export const sessionParentCacheQuery = defineCacheSingleQuery<
    SessionCacheParams,
    typeof LinkRow,
    SessionLink
>({
    name: "session-detail.parent",
    row: LinkRow,
    clause: (p) => ({
        sql: `SELECT sp.in_id AS session_id, s.project AS project,
                     s.started_at AS started_at, sp.nickname, sp.tool, sp.ts
              FROM spawned sp LEFT JOIN session s ON s.id = sp.in_id
              WHERE sp.out_id = ?
              LIMIT 1`,
        params: sid(p),
    }),
    mapRow: toLink,
});

// ---------------------------------------------------------------------------
// agent delegations (inline Agent tool calls - no child session row exists)
// ---------------------------------------------------------------------------

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Kept identical to the Surreal mapper's classifier so a ported view and an
 *  unported one cannot disagree about a delegation's phase. */
export function classifyAgentDescription(
    desc: string | null,
): SessionAgentDelegation["phase"] {
    if (!desc) return "other";
    const lower = desc.toLowerCase();
    if (/(plan|brainstorm|research|design|spec|architecture)/.test(lower)) return "plan";
    if (/(review|audit|verify|check|qa|simplify|diagnose)/.test(lower)) return "review";
    if (/(merge|ship|release|deploy)/.test(lower)) return "merge";
    if (/(implement|build|fix|edit|write|migrate|refactor|integrate|wire|add|execute)/.test(lower)) {
        return "execute";
    }
    return "other";
}

const DelegationRow = Schema.Struct({
    id: Schema.String,
    ts: TimestampColumn,
    input_json: NullableText,
    output_excerpt: NullableText,
});

export const sessionAgentDelegationsCacheQuery = defineCacheQuery<
    SessionCacheParams,
    typeof DelegationRow,
    SessionAgentDelegation
>({
    name: "session-detail.agent_delegations",
    row: DelegationRow,
    clause: (p) => ({
        sql: `SELECT id, ts, input_json, output_excerpt
              FROM tool_call
              WHERE session = ? AND name = 'Agent'
              ORDER BY ts ASC
              LIMIT 50`,
        params: sid(p),
    }),
    mapRow: (row) => {
        let subagent_type: string | null = null;
        let description: string | null = null;
        let prompt: string | null = null;
        if (row.input_json) {
            const parsed = decodeJsonOrNull(row.input_json);
            if (isRecord(parsed)) {
                subagent_type = stringField(parsed, "subagent_type");
                description = stringField(parsed, "description");
                const p = stringField(parsed, "prompt");
                if (p) prompt = truncate(p, 280);
            }
        }
        return {
            id: row.id,
            ts: row.ts.toISOString(),
            subagent_type,
            description,
            prompt_excerpt: prompt,
            output_excerpt: row.output_excerpt ? truncate(row.output_excerpt, 280) : null,
            phase: classifyAgentDescription(description ?? subagent_type),
        };
    },
});

// ---------------------------------------------------------------------------
// token usage
// ---------------------------------------------------------------------------

const TokenUsageRow = Schema.Struct({
    model: NullableText,
    prompt_tokens: NullableCount,
    completion_tokens: NullableCount,
    cache_creation_input_tokens: NullableCount,
    cache_read_input_tokens: NullableCount,
    estimated_tokens: NullableCount,
    estimated_input_cost_usd: NullableDouble,
    estimated_output_cost_usd: NullableDouble,
    estimated_cache_creation_cost_usd: NullableDouble,
    estimated_cache_read_cost_usd: NullableDouble,
    estimated_cost_usd: NullableDouble,
    pricing_source: NullableText,
});

export const sessionTokenUsageCacheQuery = defineCacheSingleQuery<
    SessionCacheParams,
    typeof TokenUsageRow,
    SessionTokenUsageDetail
>({
    name: "session-detail.token_usage",
    row: TokenUsageRow,
    clause: (p) => ({
        sql: `SELECT model, prompt_tokens, completion_tokens,
                     cache_creation_input_tokens, cache_read_input_tokens,
                     estimated_tokens, estimated_input_cost_usd,
                     estimated_output_cost_usd, estimated_cache_creation_cost_usd,
                     estimated_cache_read_cost_usd, estimated_cost_usd, pricing_source
              FROM session_token_usage WHERE session = ? LIMIT 1`,
        params: sid(p),
    }),
    mapRow: (row) => ({
        model: row.model,
        prompt_tokens: row.prompt_tokens,
        completion_tokens: row.completion_tokens,
        cache_creation_input_tokens: row.cache_creation_input_tokens,
        cache_read_input_tokens: row.cache_read_input_tokens,
        estimated_tokens: row.estimated_tokens ?? 0,
        estimated_input_cost_usd: row.estimated_input_cost_usd,
        estimated_output_cost_usd: row.estimated_output_cost_usd,
        estimated_cache_creation_cost_usd: row.estimated_cache_creation_cost_usd,
        estimated_cache_read_cost_usd: row.estimated_cache_read_cost_usd,
        estimated_cost_usd: row.estimated_cost_usd,
        pricing_source: row.pricing_source,
    }),
});

// ---------------------------------------------------------------------------
// compactions
// ---------------------------------------------------------------------------

const CompactionRow = Schema.Struct({
    harness: Schema.String,
    ts: TimestampColumn,
    strategy: Schema.String,
    source_confidence: NullableText,
    trigger: NullableText,
    tokens_before: NullableCount,
    kept_count: NullableCount,
    summary: NullableText,
});

export const sessionCompactionsCacheQuery = defineCacheQuery<
    SessionCacheParams,
    typeof CompactionRow,
    SessionCompaction
>({
    name: "session-detail.compactions",
    row: CompactionRow,
    clause: (p) => ({
        // `trigger` is a reserved word in DuckDB's parser, hence the quoting.
        sql: `SELECT harness, ts, strategy, source_confidence, "trigger" AS trigger,
                     tokens_before, kept_count, summary
              FROM compaction WHERE session = ?
              ORDER BY ts ASC
              LIMIT 100`,
        params: sid(p),
    }),
    mapRow: (row) => ({
        harness: row.harness,
        ts: row.ts.toISOString(),
        strategy: row.strategy,
        source_confidence: row.source_confidence,
        trigger: row.trigger,
        tokens_before: row.tokens_before,
        kept_count: row.kept_count,
        summary: row.summary,
    }),
});

// ---------------------------------------------------------------------------
// normalized turns (`--turns` / `--turns=full`)
// ---------------------------------------------------------------------------

const ShareTurnRow = Schema.Struct({
    id: Schema.String,
    seq: NumberFromBigIntColumn,
    ts: NullableTimestamp,
    role: Schema.String,
    message_kind: NullableText,
    intent_kind: NullableText,
    text: NullableText,
    text_excerpt: NullableText,
    has_tool_use: Schema.NullOr(Schema.Boolean),
    has_error: Schema.NullOr(Schema.Boolean),
});

/** The excluded kinds, as the Surreal statement listed them. */
const HIDDEN_TURN_KINDS = ["system", "attachment", "queue-operation"] as const;

export const sessionShareTurnsCacheQuery = defineCacheQuery<
    SessionCacheParams,
    typeof ShareTurnRow,
    ShareTurn
>({
    name: "session-detail.share_turns",
    row: ShareTurnRow,
    clause: (p) => ({
        sql: `SELECT id, seq, ts, role, message_kind, intent_kind, text,
                     text_excerpt, has_tool_use, has_error
              FROM turn
              WHERE session = ?
                AND (message_kind IS NULL OR message_kind NOT IN (${HIDDEN_TURN_KINDS.map(() => "?").join(", ")}))
              ORDER BY seq ASC
              LIMIT 2000`,
        params: [...sid(p), ...HIDDEN_TURN_KINDS],
    }),
    mapRow: (row) => {
        // Tool-call / tool-result turns carry no top-level `text`; keep them so
        // the transcript shows the agent's actual work, falling back to the
        // excerpt and then to an empty string the renderer can handle.
        const text_excerpt = row.text_excerpt ?? undefined;
        const text = row.text ?? text_excerpt ?? "";
        const ts = row.ts === null ? undefined : row.ts.toISOString();
        return {
            id: row.id,
            seq: row.seq,
            role: row.role,
            text,
            ...(ts === undefined ? {} : { ts }),
            ...(row.message_kind === null ? {} : { message_kind: row.message_kind }),
            ...(row.intent_kind === null ? {} : { intent_kind: row.intent_kind }),
            ...(text_excerpt === undefined ? {} : { text_excerpt }),
            ...(row.has_tool_use === null ? {} : { has_tool_use: row.has_tool_use }),
            ...(row.has_error === null ? {} : { has_error: row.has_error }),
        };
    },
});

// ---------------------------------------------------------------------------
// session-id prefix resolution (the `ax sessions show <prefix>` fallback)
// ---------------------------------------------------------------------------

const IdRow = Schema.Struct({ id: Schema.String });

export const sessionIdsByPrefixCacheQuery = defineCacheQuery<
    { readonly prefix: string; readonly limit: number },
    typeof IdRow,
    string
>({
    name: "session-detail.ids_by_prefix",
    row: IdRow,
    clause: (p) => ({
        sql: "SELECT id FROM session WHERE starts_with(id, ?) LIMIT ?",
        params: [p.prefix, Math.max(1, Math.trunc(p.limit))],
    }),
    mapRow: (row) => toBareSessionId(row.id),
});

// ---------------------------------------------------------------------------
// compare view (dashboard/session-compare.ts, chunk 2c) - session_health,
// commit-produced count, and the per-turn compare spine.
// ---------------------------------------------------------------------------

const HealthRow = Schema.Struct({
    turns: NumberFromBigIntColumn,
    tool_calls: NumberFromBigIntColumn,
    tool_errors: NumberFromBigIntColumn,
    user_corrections: NumberFromBigIntColumn,
    interruptions: NumberFromBigIntColumn,
    subagent_dispatches: NumberFromBigIntColumn,
    task_label: NullableText,
});

export const sessionHealthCacheQuery = defineCacheSingleQuery<
    SessionCacheParams,
    typeof HealthRow,
    SessionHealthSummary
>({
    name: "session-detail.health",
    row: HealthRow,
    clause: (p) => ({
        sql: `SELECT turns, tool_calls, tool_errors, user_corrections, interruptions,
                     subagent_dispatches, task_label
              FROM session_health WHERE session = ? LIMIT 1`,
        params: sid(p),
    }),
    mapRow: (row) => ({
        turns: row.turns,
        tool_calls: row.tool_calls,
        tool_errors: row.tool_errors,
        user_corrections: row.user_corrections,
        interruptions: row.interruptions,
        subagent_dispatches: row.subagent_dispatches,
        task_label: row.task_label,
    }),
});

const CountRow = Schema.Struct({ count: NumberFromBigIntColumn });

/** Count of commits this session produced (session -> commit `produced` edge). */
export const sessionProducedCountCacheQuery = defineCacheSingleQuery<
    SessionCacheParams,
    typeof CountRow,
    number
>({
    name: "session-detail.produced_count",
    row: CountRow,
    clause: (p) => ({
        sql: "SELECT count(*) AS count FROM produced WHERE in_id = ?",
        params: sid(p),
    }),
    mapRow: (row) => row.count,
});

/** Lean per-turn row (seq + ts + error flag) for the compare spine. Token/cost
 *  is merged in by seq on the caller side (not every turn has a usage row). */
export interface CompareTurnRow {
    readonly seq: number;
    readonly ts: string | null;
    readonly role: string | null;
    readonly has_error: boolean;
}

const CompareTurnDbRow = Schema.Struct({
    seq: NumberFromBigIntColumn,
    ts: NullableTimestamp,
    role: NullableText,
    has_error: Schema.Boolean,
});

export const sessionCompareTurnsCacheQuery = defineCacheQuery<
    SessionCacheParams,
    typeof CompareTurnDbRow,
    CompareTurnRow
>({
    name: "session-detail.compare_turns",
    row: CompareTurnDbRow,
    clause: (p) => ({
        sql: `SELECT seq, ts, role, has_error
              FROM turn WHERE session = ?
              ORDER BY seq ASC
              LIMIT 2000`,
        params: sid(p),
    }),
    mapRow: (row) => ({
        seq: row.seq,
        ts: iso(row.ts),
        role: row.role,
        has_error: row.has_error,
    }),
});

/** Every `turn_token_usage` row for a session, keyed by seq on the caller side
 *  (mirrors `sessionTurnTokenUsageQuery`'s Surreal shape, minus the record-id
 *  form). Used by the compare view's per-turn timeline. */
const CompareTurnTokenUsageRow = Schema.Struct({
    seq: NumberFromBigIntColumn,
    model: NullableText,
    prompt_tokens: NullableCount,
    completion_tokens: NullableCount,
    cache_creation_input_tokens: NullableCount,
    cache_read_input_tokens: NullableCount,
    fresh_input_tokens: NullableCount,
    estimated_tokens: NullableCount,
    estimated_input_cost_usd: NullableDouble,
    estimated_output_cost_usd: NullableDouble,
    estimated_cache_creation_cost_usd: NullableDouble,
    estimated_cache_read_cost_usd: NullableDouble,
    estimated_cost_usd: NullableDouble,
    pricing_source: NullableText,
    usage_source: NullableText,
    usage_quality: NullableText,
});

export interface CompareTurnTokenUsage {
    readonly seq: number;
    readonly estimated_tokens: number | null;
    readonly estimated_cost_usd: number | null;
}

export const sessionCompareTurnTokenUsageCacheQuery = defineCacheQuery<
    SessionCacheParams,
    typeof CompareTurnTokenUsageRow,
    CompareTurnTokenUsage
>({
    name: "session-detail.compare_turn_token_usage",
    row: CompareTurnTokenUsageRow,
    clause: (p) => ({
        sql: `SELECT seq, model, prompt_tokens, completion_tokens,
                     cache_creation_input_tokens, cache_read_input_tokens,
                     fresh_input_tokens, estimated_tokens, estimated_input_cost_usd,
                     estimated_output_cost_usd, estimated_cache_creation_cost_usd,
                     estimated_cache_read_cost_usd, estimated_cost_usd, pricing_source,
                     usage_source, usage_quality
              FROM turn_token_usage WHERE session = ?
              ORDER BY seq ASC`,
        params: sid(p),
    }),
    mapRow: (row) => ({
        seq: row.seq,
        estimated_tokens: row.estimated_tokens,
        estimated_cost_usd: row.estimated_cost_usd,
    }),
});
