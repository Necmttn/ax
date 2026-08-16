/**
 * DuckDB replacement for the eleven SurrealQL fan-out queries `share/exporter.ts`
 * used to read from `apps/axctl/src/queries/session-detail.ts` +
 * `apps/axctl/src/queries/session-turn-content.ts`.
 *
 * WHY THIS IS ITS OWN FILE RATHER THAN A PORT OF THOSE TWO. `queries/` belongs
 * to a sibling wave-3 chunk (band 2, chunk 2b) - see the partition doc's file
 * ownership table. This module does not import from either file; it re-derives
 * the same row shapes directly against the DuckDB cache through {@link
 * CacheRead}, so `ax share` stops depending on SurrealDB without editing a file
 * this chunk does not own. The dashboard's own session-detail route keeps
 * reading `queries/session-detail.ts` until 2b ports it - that is a separate,
 * still-Surreal-backed read path, not a regression introduced here.
 *
 * SCOPE. Deliberately narrower than `session-detail.ts` + `session-turn-content.ts`
 * combined: only the rows `exportSessionShare` actually reads. The content
 * resolution below also skips the SurrealDB-specific "speculative direct record
 * fetch" optimisation those files needed to dodge Surreal's slow `document IN
 * [...]` membership scans (see session-turn-content.ts's module doc) - DuckDB
 * has a real `content_block(document, seq)` / `content_atom(document, kind)`
 * index, so a plain `document IN (...)` bulk fetch is already fast here.
 */
import { Effect, Schema } from "effect";
import type { CacheReadService } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn, TimestampColumn, TextColumn, JsonArrayColumn } from "@ax/lib/duckdb/columns";
import { decodeJsonOrNull } from "@ax/lib/decode";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import type {
    HookFireDto,
    InspectContentAtomDto,
    InspectContentBlockDto,
    InspectTurnContentDto,
    SessionLink,
    SessionOverview,
    SessionTokenUsageDetail,
    SessionToolCall,
    SessionTopSkill,
    TurnTokenUsageDetail,
} from "@ax/lib/shared/dashboard-types";
import type { ShareEvent, ShareFile, ShareHarnessHook, ShareTurn } from "./artifact.ts";

const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

// ---------------------------------------------------------------------------
// session overview
// ---------------------------------------------------------------------------

const OverviewRow = Schema.Struct({
    id: TextColumn,
    project: Schema.NullOr(TextColumn),
    cwd: Schema.NullOr(TextColumn),
    model: Schema.NullOr(TextColumn),
    source: TextColumn,
    started_at: Schema.NullOr(TimestampColumn),
    ended_at: Schema.NullOr(TimestampColumn),
});

const OVERVIEW_SQL = `
SELECT id, project, cwd, model, source, started_at, ended_at
FROM session
WHERE id = ?
LIMIT 1`;

export const fetchSessionOverview = Effect.fn("share.fetchSessionOverview")(
    function* (read: CacheReadService, sessionId: string) {
        const row = yield* read.first(OverviewRow, OVERVIEW_SQL, [sessionId]);
        if (row._tag === "None") return null;
        const r = row.value;
        const overview: SessionOverview = {
            id: toBareSessionId(r.id),
            project: r.project,
            cwd: r.cwd,
            model: r.model,
            source: r.source,
            started_at: isoOrNull(r.started_at),
            ended_at: isoOrNull(r.ended_at),
        };
        return overview;
    },
);

// ---------------------------------------------------------------------------
// top skills
// ---------------------------------------------------------------------------

const TopSkillRow = Schema.Struct({
    skill: TextColumn,
    count: NumberFromBigIntColumn,
    last_used: Schema.NullOr(TimestampColumn),
});

const TOP_SKILLS_SQL = `
SELECT s.name AS skill, COUNT(*) AS count, MAX(i.ts) AS last_used
FROM invoked i
JOIN skill s ON s.id = i.out_id
WHERE i.session = ?
GROUP BY s.name
ORDER BY count DESC
LIMIT 20`;

export const fetchSessionTopSkills = Effect.fn("share.fetchSessionTopSkills")(
    function* (read: CacheReadService, sessionId: string) {
        const rows = yield* read.rows(TopSkillRow, TOP_SKILLS_SQL, [sessionId]);
        return rows.map(
            (r): SessionTopSkill => ({ skill: r.skill, count: r.count, last_used: isoOrNull(r.last_used) }),
        );
    },
);

// ---------------------------------------------------------------------------
// tool calls (rollup by label)
// ---------------------------------------------------------------------------

const ToolCallRollupRow = Schema.Struct({
    label: TextColumn,
    count: NumberFromBigIntColumn,
    failures: NumberFromBigIntColumn,
    last_used: Schema.NullOr(TimestampColumn),
});

const TOOL_CALLS_SQL = `
SELECT
    COALESCE(command_norm, name) AS label,
    COUNT(*) AS count,
    SUM(CASE WHEN has_error THEN 1 ELSE 0 END) AS failures,
    MAX(ts) AS last_used
FROM tool_call
WHERE session = ? AND COALESCE(command_norm, name) IS NOT NULL
GROUP BY label
ORDER BY count DESC
LIMIT 25`;

export const fetchSessionToolCalls = Effect.fn("share.fetchSessionToolCalls")(
    function* (read: CacheReadService, sessionId: string) {
        const rows = yield* read.rows(ToolCallRollupRow, TOOL_CALLS_SQL, [sessionId]);
        return rows.map(
            (r): SessionToolCall => ({
                label: r.label,
                count: r.count,
                failures: r.failures,
                last_used: isoOrNull(r.last_used),
            }),
        );
    },
);

// ---------------------------------------------------------------------------
// children (spawned subagents)
// ---------------------------------------------------------------------------

const ChildRow = Schema.Struct({
    child: TextColumn,
    project: Schema.NullOr(TextColumn),
    started_at: Schema.NullOr(TimestampColumn),
    nickname: Schema.NullOr(TextColumn),
    tool: Schema.NullOr(TextColumn),
    ts: TimestampColumn,
});

const CHILDREN_SQL = `
SELECT sp.out_id AS child, s.project AS project, s.started_at AS started_at,
    sp.nickname AS nickname, sp.tool AS tool, sp.ts AS ts
FROM spawned sp
LEFT JOIN session s ON s.id = sp.out_id
WHERE sp.in_id = ?
ORDER BY sp.ts ASC
LIMIT 100`;

export const fetchSessionChildren = Effect.fn("share.fetchSessionChildren")(
    function* (read: CacheReadService, sessionId: string) {
        const rows = yield* read.rows(ChildRow, CHILDREN_SQL, [sessionId]);
        return rows.map(
            (r): SessionLink => ({
                session_id: toBareSessionId(r.child),
                project: r.project,
                started_at: isoOrNull(r.started_at),
                nickname: r.nickname,
                tool: r.tool,
                ts: isoOrNull(r.ts),
            }),
        );
    },
);

// ---------------------------------------------------------------------------
// token usage (session-level + per-turn)
// ---------------------------------------------------------------------------

const SessionTokenUsageRow = Schema.Struct({
    model: Schema.NullOr(TextColumn),
    prompt_tokens: Schema.NullOr(NumberFromBigIntColumn),
    completion_tokens: Schema.NullOr(NumberFromBigIntColumn),
    cache_creation_input_tokens: Schema.NullOr(NumberFromBigIntColumn),
    cache_read_input_tokens: Schema.NullOr(NumberFromBigIntColumn),
    estimated_tokens: NumberFromBigIntColumn,
    estimated_input_cost_usd: Schema.NullOr(Schema.Number),
    estimated_output_cost_usd: Schema.NullOr(Schema.Number),
    estimated_cache_creation_cost_usd: Schema.NullOr(Schema.Number),
    estimated_cache_read_cost_usd: Schema.NullOr(Schema.Number),
    estimated_cost_usd: Schema.NullOr(Schema.Number),
    pricing_source: Schema.NullOr(TextColumn),
});

const SESSION_TOKEN_USAGE_SQL = `
SELECT model, prompt_tokens, completion_tokens, cache_creation_input_tokens,
    cache_read_input_tokens, estimated_tokens, estimated_input_cost_usd,
    estimated_output_cost_usd, estimated_cache_creation_cost_usd,
    estimated_cache_read_cost_usd, estimated_cost_usd, pricing_source
FROM session_token_usage
WHERE session = ?
LIMIT 1`;

export const fetchSessionTokenUsage = Effect.fn("share.fetchSessionTokenUsage")(
    function* (read: CacheReadService, sessionId: string) {
        const row = yield* read.first(SessionTokenUsageRow, SESSION_TOKEN_USAGE_SQL, [sessionId]);
        if (row._tag === "None") return null;
        const r = row.value;
        const usage: SessionTokenUsageDetail = { ...r };
        return usage;
    },
);

const TurnTokenUsageRow = Schema.Struct({
    seq: NumberFromBigIntColumn,
    model: Schema.NullOr(TextColumn),
    prompt_tokens: Schema.NullOr(NumberFromBigIntColumn),
    completion_tokens: Schema.NullOr(NumberFromBigIntColumn),
    cache_creation_input_tokens: Schema.NullOr(NumberFromBigIntColumn),
    cache_read_input_tokens: Schema.NullOr(NumberFromBigIntColumn),
    fresh_input_tokens: Schema.NullOr(NumberFromBigIntColumn),
    estimated_tokens: NumberFromBigIntColumn,
    estimated_input_cost_usd: Schema.NullOr(Schema.Number),
    estimated_output_cost_usd: Schema.NullOr(Schema.Number),
    estimated_cache_creation_cost_usd: Schema.NullOr(Schema.Number),
    estimated_cache_read_cost_usd: Schema.NullOr(Schema.Number),
    estimated_cost_usd: Schema.NullOr(Schema.Number),
    pricing_source: Schema.NullOr(TextColumn),
    usage_source: TextColumn,
    usage_quality: TextColumn,
});

const TURN_TOKEN_USAGE_SQL = `
SELECT seq, model, prompt_tokens, completion_tokens, cache_creation_input_tokens,
    cache_read_input_tokens, fresh_input_tokens, estimated_tokens,
    estimated_input_cost_usd, estimated_output_cost_usd,
    estimated_cache_creation_cost_usd, estimated_cache_read_cost_usd,
    estimated_cost_usd, pricing_source, usage_source, usage_quality
FROM turn_token_usage
WHERE session = ?
ORDER BY seq ASC
LIMIT 2000`;

export const fetchSessionTurnTokenUsage = Effect.fn("share.fetchSessionTurnTokenUsage")(
    function* (read: CacheReadService, sessionId: string) {
        const rows = yield* read.rows(TurnTokenUsageRow, TURN_TOKEN_USAGE_SQL, [sessionId]);
        return rows.map((r): TurnTokenUsageDetail => ({ ...r }));
    },
);

// ---------------------------------------------------------------------------
// share turns (the transcript spine)
// ---------------------------------------------------------------------------

const EXCLUDED_MESSAGE_KINDS = ["system", "attachment", "queue-operation"];

const ShareTurnRow = Schema.Struct({
    id: TextColumn,
    seq: NumberFromBigIntColumn,
    ts: TimestampColumn,
    role: TextColumn,
    message_kind: Schema.NullOr(TextColumn),
    intent_kind: Schema.NullOr(TextColumn),
    text: Schema.NullOr(TextColumn),
    text_excerpt: Schema.NullOr(TextColumn),
    has_tool_use: Schema.Boolean,
    has_error: Schema.Boolean,
});

const SHARE_TURNS_SQL = `
SELECT id, seq, ts, role, message_kind, intent_kind, text, text_excerpt, has_tool_use, has_error
FROM turn
WHERE session = ? AND (message_kind IS NULL OR message_kind NOT IN (${EXCLUDED_MESSAGE_KINDS.map(() => "?").join(", ")}))
ORDER BY seq ASC
LIMIT 2000`;

export const fetchSessionShareTurns = Effect.fn("share.fetchSessionShareTurns")(
    function* (read: CacheReadService, sessionId: string) {
        const rows = yield* read.rows(ShareTurnRow, SHARE_TURNS_SQL, [sessionId, ...EXCLUDED_MESSAGE_KINDS]);
        return rows.map((r): ShareTurn => {
            const text = r.text ?? r.text_excerpt ?? "";
            return {
                id: r.id,
                seq: r.seq,
                role: r.role,
                text,
                ts: r.ts.toISOString(),
                ...(r.message_kind ? { message_kind: r.message_kind } : {}),
                ...(r.intent_kind ? { intent_kind: r.intent_kind } : {}),
                ...(r.text_excerpt ? { text_excerpt: r.text_excerpt } : {}),
                has_tool_use: r.has_tool_use,
                has_error: r.has_error,
            };
        });
    },
);

// ---------------------------------------------------------------------------
// share timeline (tool-call activity feed)
// ---------------------------------------------------------------------------

const ShareTimelineRow = Schema.Struct({
    id: TextColumn,
    ts: TimestampColumn,
    title: TextColumn,
    summary: Schema.NullOr(TextColumn),
});

const SHARE_TIMELINE_SQL = `
SELECT id, ts, COALESCE(command_norm, name) AS title, output_excerpt AS summary
FROM tool_call
WHERE session = ?
ORDER BY ts ASC
LIMIT 200`;

export const fetchSessionShareTimeline = Effect.fn("share.fetchSessionShareTimeline")(
    function* (read: CacheReadService, sessionId: string) {
        const rows = yield* read.rows(ShareTimelineRow, SHARE_TIMELINE_SQL, [sessionId]);
        return rows.map(
            (r): ShareEvent => ({
                id: r.id,
                kind: "tool_call",
                actor: "agent",
                title: r.title,
                ts: r.ts.toISOString(),
                ...(r.summary ? { summary: r.summary } : {}),
            }),
        );
    },
);

// ---------------------------------------------------------------------------
// share files (edited files)
// ---------------------------------------------------------------------------

const ShareFileRow = Schema.Struct({
    path: TextColumn,
    lang: Schema.NullOr(TextColumn),
});

const SHARE_FILES_SQL = `
SELECT DISTINCT COALESCE(e.path_seen, f.path) AS path, f.lang AS lang
FROM edited e
JOIN turn t ON t.id = e.in_id
LEFT JOIN file f ON f.id = e.out_id
WHERE t.session = ?
ORDER BY path ASC
LIMIT 200`;

export const fetchSessionShareFiles = Effect.fn("share.fetchSessionShareFiles")(
    function* (read: CacheReadService, sessionId: string) {
        const rows = yield* read.rows(ShareFileRow, SHARE_FILES_SQL, [sessionId]);
        return rows
            .filter((r) => r.path !== null && r.path.length > 0)
            .map((r): ShareFile => ({ path: r.path, role: "edited", ...(r.lang ? { lang: r.lang } : {}) }));
    },
);

// ---------------------------------------------------------------------------
// per-turn tool calls
// ---------------------------------------------------------------------------

export interface ShareTurnToolCall {
    readonly seq: number;
    readonly name: string;
    readonly command: string | null;
    readonly input_json: string | null;
    readonly output: string | null;
    readonly has_error: boolean;
}

const ShareTurnToolCallRow = Schema.Struct({
    seq: NumberFromBigIntColumn,
    name: TextColumn,
    command_norm: Schema.NullOr(TextColumn),
    command_text: Schema.NullOr(TextColumn),
    input_json: Schema.NullOr(TextColumn),
    output_excerpt: Schema.NullOr(TextColumn),
    has_error: Schema.Boolean,
});

const SHARE_TURN_TOOLCALLS_SQL = `
SELECT seq, name, command_norm, command_text, input_json, output_excerpt, has_error
FROM tool_call
WHERE session = ? AND seq IS NOT NULL
ORDER BY seq ASC
LIMIT 4000`;

export const fetchSessionShareTurnToolCalls = Effect.fn("share.fetchSessionShareTurnToolCalls")(
    function* (read: CacheReadService, sessionId: string) {
        const rows = yield* read.rows(ShareTurnToolCallRow, SHARE_TURN_TOOLCALLS_SQL, [sessionId]);
        return rows.map(
            (r): ShareTurnToolCall => ({
                seq: r.seq,
                name: r.name,
                command: r.command_norm ?? r.command_text,
                input_json: r.input_json,
                output: r.output_excerpt,
                has_error: r.has_error,
            }),
        );
    },
);

// ---------------------------------------------------------------------------
// hook fires (file-context injection decisions)
// ---------------------------------------------------------------------------

export type ShareHookFire = Omit<HookFireDto, "idx">;

const HookFireRow = Schema.Struct({
    ts: TimestampColumn,
    event: TextColumn,
    file_path: TextColumn,
    inject: Schema.Boolean,
    reason: TextColumn,
    latency_ms: NumberFromBigIntColumn,
    injected_titles: JsonArrayColumn(Schema.String),
});

const HOOK_FIRES_SQL = `
SELECT ts, event, file_path, inject, reason, latency_ms, injected_titles
FROM hook_fire
WHERE session = ?
ORDER BY ts ASC
LIMIT 2000`;

export const fetchSessionShareHookFires = Effect.fn("share.fetchSessionShareHookFires")(
    function* (read: CacheReadService, sessionId: string) {
        const rows = yield* read.rows(HookFireRow, HOOK_FIRES_SQL, [sessionId]);
        return rows.map(
            (r): ShareHookFire => ({
                ts: r.ts.toISOString(),
                event: r.event,
                file_path: r.file_path,
                inject: r.inject,
                reason: r.reason,
                latency_ms: r.latency_ms,
                injected_titles: r.injected_titles,
            }),
        );
    },
);

// ---------------------------------------------------------------------------
// harness hooks (guardrail hooks that actually did something)
// ---------------------------------------------------------------------------

export type ShareHarnessHookRow = Omit<ShareHarnessHook, "idx" | "anchor_turn_seq">;

const HARNESS_DETAIL_MAX = 600;
const HARNESS_EFFECTS = ["blocked", "modified_input", "injected_context", "notified"];

/** Pull `additionalContext` out of a hook's stdout JSON (the text the harness
 *  actually saw injected), tolerating a missing/malformed payload. Duplicated
 *  from `queries/session-detail.ts` (2b's file) rather than imported - see the
 *  module doc for why this file does not import from `queries/`. */
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

const harnessHookDetail = (row: {
    readonly blocking_error_excerpt: string | null;
    readonly content_excerpt: string | null;
    readonly stdout_excerpt: string | null;
    readonly stderr_excerpt: string | null;
}): string | undefined => {
    const detail =
        row.blocking_error_excerpt ??
        row.content_excerpt ??
        extractInjectedContext(row.stdout_excerpt) ??
        row.stderr_excerpt;
    if (!detail) return undefined;
    const trimmed = detail.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.length > HARNESS_DETAIL_MAX ? `${trimmed.slice(0, HARNESS_DETAIL_MAX - 1)}…` : trimmed;
};

const HarnessHookRow = Schema.Struct({
    ts: TimestampColumn,
    event_name: TextColumn,
    hook_name: TextColumn,
    effect: TextColumn,
    provider_status: TextColumn,
    command: Schema.NullOr(TextColumn),
    stdout_excerpt: Schema.NullOr(TextColumn),
    content_excerpt: Schema.NullOr(TextColumn),
    blocking_error_excerpt: Schema.NullOr(TextColumn),
    stderr_excerpt: Schema.NullOr(TextColumn),
});

const HARNESS_HOOKS_SQL = `
SELECT ts, event_name, hook_name, effect, provider_status, command,
    stdout_excerpt, content_excerpt, blocking_error_excerpt, stderr_excerpt
FROM hook_command_invocation
WHERE session = ? AND effect IN (${HARNESS_EFFECTS.map(() => "?").join(", ")})
ORDER BY ts ASC
LIMIT 2000`;

export const fetchSessionShareHarnessHooks = Effect.fn("share.fetchSessionShareHarnessHooks")(
    function* (read: CacheReadService, sessionId: string) {
        const rows = yield* read.rows(HarnessHookRow, HARNESS_HOOKS_SQL, [sessionId, ...HARNESS_EFFECTS]);
        return rows.map((r): ShareHarnessHookRow => {
            const detail = harnessHookDetail(r);
            return {
                ts: r.ts.toISOString(),
                event_name: r.event_name,
                hook_name: r.hook_name,
                effect: r.effect,
                status: r.provider_status,
                ...(r.command ? { command: r.command } : {}),
                ...(detail ? { detail } : {}),
            };
        });
    },
);

// ---------------------------------------------------------------------------
// dissected turn content (content_document / content_block / content_atom)
// ---------------------------------------------------------------------------

const ContentDocumentRow = Schema.Struct({
    document_id: TextColumn,
    parser_id: TextColumn,
    parser_version: TextColumn,
    blockset_hash: Schema.NullOr(TextColumn),
    turn_seq: NumberFromBigIntColumn,
});

const CONTENT_DOCUMENTS_SQL = `
SELECT d.id AS document_id, d.parser_id AS parser_id, d.parser_version AS parser_version,
    d.blockset_hash AS blockset_hash, t.seq AS turn_seq
FROM content_document d
JOIN turn t ON t.id = d.turn
WHERE d.source_kind = 'turn' AND d.session = ?
ORDER BY turn_seq`;

const ContentBlockRow = Schema.Struct({
    document_id: TextColumn,
    seq: NumberFromBigIntColumn,
    parent_seq: Schema.NullOr(NumberFromBigIntColumn),
    kind: TextColumn,
    role: Schema.NullOr(TextColumn),
    heading: Schema.NullOr(TextColumn),
    text: Schema.NullOr(TextColumn),
    text_excerpt: Schema.NullOr(TextColumn),
    start_offset: Schema.NullOr(NumberFromBigIntColumn),
    end_offset: Schema.NullOr(NumberFromBigIntColumn),
    confidence: Schema.Number,
});

const ContentAtomRow = Schema.Struct({
    document_id: TextColumn,
    block_seq: NumberFromBigIntColumn,
    kind: TextColumn,
    value: TextColumn,
    normalized: Schema.NullOr(TextColumn),
    confidence: Schema.Number,
    raw: Schema.NullOr(TextColumn),
});

const parseRawField = (raw: string | null): unknown => {
    if (raw === null) return null;
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return raw;
    }
};

/** Bulk `document IN (...)` fetch, chunked so one session's document count
 *  never produces an unbounded bound-parameter list. */
const CONTENT_CHUNK = 400;

const chunk = <T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
};

/**
 * Resolve every turn's dissected content (structured message blocks + atoms)
 * for a session, keyed by turn seq. Best-effort by design - the caller
 * (`exportSessionShare`) already treats a failure here as "no structured
 * content", not a fatal export error.
 */
export const resolveTurnContent = Effect.fn("share.resolveTurnContent")(
    function* (read: CacheReadService, sessionId: string) {
        const byTurn = new Map<number, InspectTurnContentDto>();

        const documents = yield* read.rows(ContentDocumentRow, CONTENT_DOCUMENTS_SQL, [sessionId]);
        if (documents.length === 0) return byTurn;

        const turnSeqByDocId = new Map<string, number>();
        const metaByDocId = new Map<string, (typeof documents)[number]>();
        for (const d of documents) {
            turnSeqByDocId.set(d.document_id, d.turn_seq);
            metaByDocId.set(d.document_id, d);
        }
        const docIds = documents.map((d) => d.document_id);

        const blockChunks = chunk(docIds, CONTENT_CHUNK);
        const blockRows = (
            yield* Effect.forEach(
                blockChunks,
                (ids) =>
                    read.rows(
                        ContentBlockRow,
                        `SELECT document AS document_id, seq, parent_seq, kind, role, heading, text,
                            text_excerpt, start_offset, end_offset, confidence
                         FROM content_block
                         WHERE document IN (${ids.map(() => "?").join(", ")})
                         ORDER BY document, seq`,
                        ids,
                    ),
                { concurrency: 4 },
            )
        ).flat();

        const atomChunks = chunk(docIds, CONTENT_CHUNK);
        const atomRows = (
            yield* Effect.forEach(
                atomChunks,
                (ids) =>
                    read.rows(
                        ContentAtomRow,
                        `SELECT ca.document AS document_id, cb.seq AS block_seq, ca.kind, ca.value,
                            ca.normalized, ca.confidence, ca.raw
                         FROM content_atom ca
                         JOIN content_block cb ON cb.id = ca.block
                         WHERE ca.document IN (${ids.map(() => "?").join(", ")})
                         ORDER BY ca.document, cb.seq`,
                        ids,
                    ),
                { concurrency: 4 },
            )
        ).flat();

        const atomsByDocAndBlock = new Map<string, InspectContentAtomDto[]>();
        for (const atom of atomRows) {
            const key = `${atom.document_id}\0${atom.block_seq}`;
            const list = atomsByDocAndBlock.get(key) ?? [];
            list.push({
                kind: atom.kind,
                value: atom.value,
                normalized: atom.normalized,
                confidence: atom.confidence,
                raw: parseRawField(atom.raw),
            });
            atomsByDocAndBlock.set(key, list);
        }

        const blocksByTurn = new Map<number, InspectContentBlockDto[]>();
        for (const row of blockRows) {
            const turnSeq = turnSeqByDocId.get(row.document_id);
            if (turnSeq === undefined) continue;
            const atoms = atomsByDocAndBlock.get(`${row.document_id}\0${row.seq}`) ?? [];
            const blocks = blocksByTurn.get(turnSeq) ?? [];
            blocks.push({
                seq: row.seq,
                parent_seq: row.parent_seq,
                kind: row.kind,
                role: row.role,
                heading: row.heading,
                text: row.text,
                text_excerpt: row.text_excerpt,
                start_offset: row.start_offset,
                end_offset: row.end_offset,
                confidence: row.confidence,
                atoms,
            });
            blocksByTurn.set(turnSeq, blocks);
            const meta = metaByDocId.get(row.document_id);
            if (meta === undefined) continue;
            byTurn.set(turnSeq, {
                document_id: row.document_id,
                parser_id: meta.parser_id,
                parser_version: meta.parser_version,
                blockset_hash: meta.blockset_hash,
                blocks,
            });
        }
        return byTurn;
    },
);
