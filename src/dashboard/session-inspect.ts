/**
 * Build a SessionInspectPayload by reading the JSONL transcript file for the
 * given session id and dissecting each message's text into typed spans.
 *
 * Used by `/api/sessions/:id/inspect` and reused by
 * `scripts/prototypes/ax-session-inspect.ts`.
 */

import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { dissectTurn, type TurnSpan } from "../ingest/turn-dissect.ts";
import { SurrealClient } from "../lib/db.ts";
import { locateTranscript } from "../lib/transcript-locator.ts";
import type {
    HookFireDto,
    InspectContentAtomDto,
    InspectContentBlockDto,
    InspectSpanDto,
    InspectSpanKind,
    InspectTurnContentDto,
    InspectTurnDto,
    SessionInspectPayload,
    SpawnMeta,
} from "../lib/shared/dashboard-types.ts";
import {
    interpolateRid,
    queryMany,
    queryOptional,
} from "../lib/shared/graph-query.ts";
import { clampPagination, type PaginationConfig } from "../lib/shared/pagination.ts";
import { toBareSessionId } from "../lib/shared/session-id.ts";

const INSPECT_TURNS_PAGINATION: PaginationConfig = { defaultLimit: 2000, maxLimit: 2000 };

interface JsonlContentBlock {
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

function blockToText(block: JsonlContentBlock): string {
    if (block.type === "text" && typeof block.text === "string") return block.text;
    if (block.type === "tool_result") {
        const inner = block.content;
        if (typeof inner === "string") return `<local-command-stdout>${inner}</local-command-stdout>`;
        if (Array.isArray(inner)) {
            const joined = (inner as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
            return `<local-command-stdout>${joined}</local-command-stdout>`;
        }
        return "<local-command-stdout></local-command-stdout>";
    }
    if (block.type === "tool_use") {
        const name = block.name ? ` name="${block.name.replace(/"/g, "")}"` : "";
        const input = JSON.stringify(block.input ?? {});
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
    let entry: JsonlMessage;
    try { entry = JSON.parse(line); } catch { return null; }
    if (entry.type !== "user" && entry.type !== "assistant") return null;
    const content = entry.message?.content;
    const text = typeof content === "string"
        ? content
        : Array.isArray(content) ? content.map(blockToText).join("") : "";
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

function parseCodexLine(line: string): CanonicalTurn | null {
    let entry: CodexLine;
    try { entry = JSON.parse(line); } catch { return null; }
    const p = entry.payload;
    if (!p) return null;
    if (p.type === "message") {
        if (p.role !== "user" && p.role !== "assistant" && p.role !== "developer") return null;
        const text = Array.isArray(p.content)
            ? p.content.map((b) => (b.type === "input_text" || b.type === "output_text") ? (b.text ?? "") : "").join("")
            : "";
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
        const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? {});
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

const TURN_CONTENT_DOCUMENTS_SQL = `
    SELECT
        type::string(id) AS document_id,
        parser_id,
        parser_version,
        blockset_hash,
        turn.seq AS turn_seq
    FROM content_document
    WHERE source_kind = "turn" AND session = $sid
    ORDER BY turn_seq;
`;

const TURN_CONTENT_BLOCKS_SQL = `
    SELECT
        type::string(id) AS id,
        type::string(document) AS document_id,
        seq,
        parent_seq,
        kind,
        role,
        heading,
        text,
        text_excerpt,
        start_offset,
        end_offset,
        confidence
    FROM content_block
    WHERE source_kind = "turn"
      AND document IN $documents
    ORDER BY document_id, seq;
`;

const TURN_CONTENT_ATOMS_SQL = `
    SELECT
        type::string(document) AS document_id,
        block.seq AS block_seq,
        kind,
        value,
        normalized,
        confidence,
        raw
    FROM content_atom
    WHERE source_kind = "turn"
      AND document IN $documents
    ORDER BY document_id, block_seq, kind, value;
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

interface TurnContentDocumentRow {
    readonly document_id: string;
    readonly parser_id: string;
    readonly parser_version: string;
    readonly blockset_hash: string | null;
    readonly turn_seq: number | null;
}

interface TurnContentBlockRow {
    readonly document_id: string;
    readonly seq: number;
    readonly parent_seq: number | null;
    readonly kind: string;
    readonly role: string | null;
    readonly heading: string | null;
    readonly text: string | null;
    readonly text_excerpt: string | null;
    readonly start_offset: number | null;
    readonly end_offset: number | null;
    readonly confidence: number;
}

interface TurnContentAtomRow {
    readonly document_id: string;
    readonly block_seq: number;
    readonly kind: string;
    readonly value: string;
    readonly normalized: string | null;
    readonly confidence: number;
    readonly raw: unknown;
}

function contentDocumentRid(value: string): string | null {
    const prefix = "content_document:";
    if (!value.startsWith(prefix)) return null;
    const key = value.slice(prefix.length);
    if (!key) return null;
    if (/^[A-Za-z0-9_:-]+$/.test(key)) return `${prefix}${key}`;
    return `${prefix}\`${key.replace(/`/g, "")}\``;
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

const resolveTurnContent = (sessionId: string): Effect.Effect<Map<number, InspectTurnContentDto>, never, SurrealClient> =>
    Effect.gen(function* () {
        const documentRows = yield* queryMany<TurnContentDocumentRow, TurnContentDocumentRow>(
            interpolateRid(TURN_CONTENT_DOCUMENTS_SQL, toBareSessionId(sessionId)),
            (row) => row,
            "session-inspect resolveTurnContentDocuments",
        );
        if (documentRows.length === 0) return new Map<number, InspectTurnContentDto>();

        const documents = documentRows
            .map((row) => contentDocumentRid(row.document_id))
            .filter((value): value is string => value !== null);
        if (documents.length === 0) return new Map<number, InspectTurnContentDto>();

        const documentMetaById = new Map<string, TurnContentDocumentRow>();
        for (const row of documentRows) documentMetaById.set(row.document_id, row);
        const documentListSql = `[${documents.join(", ")}]`;

        const [blockRows, atomRows] = yield* Effect.all([
            queryMany<TurnContentBlockRow, TurnContentBlockRow>(
                TURN_CONTENT_BLOCKS_SQL.split("$documents").join(documentListSql),
                (row) => row,
                "session-inspect resolveTurnContentBlocks",
            ),
            queryMany<TurnContentAtomRow, TurnContentAtomRow>(
                TURN_CONTENT_ATOMS_SQL.split("$documents").join(documentListSql),
                (row) => row,
                "session-inspect resolveTurnContentAtoms",
            ),
        ], { concurrency: "unbounded" });

        const atomsByDocumentAndBlock = new Map<string, InspectContentAtomDto[]>();
        for (const atom of atomRows) {
            const key = `${atom.document_id}\0${atom.block_seq}`;
            const list = atomsByDocumentAndBlock.get(key) ?? [];
            list.push({
                kind: atom.kind,
                value: atom.value,
                normalized: atom.normalized ?? null,
                confidence: atom.confidence,
                raw: atom.raw ?? null,
            });
            atomsByDocumentAndBlock.set(key, list);
        }

        const byTurn = new Map<number, InspectTurnContentDto>();
        const blocksByTurn = new Map<number, InspectContentBlockDto[]>();
        for (const row of blockRows) {
            const documentMeta = documentMetaById.get(row.document_id);
            if (!documentMeta || documentMeta.turn_seq === null || documentMeta.turn_seq === undefined) continue;
            const atoms = atomsByDocumentAndBlock.get(`${row.document_id}\0${row.seq}`) ?? [];
            const blocks = blocksByTurn.get(documentMeta.turn_seq) ?? [];
            blocks.push({
                seq: row.seq,
                parent_seq: row.parent_seq ?? null,
                kind: row.kind,
                role: row.role ?? null,
                heading: row.heading ?? null,
                text: row.text ?? null,
                text_excerpt: row.text_excerpt ?? null,
                start_offset: row.start_offset ?? null,
                end_offset: row.end_offset ?? null,
                confidence: row.confidence,
                atoms,
            });
            blocksByTurn.set(documentMeta.turn_seq, blocks);
            byTurn.set(documentMeta.turn_seq, {
                document_id: row.document_id,
                parser_id: documentMeta.parser_id,
                parser_version: documentMeta.parser_version,
                blockset_hash: documentMeta.blockset_hash ?? null,
                blocks,
            });
        }
        return byTurn;
    });

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
        try { args = JSON.parse(argsJson) as Record<string, unknown>; } catch { return null; }
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
): Effect.Effect<SessionInspectPayload, Error, SurrealClient> =>
    Effect.gen(function* () {
        // Normalise inbound id at the seam so the rest of the function operates
        // on a bare id (also what we echo back as payload.session_id).
        const bareSessionId = toBareSessionId(sessionId);
        const [parent, childrenEdges, allHookFires, turnContent, found] = yield* Effect.all([
            resolveParent(bareSessionId),
            resolveChildren(bareSessionId),
            resolveHookFires(bareSessionId),
            resolveTurnContent(bareSessionId),
            locateTranscript(bareSessionId),
        ], { concurrency: "unbounded" });
        const { offset: turnOffset, limit: turnLimit } = clampPagination(
            { offset: opts.turnOffset, limit: opts.turnLimit },
            INSPECT_TURNS_PAGINATION,
        );
        const payload = yield* Effect.tryPromise({
        try: async () => {
            const raw = await readFile(found.path, "utf8");
            const parseLine = found.harness === "codex" ? parseCodexLine : parseClaudeLine;

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
                    spans: spans.map(toSpanDto),
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
                let entry: { timestamp?: string; payload?: { type?: string; name?: string; arguments?: string; call_id?: string }; message?: { content?: Array<{ type?: string; name?: string; input?: unknown; id?: string }> } };
                try { entry = JSON.parse(line); } catch { continue; }
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
            const isFirstPage = turnOffset === 0;
            const isLastPage = turnOffset + turnSlice.length >= turns.length;
            const firstTs = turnSlice.find((t) => t.ts)?.ts ?? null;
            const lastTs = [...turnSlice].reverse().find((t) => t.ts)?.ts ?? null;
            const firstMs = firstTs ? new Date(firstTs).getTime() : null;
            const lastMs = lastTs ? new Date(lastTs).getTime() : null;
            const hookFireSlice = allHookFires.filter((h) => {
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

            return {
                session_id: bareSessionId,
                source_path: found.path,
                total_chars: totalChars,
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
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });
        return payload;
    });
