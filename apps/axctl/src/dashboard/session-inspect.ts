/**
 * Build a SessionInspectPayload by reading the JSONL transcript file for the
 * given session id and dissecting each message's text into typed spans.
 *
 * Used by `/api/sessions/:id/inspect` and reused by
 * `scripts/prototypes/ax-session-inspect.ts`.
 */

import { Data, Effect, FileSystem, type Path } from "effect";
import { dissectTurn, type TurnSpan } from "../ingest/turn-dissect.ts";
import { extractCodexJsonlLines, type CodexTurnTokenUsage } from "../ingest/codex.ts";
import { estimateCost } from "../ingest/model-pricing.ts";
import { turnRecordKey } from "@ax/lib/ids";
import { SurrealClient } from "@ax/lib/db";
import { decodeJsonRecordOrNull, encodeJson } from "@ax/lib/decode";
import { resolveTurnContent, resolveTurnContentForSourceRefs } from "../queries/session-turn-content.ts";
import { locateTranscript, type TranscriptNotFoundError } from "@ax/lib/transcript-locator";
import type {
    HookFireDto,
    InspectSpanDto,
    InspectSpanKind,
    InspectTurnContentDto,
    InspectTurnDto,
    SessionInspectPayload,
    SessionTokenUsageDetail,
    SpawnMeta,
    TurnTokenUsageDetail,
} from "@ax/lib/shared/dashboard-types";
import {
    interpolateRid,
    queryMany,
    queryOptional,
} from "@ax/lib/shared/graph-query";
import { safeKeyPart } from "@ax/lib/shared/derive-keys";
import { clampPagination, type PaginationConfig } from "@ax/lib/shared/pagination";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import { recordRef } from "@ax/lib/shared/surql";

const INSPECT_TURNS_PAGINATION: PaginationConfig = { defaultLimit: 2000, maxLimit: 2000 };

export class SessionInspectReadError extends Data.TaggedError("SessionInspectReadError")<{
    readonly path: string;
    readonly message: string;
    readonly cause: unknown;
}> {}

export interface JsonlContentBlock {
    type: string;
    text?: string;
    content?: unknown;
    name?: string;
    input?: unknown;
}

interface JsonlMessage {
    type: string;
    timestamp?: string;
    sessionId?: string;
    cwd?: string;
    message?: {
        role?: string;
        content?: string | JsonlContentBlock[];
    };
}

function isSubagentLifecycleText(text: string): boolean {
    const trimmed = text.trimStart();
    return trimmed.startsWith("<task-notification>") ||
        trimmed.startsWith("<subagent_notification>");
}

function toolResultContentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return (content as Array<{ text?: string }>)
            .map((b) => b.text ?? "")
            .join("");
    }
    return "";
}

export function jsonlBlockToInspectorText(block: JsonlContentBlock): string {
    if (block.type === "text" && typeof block.text === "string") return block.text;
    if (block.type === "tool_result") {
        const innerText = toolResultContentToText(block.content);
        if (isSubagentLifecycleText(innerText)) return innerText;
        if (innerText) return `<local-command-stdout>${innerText}</local-command-stdout>`;
        return "<local-command-stdout></local-command-stdout>";
    }
    if (block.type === "tool_use") {
        const name = block.name ? ` name="${block.name.replace(/"/g, "")}"` : "";
        const input = encodeJson(block.input ?? {});
        const clipped = input.length > 400 ? `${input.slice(0, 400)}...` : input;
        return `<tool_use${name}>${clipped}</tool_use>`;
    }
    return "";
}

function dominantKind(spans: readonly TurnSpan[], fallback: InspectSpanKind): InspectSpanKind {
    if (spans.length === 0) return fallback;
    const sizes = new Map<InspectSpanKind, number>();
    for (const s of spans) sizes.set(s.kind, (sizes.get(s.kind) ?? 0) + s.text.length);
    let best: InspectSpanKind = fallback;
    let bestSize = -1;
    for (const [k, sz] of sizes) {
        if (sz > bestSize) { best = k; bestSize = sz; }
    }
    return best;
}

const toSpanDto = (s: TurnSpan): InspectSpanDto =>
    s.label !== undefined ? { kind: s.kind, text: s.text, label: s.label } : { kind: s.kind, text: s.text };

function contentMatchesText(content: InspectTurnContentDto | undefined, text: string): boolean {
    if (!content) return false;
    const sample = text.trimStart().slice(0, 240);
    if (!sample) return false;
    const rootText = content.blocks
        .filter((block) => block.parent_seq == null)
        .map((block) => block.text ?? "")
        .join("\n")
        .trimStart();
    if (!rootText) return false;
    return rootText.startsWith(sample) || sample.startsWith(rootText.slice(0, 240));
}

function findTurnContent(
    turnContent: Map<number, InspectTurnContentDto>,
    currentSeq: number,
    text: string,
): InspectTurnContentDto | null {
    // JSONL inspector turns are zero-based and omit some normalized DB rows
    // (reasoning frames, provider-native internals). Prefer nearby DB turn
    // seqs, but only attach when the parsed block text actually matches the
    // rendered raw text; otherwise a missing DB seq can shift all later blocks.
    const candidates = [currentSeq + 1, currentSeq, currentSeq + 2, currentSeq - 1];
    for (const seq of candidates) {
        const content = turnContent.get(seq);
        if (contentMatchesText(content, text)) return content ?? null;
    }
    for (const content of turnContent.values()) {
        if (contentMatchesText(content, text)) return content;
    }
    return null;
}

interface CanonicalTurn {
    readonly role: string;       // 'user' | 'assistant' | 'developer' | etc.
    readonly text: string;
    readonly ts: string | null;
}

function parseClaudeLine(line: string): CanonicalTurn | null {
    const entry = decodeJsonRecordOrNull(line) as JsonlMessage | null;
    if (entry === null) return null;
    if (entry.type !== "user" && entry.type !== "assistant") return null;
    const content = entry.message?.content;
    const text = typeof content === "string"
        ? content
        : Array.isArray(content) ? content.map(jsonlBlockToInspectorText).join("") : "";
    if (!text) return null;
    return {
        role: entry.message?.role ?? entry.type,
        text,
        ts: entry.timestamp ?? null,
    };
}

/** Codex JSONL line shape - payload.type drives semantics. */
interface CodexLine {
    timestamp?: string;
    type?: string;
    payload?: {
        type?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
        name?: string;
        arguments?: string;
        output?: unknown;
        call_id?: string;
    };
}

export function codexContentToInspectorText(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
        .map((b) => (b.type === "input_text" || b.type === "output_text") ? (b.text ?? "") : "")
        .filter((text) => text.length > 0)
        .join("\n");
}

function parseCodexLine(line: string): CanonicalTurn | null {
    const entry = decodeJsonRecordOrNull(line) as CodexLine | null;
    if (entry === null) return null;
    const p = entry.payload;
    if (!p) return null;
    if (p.type === "message") {
        if (p.role !== "user" && p.role !== "assistant" && p.role !== "developer") return null;
        const text = codexContentToInspectorText(p.content);
        if (!text) return null;
        return { role: p.role, text, ts: entry.timestamp ?? null };
    }
    if (p.type === "function_call") {
        const name = p.name ?? "function";
        const args = p.arguments ?? "{}";
        const clipped = args.length > 400 ? `${args.slice(0, 400)}...` : args;
        return {
            role: "assistant",
            text: `<tool_use name="${name.replace(/"/g, "")}">${clipped}</tool_use>`,
            ts: entry.timestamp ?? null,
        };
    }
    if (p.type === "function_call_output") {
        const out = typeof p.output === "string" ? p.output : encodeJson(p.output ?? {});
        return {
            role: "user",
            text: `<local-command-stdout>${out}</local-command-stdout>`,
            ts: entry.timestamp ?? null,
        };
    }
    return null;
}

interface ParentInfo {
    readonly parent_session: string | null;
    readonly parent_nickname: string | null;
}

interface ChildEdge {
    readonly session_id: string;
    readonly ts: string | null;
    readonly tool: string | null;
    readonly nickname: string | null;
}

/** SQL constants kept near their resolvers so the only thing the helper hides
 *  is the Effect.gen + Effect.catch ceremony - the SQL stays grep-able. */
const PARENT_SQL = `
    SELECT <string>in AS parent, nickname FROM spawned WHERE out = $sid LIMIT 1;
`;
const SESSION_META_SQL = `
    SELECT project, cwd, raw_file, source FROM session WHERE id = $sid LIMIT 1;
`;
const CHILDREN_SQL = `
    SELECT <string>out AS child, <string>ts AS ts, tool, nickname
    FROM spawned
    WHERE in = $sid
    ORDER BY ts ASC;
`;
const HOOK_FIRES_SQL = `
    SELECT ts, event, file_path, inject, reason, latency_ms, injected_titles
    FROM hook_fire
    WHERE session = $sid
    ORDER BY ts ASC;
`;
const TOKEN_USAGE_SQL = `
    SELECT model, prompt_tokens, completion_tokens,
           cache_creation_input_tokens, cache_read_input_tokens,
           estimated_tokens,
           estimated_input_cost_usd, estimated_output_cost_usd,
           estimated_cache_creation_cost_usd, estimated_cache_read_cost_usd,
           estimated_cost_usd, pricing_source
    FROM session_token_usage
    WHERE session = $sid
    LIMIT 1;
`;
const TURN_TOKEN_USAGE_SQL = `
    SELECT seq, model, prompt_tokens, completion_tokens,
           cache_creation_input_tokens, cache_read_input_tokens,
           fresh_input_tokens, estimated_tokens,
           estimated_input_cost_usd, estimated_output_cost_usd,
           estimated_cache_creation_cost_usd, estimated_cache_read_cost_usd,
           estimated_cost_usd, pricing_source, usage_source, usage_quality
    FROM turn_token_usage
    WHERE session = $sid
    ORDER BY seq ASC;
`;
const TURN_TOKEN_USAGE_FOR_REFS_SQL = `
    SELECT seq, model, prompt_tokens, completion_tokens,
           cache_creation_input_tokens, cache_read_input_tokens,
           fresh_input_tokens, estimated_tokens,
           estimated_input_cost_usd, estimated_output_cost_usd,
           estimated_cache_creation_cost_usd, estimated_cache_read_cost_usd,
           estimated_cost_usd, pricing_source, usage_source, usage_quality
    FROM $refs
    ORDER BY seq ASC;
`;

interface ParentRow { readonly parent: string | null; readonly nickname: string | null }
interface ChildEdgeRow {
    readonly child: string;
    readonly ts: string | null;
    readonly tool: string | null;
    readonly nickname: string | null;
}
/** Raw shape returned by Surreal for hook_fire SELECT. Datetime fields come
 *  back as JS Date via the SDK. */
interface HookFireRow {
    readonly ts: Date | string;
    readonly event: string;
    readonly file_path: string;
    readonly inject: boolean;
    readonly reason: string;
    readonly latency_ms: number;
    readonly injected_titles: ReadonlyArray<string> | null;
}
interface TokenUsageRow {
    readonly model: string | null;
    readonly prompt_tokens: number | null;
    readonly completion_tokens: number | null;
    readonly cache_creation_input_tokens: number | null;
    readonly cache_read_input_tokens: number | null;
    readonly estimated_tokens: number;
    readonly estimated_input_cost_usd?: number | null;
    readonly estimated_output_cost_usd?: number | null;
    readonly estimated_cache_creation_cost_usd?: number | null;
    readonly estimated_cache_read_cost_usd?: number | null;
    readonly estimated_cost_usd: number | null;
    readonly pricing_source: string | null;
}
interface TurnTokenUsageRow extends TokenUsageRow {
    readonly seq: number;
    readonly fresh_input_tokens: number | null;
    readonly usage_source: string | null;
    readonly usage_quality: string | null;
}
interface GraphTurnRow {
    readonly seq: number;
    readonly role: string;
    readonly ts: string | Date | null;
    readonly text: string | null;
}
interface GraphSessionHealthRow {
    readonly turns?: number | null;
}

/** Resolve the spawning parent of this session (codex spawn_agent / claude
 *  Task). Returns nulls if not a subagent. Defensive: swallows DB errors so
 *  the inspector still renders without graph attribution. */
const resolveParent = (sessionId: string): Effect.Effect<ParentInfo, never, SurrealClient> =>
    queryOptional<ParentRow, ParentInfo>(
        interpolateRid(PARENT_SQL, toBareSessionId(sessionId)),
        (row) => ({
            // Strip the record-id decoration before the value crosses the
            // HTTP seam. See src/lib/shared/session-id.ts for the seam.
            parent_session: row.parent ? toBareSessionId(row.parent) : null,
            parent_nickname: row.nickname ?? null,
        }),
        "session-inspect resolveParent",
    ).pipe(Effect.map((v) => v ?? { parent_session: null, parent_nickname: null }));

interface SessionMeta {
    readonly project: string | null;
    readonly cwd: string | null;
    readonly raw_file: string | null;
    readonly source: string | null;
}
interface SessionMetaRow {
    readonly project?: string | null;
    readonly cwd?: string | null;
    readonly raw_file?: string | null;
    readonly source?: string | null;
}

/** The session's canonical project key + cwd, for the inspect header label.
 *  Defensive: swallows DB errors so the inspector still renders unlabelled. */
const resolveSessionMeta = (sessionId: string): Effect.Effect<SessionMeta, never, SurrealClient> =>
    queryOptional<SessionMetaRow, SessionMeta>(
        interpolateRid(SESSION_META_SQL, toBareSessionId(sessionId)),
        (row) => ({
            project: row.project ?? null,
            cwd: row.cwd ?? null,
            raw_file: row.raw_file ?? null,
            source: row.source ?? null,
        }),
        "session-inspect resolveSessionMeta",
    ).pipe(Effect.map((v) => v ?? { project: null, cwd: null, raw_file: null, source: null }));

/** Sessions this one spawned (its subagents). Same defensive shape as
 *  resolveParent - DB failure degrades to empty list. */
const resolveChildren = (sessionId: string): Effect.Effect<ReadonlyArray<ChildEdge>, never, SurrealClient> =>
    queryMany<ChildEdgeRow, ChildEdge>(
        interpolateRid(CHILDREN_SQL, toBareSessionId(sessionId)),
        (r) => ({
            // Bare session id over the HTTP seam.
            session_id: toBareSessionId(r.child),
            ts: r.ts ?? null,
            tool: r.tool ?? null,
            nickname: r.nickname ?? null,
        }),
        "session-inspect resolveChildren",
    );

/** Fetch every hook_fire row for the session, ts-ordered. N is small
 *  (tens-to-hundreds in practice) so fetching whole-session is fine; the
 *  window filter happens after assigning stable idx so paginating doesn't
 *  shift the dom anchors. Degrades to [] on DB error - hook telemetry is
 *  decorative for the inspector, not load-bearing. */
const resolveHookFires = (sessionId: string): Effect.Effect<ReadonlyArray<HookFireDto>, never, SurrealClient> =>
    queryMany<HookFireRow, HookFireDto>(
        interpolateRid(HOOK_FIRES_SQL, toBareSessionId(sessionId)),
        (row, idx) => ({
            idx,
            ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
            event: row.event,
            file_path: row.file_path,
            inject: row.inject,
            reason: row.reason,
            latency_ms: row.latency_ms,
            injected_titles: row.injected_titles ?? [],
        }),
        "session-inspect resolveHookFires",
    );

const resolveTokenUsage = (sessionId: string): Effect.Effect<SessionTokenUsageDetail | null, never, SurrealClient> =>
    queryOptional<TokenUsageRow, SessionTokenUsageDetail>(
        interpolateRid(TOKEN_USAGE_SQL, toBareSessionId(sessionId)),
        (row) => ({
            model: row.model ?? null,
            prompt_tokens: row.prompt_tokens ?? null,
            completion_tokens: row.completion_tokens ?? null,
            cache_creation_input_tokens: row.cache_creation_input_tokens ?? null,
            cache_read_input_tokens: row.cache_read_input_tokens ?? null,
            estimated_tokens: Number(row.estimated_tokens ?? 0),
            estimated_input_cost_usd: row.estimated_input_cost_usd ?? null,
            estimated_output_cost_usd: row.estimated_output_cost_usd ?? null,
            estimated_cache_creation_cost_usd: row.estimated_cache_creation_cost_usd ?? null,
            estimated_cache_read_cost_usd: row.estimated_cache_read_cost_usd ?? null,
            estimated_cost_usd: row.estimated_cost_usd ?? null,
            pricing_source: row.pricing_source ?? null,
        }),
        "session-inspect resolveTokenUsage",
    );

const mapTurnTokenUsageRow = (row: TurnTokenUsageRow): TurnTokenUsageDetail => ({
    seq: Number(row.seq),
    model: row.model ?? null,
    prompt_tokens: row.prompt_tokens ?? null,
    completion_tokens: row.completion_tokens ?? null,
    cache_creation_input_tokens: row.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: row.cache_read_input_tokens ?? null,
    fresh_input_tokens: row.fresh_input_tokens ?? null,
    estimated_tokens: Number(row.estimated_tokens ?? 0),
    estimated_input_cost_usd: row.estimated_input_cost_usd ?? null,
    estimated_output_cost_usd: row.estimated_output_cost_usd ?? null,
    estimated_cache_creation_cost_usd: row.estimated_cache_creation_cost_usd ?? null,
    estimated_cache_read_cost_usd: row.estimated_cache_read_cost_usd ?? null,
    estimated_cost_usd: row.estimated_cost_usd ?? null,
    pricing_source: row.pricing_source ?? null,
    usage_source: row.usage_source ?? "unknown",
    usage_quality: row.usage_quality ?? "unknown",
});

const resolveTurnTokenUsage = (sessionId: string): Effect.Effect<Map<number, TurnTokenUsageDetail>, never, SurrealClient> =>
    queryMany<TurnTokenUsageRow, TurnTokenUsageDetail>(
        interpolateRid(TURN_TOKEN_USAGE_SQL, toBareSessionId(sessionId)),
        mapTurnTokenUsageRow,
        "session-inspect resolveTurnTokenUsage",
    ).pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.seq, row]))),
    );

const resolveTurnTokenUsageForSourceRefs = (
    sourceRefs: ReadonlyArray<string>,
): Effect.Effect<Map<number, TurnTokenUsageDetail>, never, SurrealClient> => {
    const refs = sourceRefs.map((key) => recordRef("turn_token_usage", key));
    if (refs.length === 0) return Effect.succeed(new Map<number, TurnTokenUsageDetail>());
    return queryMany<TurnTokenUsageRow, TurnTokenUsageDetail>(
        TURN_TOKEN_USAGE_FOR_REFS_SQL.split("$refs").join(`[${refs.join(", ")}]`),
        mapTurnTokenUsageRow,
        "session-inspect resolveTurnTokenUsageForSourceRefs",
    ).pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.seq, row]))),
    );
};

const turnSourceRefsForWindow = (
    sessionId: string,
    turnOffset: number,
    turnLimit: number,
): ReadonlyArray<string> => {
    const bare = toBareSessionId(sessionId);
    // DB turn records are one-based; the inspector API exposes zero-based
    // offsets/sequences. Fetch exactly the requested page by translating at
    // the storage seam.
    return Array.from({ length: turnLimit }, (_, i) => turnRecordKey(bare, turnOffset + i + 1));
};

const resolveGraphTurnWindow = (
    sessionId: string,
    turnOffset: number,
    turnLimit: number,
): Effect.Effect<ReadonlyArray<GraphTurnRow>, never, SurrealClient> => {
    const turnRefs = turnSourceRefsForWindow(sessionId, turnOffset, turnLimit);
    if (turnRefs.length === 0) return Effect.succeed([]);
    const from = turnRefs.map((key) => recordRef("turn", key)).join(", ");
    return queryMany<GraphTurnRow, GraphTurnRow>(
        `
            SELECT seq, role, type::string(ts) AS ts, text
            FROM [${from}]
            WHERE text IS NOT NONE
            ORDER BY seq ASC;
        `,
        (row) => row,
        "session-inspect resolveGraphTurnWindow",
    );
};

const resolveGraphSessionHealth = (
    sessionId: string,
): Effect.Effect<GraphSessionHealthRow | null, never, SurrealClient> =>
    queryOptional<GraphSessionHealthRow, GraphSessionHealthRow>(
        `SELECT turns FROM ${recordRef("session_health", safeKeyPart(toBareSessionId(sessionId)))} LIMIT 1;`,
        (row) => row,
        "session-inspect resolveGraphSessionHealth",
    );

function codexTurnUsageToDetail(usage: CodexTurnTokenUsage): TurnTokenUsageDetail {
    const cost = estimateCost({
        modelKey: usage.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        estimatedTokens: usage.estimatedTokens,
    });
    return {
        seq: usage.seq,
        model: usage.model,
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        cache_creation_input_tokens: usage.cacheCreationInputTokens,
        cache_read_input_tokens: usage.cacheReadInputTokens,
        fresh_input_tokens: usage.freshInputTokens,
        estimated_tokens: usage.estimatedTokens,
        estimated_input_cost_usd: cost.inputUsd,
        estimated_output_cost_usd: cost.outputUsd,
        estimated_cache_creation_cost_usd: cost.cacheCreationUsd,
        estimated_cache_read_cost_usd: cost.cacheReadUsd,
        estimated_cost_usd: cost.totalUsd,
        pricing_source: cost.pricingSource,
        usage_source: usage.usageSource,
        usage_quality: usage.usageQuality,
    };
}

function deriveCodexTurnTokenUsage(raw: string): Map<number, TurnTokenUsageDetail> {
    const extracted = extractCodexJsonlLines(raw.split("\n"));
    const usages = extracted?.turnTokenUsages ?? [];
    return new Map(usages.map((usage) => [usage.seq, codexTurnUsageToDetail(usage)]));
}

/** Spawn args parsed out of a parent tool_use call. Keyed by call_id when
 *  available (codex), else by ts so we can match approximately. */
interface SpawnCall {
    readonly ts: string | null;
    readonly call_id: string | null;
    readonly meta: SpawnMeta;
}

const SPAWN_TOOLS = new Set(["spawn_agent", "Task"]);

/** Full brief text - the SPA decides whether to clip for display. Cap at 20k
 *  chars defensively so a runaway prompt can't bloat the payload. */
function fullBrief(s: unknown): string | null {
    if (typeof s !== "string") return null;
    const trimmed = s.trim();
    if (!trimmed) return null;
    return trimmed.length <= 20_000 ? trimmed : `${trimmed.slice(0, 19_999)}…`;
}

function parseSpawnArgs(provider: "codex" | "claude", name: string, argsJson: unknown): SpawnMeta | null {
    if (!SPAWN_TOOLS.has(name)) return null;
    let args: Record<string, unknown> = {};
    if (typeof argsJson === "string") {
        const parsed = decodeJsonRecordOrNull(argsJson);
        if (parsed === null) return null;
        args = parsed;
    } else if (argsJson && typeof argsJson === "object") {
        args = argsJson as Record<string, unknown>;
    }
    if (provider === "codex") {
        return {
            provider: "codex",
            agent_type: typeof args.agent_type === "string" ? args.agent_type : null,
            fork_context: typeof args.fork_context === "boolean" ? args.fork_context : null,
            reasoning_effort: typeof args.reasoning_effort === "string" ? args.reasoning_effort : null,
            brief: fullBrief(args.message),
        };
    }
    // Claude Code Task: subagent_type, prompt, description
    return {
        provider: "claude",
        agent_type: typeof args.subagent_type === "string" ? args.subagent_type : null,
        fork_context: null,
        reasoning_effort: null,
        brief: fullBrief(args.prompt) ?? fullBrief(args.description),
    };
}

/** Best-effort: find the turn whose ts is the closest match to the spawn
 *  timestamp (within 60 s, prefer the turn at-or-just-before the spawn). */
function anchorChildToTurn(
    turns: ReadonlyArray<InspectTurnDto>,
    spawnTs: string | null,
): number | null {
    if (!spawnTs) return null;
    const spawnMs = new Date(spawnTs).getTime();
    if (!Number.isFinite(spawnMs)) return null;
    let best: number | null = null;
    let bestDelta = Infinity;
    for (const t of turns) {
        if (!t.ts) continue;
        const ms = new Date(t.ts).getTime();
        if (!Number.isFinite(ms)) continue;
        const delta = spawnMs - ms;
        // Prefer turns at-or-just-before the spawn (delta >= 0). Tolerate a
        // small overshoot for clock skew. Then minimise |delta|.
        if (delta < -5_000) continue;
        if (Math.abs(delta) > 60_000) continue;
        if (delta < bestDelta) {
            bestDelta = delta;
            best = t.seq;
        }
    }
    return best;
}

/** When the session has a parent, the first user-role turn whose dissected
 *  spans are entirely default-kind (no system/wrapper markers) is the task
 *  brief the parent passed in. Re-tag it as subagent_task. */
function applySubagentTaskTagging(
    turns: InspectTurnDto[],
    totals: Partial<Record<InspectSpanKind, number>>,
): void {
    for (const turn of turns) {
        if (turn.role !== "user") continue;
        if (turn.semantic_role !== "user_input") continue;
        // Skip the auto-injected <environment_context> envelope etc.
        const hasOnlyDefault = turn.spans.every((s) => s.kind === "user_input");
        if (!hasOnlyDefault || turn.char_count < 80) continue;
        // Found the brief: re-tag every span and update the semantic role.
        const retagged: InspectSpanDto[] = turn.spans.map((s) => {
            totals.user_input = (totals.user_input ?? 0) - s.text.length;
            totals.subagent_task = (totals.subagent_task ?? 0) + s.text.length;
            const dto: InspectSpanDto = s.label !== undefined
                ? { kind: "subagent_task", text: s.text, label: s.label }
                : { kind: "subagent_task", text: s.text };
            return dto;
        });
        (turn as { -readonly [K in keyof InspectTurnDto]: InspectTurnDto[K] }).semantic_role = "subagent_task";
        (turn as { -readonly [K in keyof InspectTurnDto]: InspectTurnDto[K] }).spans = retagged;
        return; // only the first qualifying message
    }
}

function hookFiresForTurnWindow(
    allHookFires: ReadonlyArray<HookFireDto>,
    turnSlice: ReadonlyArray<InspectTurnDto>,
    turnOffset: number,
    totalTurns: number,
): ReadonlyArray<HookFireDto> {
    const isFirstPage = turnOffset === 0;
    const isLastPage = turnOffset + turnSlice.length >= totalTurns;
    const firstTs = turnSlice.find((t) => t.ts)?.ts ?? null;
    const lastTs = [...turnSlice].reverse().find((t) => t.ts)?.ts ?? null;
    const firstMs = firstTs ? new Date(firstTs).getTime() : null;
    const lastMs = lastTs ? new Date(lastTs).getTime() : null;
    return allHookFires.filter((h) => {
        const hMs = new Date(h.ts).getTime();
        if (!Number.isFinite(hMs)) return false;
        // Before the window: include only on the first page.
        if (firstMs != null && hMs < firstMs) return isFirstPage;
        // After the window: include only on the last page.
        if (lastMs != null && hMs > lastMs) return isLastPage;
        // Within the [firstMs, lastMs] envelope - always include.
        // (If both bounds are null - all turns lack ts - keep everything
        // on the first page so the user still sees them.)
        if (firstMs == null && lastMs == null) return isFirstPage;
        return true;
    });
}

const fetchGraphSessionInspect = (
    bareSessionId: string,
    turnOffset: number,
    turnLimit: number,
): Effect.Effect<SessionInspectPayload | null, never, SurrealClient> =>
    Effect.gen(function* () {
        const turnSourceRefs = turnSourceRefsForWindow(bareSessionId, turnOffset, turnLimit);
        const [parent, sessionMeta, childrenEdges, allHookFires, tokenUsage, turnTokenUsage, graphTurns, health, turnContent] = yield* Effect.all([
            resolveParent(bareSessionId),
            resolveSessionMeta(bareSessionId),
            resolveChildren(bareSessionId),
            resolveHookFires(bareSessionId),
            resolveTokenUsage(bareSessionId),
            resolveTurnTokenUsageForSourceRefs(turnSourceRefs),
            resolveGraphTurnWindow(bareSessionId, turnOffset, turnLimit),
            resolveGraphSessionHealth(bareSessionId),
            resolveTurnContentForSourceRefs(turnSourceRefs),
        ], { concurrency: "unbounded" });

        const totalTurnsRaw = Number(health?.turns ?? 0);
        const totalTurns = Number.isFinite(totalTurnsRaw) && totalTurnsRaw > 0
            ? Math.trunc(totalTurnsRaw)
            : graphTurns.length;
        if (totalTurns <= 0) return null;
        if (graphTurns.length === 0 && turnOffset < totalTurns) return null;

        const turns: InspectTurnDto[] = [];
        const pageTotals: Partial<Record<InspectSpanKind, number>> = {};
        for (const row of graphTurns) {
            const text = row.text ?? "";
            if (!text) continue;
            const fallbackKind: InspectSpanKind = row.role === "assistant" ? "assistant_text" : "user_input";
            const spans = dissectTurn(text, { defaultKind: fallbackKind });
            const semantic = dominantKind(spans, fallbackKind);
            for (const s of spans) {
                pageTotals[s.kind] = (pageTotals[s.kind] ?? 0) + s.text.length;
            }
            const dbSeq = Number(row.seq);
            const seq = Number.isFinite(dbSeq) ? dbSeq - 1 : turns.length + turnOffset;
            turns.push({
                seq,
                role: row.role,
                semantic_role: semantic,
                ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
                char_count: text.length,
                raw_text: text,
                spans: spans.map(toSpanDto),
                token_usage: turnTokenUsage.get(dbSeq) ?? turnTokenUsage.get(seq) ?? null,
                content: findTurnContent(turnContent, seq, text),
            });
        }

        const totals = { ...pageTotals };
        if (parent.parent_session) applySubagentTaskTagging(turns, totals);

        const children = childrenEdges.map((edge) => ({
            session_id: edge.session_id,
            ts: edge.ts,
            tool: edge.tool,
            nickname: edge.nickname,
            anchor_turn_seq: anchorChildToTurn(turns, edge.ts),
            meta: null,
        }));

        const totalChars = Object.values(totals).reduce((sum, value) => sum + Number(value ?? 0), 0);

        return {
            session_id: bareSessionId,
            source_path: sessionMeta.raw_file ?? `graph:${bareSessionId}`,
            project: sessionMeta.project,
            cwd: sessionMeta.cwd,
            total_chars: totalChars,
            token_usage: tokenUsage,
            total_turns: totalTurns,
            turn_window: { offset: turnOffset, limit: turnLimit },
            turns,
            totals_by_kind: totals,
            parent_session: parent.parent_session,
            parent_nickname: parent.parent_nickname,
            children,
            hook_fires: hookFiresForTurnWindow(allHookFires, turns, turnOffset, totalTurns),
            total_hook_fires: allHookFires.length,
        };
    });

export interface FetchSessionInspectOptions {
    readonly turnOffset?: number;
    readonly turnLimit?: number;
}

/** Read the JSONL, dissect every user/assistant message, return a wire-format
 *  payload. Resolves parent session for subagent attribution.
 *
 *  When `turnLimit` is set, the returned `turns` is sliced to that window.
 *  `totals_by_kind` always reflects the full session - only `turns` is paged.
 *  This keeps the per-page payload small while preserving the legend %s. */
export const fetchSessionInspect = (
    sessionId: string,
    opts: FetchSessionInspectOptions = {},
): Effect.Effect<
    SessionInspectPayload,
    SessionInspectReadError | TranscriptNotFoundError,
    SurrealClient | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        // Normalise inbound id at the seam so the rest of the function operates
        // on a bare id (also what we echo back as payload.session_id).
        const bareSessionId = toBareSessionId(sessionId);
        const { offset: turnOffset, limit: turnLimit } = clampPagination(
            { offset: opts.turnOffset, limit: opts.turnLimit },
            INSPECT_TURNS_PAGINATION,
        );
        const graphPayload = yield* fetchGraphSessionInspect(bareSessionId, turnOffset, turnLimit);
        if (graphPayload) return graphPayload;

        const [parent, sessionMeta, childrenEdges, allHookFires, turnContent, tokenUsage, turnTokenUsage, found] = yield* Effect.all([
            resolveParent(bareSessionId),
            resolveSessionMeta(bareSessionId),
            resolveChildren(bareSessionId),
            resolveHookFires(bareSessionId),
            resolveTurnContent(bareSessionId),
            resolveTokenUsage(bareSessionId),
            resolveTurnTokenUsage(bareSessionId),
            locateTranscript(bareSessionId),
        ], { concurrency: "unbounded" });
        const fs = yield* FileSystem.FileSystem;
        // The read is the only failure source here; the rest of the body is
        // pure parsing. Preserve the original `Effect.tryPromise` behavior of
        // mapping ANY read failure into SessionInspectReadError.
        const raw = yield* fs.readFileString(found.path).pipe(
            Effect.catchTag("PlatformError", (err) =>
                new SessionInspectReadError({
                    path: found.path,
                    message: err.message,
                    cause: err,
                }),
            ),
        );
        const payload = ((): SessionInspectPayload => {
            const parseLine = found.harness === "codex" ? parseCodexLine : parseClaudeLine;
            const derivedTurnTokenUsage = found.harness === "codex"
                ? deriveCodexTurnTokenUsage(raw)
                : new Map<number, TurnTokenUsageDetail>();
            const tokenUsageForSeq = (currentSeq: number): TurnTokenUsageDetail | null =>
                turnTokenUsage.get(currentSeq + 1) ??
                turnTokenUsage.get(currentSeq) ??
                derivedTurnTokenUsage.get(currentSeq + 1) ??
                derivedTurnTokenUsage.get(currentSeq) ??
                null;

            const turns: InspectTurnDto[] = [];
            const totals: Partial<Record<InspectSpanKind, number>> = {};
            let totalChars = 0;
            let seq = 0;

            for (const line of raw.split("\n")) {
                if (!line.trim()) continue;
                const canonical = parseLine(line);
                if (!canonical) continue;
                const { role, text, ts } = canonical;
                const fallbackKind: InspectSpanKind = role === "assistant" ? "assistant_text" : "user_input";
                const spans = dissectTurn(text, { defaultKind: fallbackKind });
                const semantic = dominantKind(spans, fallbackKind);

                for (const s of spans) {
                    totals[s.kind] = (totals[s.kind] ?? 0) + s.text.length;
                }
                totalChars += text.length;

                const currentSeq = seq++;
                turns.push({
                    seq: currentSeq,
                    role,
                    semantic_role: semantic,
                    ts,
                    char_count: text.length,
                    raw_text: text,
                    spans: spans.map(toSpanDto),
                    token_usage: tokenUsageForSeq(currentSeq),
                    content: findTurnContent(turnContent, currentSeq, text),
                });
            }

            // If this session was spawned, the parent's brief landed in the
            // first non-environment user message. Re-tag it so the dissector
            // view stops claiming it's "user input".
            if (parent.parent_session) applySubagentTaskTagging(turns, totals);

            // Harvest spawn-tool calls + their args from the raw JSONL so we
            // can attach metadata to each spawned child below.
            const provider: "codex" | "claude" = found.harness === "codex" ? "codex" : "claude";
            const spawnCalls: SpawnCall[] = [];
            for (const line of raw.split("\n")) {
                if (!line.trim()) continue;
                if (!line.includes("spawn_agent") && !line.includes("\"Task\"")) continue;
                const entry = decodeJsonRecordOrNull(line) as { timestamp?: string; payload?: { type?: string; name?: string; arguments?: string; call_id?: string }; message?: { content?: Array<{ type?: string; name?: string; input?: unknown; id?: string }> } } | null;
                if (entry === null) continue;
                if (provider === "codex") {
                    const p = entry.payload;
                    if (!p || p.type !== "function_call") continue;
                    const meta = parseSpawnArgs("codex", p.name ?? "", p.arguments);
                    if (!meta) continue;
                    spawnCalls.push({ ts: entry.timestamp ?? null, call_id: p.call_id ?? null, meta });
                } else {
                    const blocks = entry.message?.content;
                    if (!Array.isArray(blocks)) continue;
                    for (const b of blocks) {
                        if (b.type !== "tool_use" || b.name !== "Task") continue;
                        const meta = parseSpawnArgs("claude", b.name, b.input);
                        if (!meta) continue;
                        spawnCalls.push({ ts: entry.timestamp ?? null, call_id: b.id ?? null, meta });
                    }
                }
            }
            // Match each spawn call to the child whose spawn ts is closest.
            // (Children whose spawn fell outside the JSONL - e.g. cron-launched
            // agents - get meta=null.)
            const usedCallIdx = new Set<number>();
            const metaForChild = (childTs: string | null): SpawnMeta | null => {
                if (!childTs) return null;
                const childMs = new Date(childTs).getTime();
                if (!Number.isFinite(childMs)) return null;
                let bestIdx = -1;
                let bestDelta = Infinity;
                for (let i = 0; i < spawnCalls.length; i++) {
                    if (usedCallIdx.has(i)) continue;
                    const callTs = spawnCalls[i]!.ts;
                    if (!callTs) continue;
                    const ms = new Date(callTs).getTime();
                    if (!Number.isFinite(ms)) continue;
                    const delta = Math.abs(childMs - ms);
                    if (delta > 60_000) continue;
                    if (delta < bestDelta) { bestDelta = delta; bestIdx = i; }
                }
                if (bestIdx < 0) return null;
                usedCallIdx.add(bestIdx);
                return spawnCalls[bestIdx]!.meta;
            };

            const children = childrenEdges.map((edge) => ({
                session_id: edge.session_id,
                ts: edge.ts,
                tool: edge.tool,
                nickname: edge.nickname,
                anchor_turn_seq: anchorChildToTurn(turns, edge.ts),
                meta: metaForChild(edge.ts),
            }));

            // Slice turns to the requested window. The full session totals
            // (totals_by_kind, total_chars) are kept unchanged so the legend
            // remains accurate even when only a page of turns ships.
            const turnSlice = turns.slice(turnOffset, turnOffset + turnLimit);

            // Filter hook_fires to the ts range of the loaded turn slice so
            // the SPA can splice them in without pulling all hooks per page.
            // First page (offset=0) also gets any pre-first-turn hooks; last
            // page picks up any post-last-turn orphans.
            const hookFireSlice = hookFiresForTurnWindow(allHookFires, turnSlice, turnOffset, turns.length);

            return {
                session_id: bareSessionId,
                source_path: found.path,
                project: sessionMeta.project,
                cwd: sessionMeta.cwd,
                total_chars: totalChars,
                token_usage: tokenUsage,
                total_turns: turns.length,
                turn_window: { offset: turnOffset, limit: turnLimit },
                turns: turnSlice,
                totals_by_kind: totals,
                parent_session: parent.parent_session,
                parent_nickname: parent.parent_nickname,
                children,
                hook_fires: hookFireSlice,
                total_hook_fires: allHookFires.length,
            };
        })();
        return payload;
    });
