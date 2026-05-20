import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { errorSignatureRecordKey, symbolRecordKey } from "../ingest/record-keys.ts";
import { surrealString } from "../lib/shared/surql.ts";
import { normalizeErrorSignature } from "../ingest/turn-references.ts";
import { classifyTurnIntent } from "../ingest/intent-kind.ts";

interface FileRow {
    readonly id: string;
    readonly path: string;
    readonly repo?: string | null;
    readonly repository?: string | null;
}

interface ToolEvidenceRow {
    readonly kind: "read_file" | "searched_file";
    readonly evidence?: string | null;
    readonly path_seen?: string | null;
    readonly excerpt?: string | null;
    readonly ts?: string | null;
    readonly path?: string | null;
    readonly tool_name?: string | null;
    readonly command_norm?: string | null;
    readonly turn?: {
        readonly id?: string;
        readonly session?: {
            readonly id?: string;
            readonly source?: string | null;
        } | null;
        readonly seq?: number | null;
        readonly intent_kind?: string | null;
        readonly text_excerpt?: string | null;
    } | null;
}

interface TouchRow {
    readonly id: string;
    readonly additions?: number | null;
    readonly deletions?: number | null;
    readonly ts?: string | null;
    readonly file?: FileRow | null;
    readonly commit?: {
        readonly id?: string | null;
        readonly sha?: string | null;
        readonly message?: string | null;
        readonly author?: string | null;
        readonly ts?: string | null;
        readonly sessions?: readonly {
            readonly id?: string;
            readonly source?: string | null;
            readonly cwd?: string | null;
        }[];
    } | null;
}

interface MentionTurn {
    readonly id: string;
    readonly session: string;
    readonly source?: string | null;
    readonly seq?: number | null;
    readonly ts?: string | null;
    readonly intent_kind?: string | null;
    readonly text_excerpt?: string | null;
    readonly score: number;
    readonly why: readonly string[];
}

interface SessionTurn {
    readonly id: string;
    readonly session: string;
    readonly source?: string | null;
    readonly seq?: number | null;
    readonly ts?: string | null;
    readonly message_kind?: string | null;
    readonly intent_kind?: string | null;
    readonly text_excerpt?: string | null;
}

interface NeighborFile {
    readonly path: string;
    readonly count: number;
}

interface PriorFileSession {
    readonly session: string;
    readonly title: string | null;
    readonly project: string | null;
    readonly source: string | null;
    readonly weight: number;
    readonly files_touched: number;
    readonly top_files: readonly string[];
    readonly produced_commits: number;
    readonly delivery_status: string | null;
    readonly review_pain: string | null;
    readonly pr_size: string | null;
    readonly pr_title: string | null;
    readonly merged_to_main: boolean;
    readonly user_turns: number;
    readonly assistant_turns: number;
    readonly corrections: number;
    readonly interruptions: number;
    readonly duration_ms: number | null;
    readonly hands_free_ms: number | null;
    readonly last_seen: string | null;
}

interface PriorFileSessionAccumulator {
    session: string;
    title: string | null;
    project: string | null;
    source: string | null;
    weight: number;
    produced_commits: number;
    delivery_status: string | null;
    review_pain: string | null;
    pr_size: string | null;
    pr_title: string | null;
    merged_to_main: boolean;
    user_turns: number;
    assistant_turns: number;
    corrections: number;
    interruptions: number;
    duration_ms: number | null;
    hands_free_ms: number | null;
    last_seen: string | null;
    fileWeights: Map<string, number>;
}

interface MentionSignals {
    readonly paths: readonly string[];
    readonly symbols: readonly string[];
    readonly errors: readonly string[];
}

export interface FileContextPack {
    readonly kind: "ax.file_context_pack";
    readonly task: string;
    readonly generated_at: string;
    readonly signals: MentionSignals;
    readonly files: readonly FileRow[];
    readonly ai_context: string;
    readonly graph_inspection_query: string;
    readonly evidence: {
        readonly tool_file: readonly ToolEvidenceRow[];
        readonly touches: readonly TouchRow[];
        readonly produced_session_turns: readonly SessionTurn[];
        readonly prior_file_sessions: readonly PriorFileSession[];
        readonly mention_turns: readonly MentionTurn[];
        readonly neighbor_files: readonly NeighborFile[];
    };
}

export interface BuildFileContextInput {
    readonly q: string;
    readonly files: readonly string[];
}

const sqlString = surrealString;
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}...`);
const GENERIC_BASENAMES = new Set(["index.ts", "index.tsx", "index.js", "README.md", "package.json", "tsconfig.json"]);
const STOP_WORDS = new Set(["after", "from", "with", "that", "this", "when", "then", "into", "bug"]);

function queryTokens(q: string): readonly string[] {
    return Array.from(
        new Set(
            q.toLowerCase()
                .split(/[^a-z0-9_]+/)
                .filter((token) => token.length >= 4 && !STOP_WORDS.has(token)),
        ),
    ).slice(0, 24);
}

function extractPathHints(q: string): string[] {
    const paths = q.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|surql|sql|md|json)/g) ?? [];
    return Array.from(new Set(paths));
}

export function extractFileContextSignals(q: string, files: readonly string[]): MentionSignals {
    const paths = Array.from(new Set([...extractPathHints(q), ...files].map((path) => path.trim()).filter(Boolean)));
    const quoted = Array.from(q.matchAll(/"([^"]{4,160})"|'([^']{4,160})'|`([^`]{4,160})`/g))
        .map((m) => m[1] ?? m[2] ?? m[3])
        .filter(Boolean);
    const errorish = Array.from(
        q.matchAll(/\b(?:Error|Exception|TypeError|ReferenceError|SqlError|DbError):?\s+([^.;\n]{6,160})/gi),
    ).map((m) => m[0]);
    const symbols = Array.from(
        new Set(
            [
                ...(q.match(/\b[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g) ?? []),
                ...(q.match(/\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g) ?? []),
                ...(q.match(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g) ?? []),
                ...(q.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]{3,}\(/g) ?? []).map((s) => s.slice(0, -1)),
            ].filter((s) => !["Error", "Bug"].includes(s)),
        ),
    ).slice(0, 16);
    const errors = Array.from(new Set([...quoted, ...errorish])).slice(0, 8);
    return { paths, symbols, errors };
}

function renderInspectionQuery(files: readonly FileRow[]): string {
    if (files.length === 0) return "-- No matched file records to inspect.";
    const fileRefs = files.map((file) => file.id).join(", ");
    return [
        `LET $files = [${fileRefs}];`,
        "SELECT id, path, repo, repository FROM file WHERE id IN $files;",
        "SELECT id, evidence, path_seen, ts, out.{ id, path } AS file, in.{ id, name, command_norm, turn, session } AS tool_call FROM read_file WHERE out IN $files ORDER BY ts DESC LIMIT 40;",
        "SELECT id, evidence, path_seen, ts, out.{ id, path } AS file, in.{ id, name, command_norm, turn, session } AS tool_call FROM searched_file WHERE out IN $files ORDER BY ts DESC LIMIT 40;",
        "SELECT id, source, confidence, ts, out.{ id, path } AS file, in.{ id, session, seq, intent_kind, text_excerpt } AS turn FROM mentioned_file WHERE out IN $files ORDER BY ts DESC LIMIT 40;",
        "SELECT in.session AS session, out.path AS file, count() AS edit_count, time::max(ts) AS last_seen FROM edited WHERE out IN $files GROUP BY session, file ORDER BY edit_count DESC, last_seen DESC LIMIT 40;",
        "SELECT id, additions, deletions, ts, out.{ id, path } AS file, in.{ sha, message, author, ts, sessions: <-produced.in.{ id, source, cwd } } AS commit FROM touched WHERE out IN $files ORDER BY ts DESC LIMIT 40;",
    ].join("\n\n");
}

function renderAiContext(
    input: BuildFileContextInput,
    signals: MentionSignals,
    files: readonly FileRow[],
    toolEvidence: readonly ToolEvidenceRow[],
    touches: readonly TouchRow[],
    producedSessionTurns: readonly SessionTurn[],
    priorFileSessions: readonly PriorFileSession[],
    mentions: readonly MentionTurn[],
    neighbors: readonly NeighborFile[],
): string {
    const tokens = queryTokens(input.q);
    const rankedProducedTurns = rankSessionTurns(producedSessionTurns, tokens);
    const compactTouches = compactTouchesForContext(touches);
    const lines = [
        "<ax_file_context>",
        `Current bug/task: ${input.q}`,
        "",
        "Relevant files:",
        ...(files.length === 0 ? ["- No matching file nodes found."] : files.map((file) => `- ${file.path}`)),
    ];

    if (signals.errors.length > 0 || signals.symbols.length > 0) {
        lines.push("", "Extracted bug signals:");
        for (const error of signals.errors) lines.push(`- error: ${error}`);
        for (const symbol of signals.symbols.slice(0, 8)) lines.push(`- symbol: ${symbol}`);
    }

    if (toolEvidence.length > 0) {
        lines.push("", "Observed tool evidence for these files:");
        for (const evidence of toolEvidence.slice(0, 6)) {
            const tool = [evidence.tool_name, evidence.command_norm].filter(Boolean).join("/") || "?";
            lines.push(`- ${evidence.kind}: ${evidence.path ?? evidence.path_seen ?? "?"} via ${tool}`);
            lines.push(`  Source: ${evidence.turn?.session?.source ?? "?"} ${evidence.turn?.session?.id ?? "?"} seq ${evidence.turn?.seq ?? "?"}; ${evidence.evidence ?? "observed"}`);
        }
    }

    if (mentions.length > 0) {
        lines.push("", "Prior user context mentioning the same files/errors/symbols:");
        for (const turn of mentions.slice(0, 6)) {
            lines.push(`- ${clip((turn.text_excerpt ?? "").replace(/\s+/g, " "), 240)}`);
            lines.push(`  Source: ${turn.session} seq ${turn.seq ?? "?"}; intent=${turn.intent_kind ?? "?"}; ${turn.why.join(", ")}`);
        }
    }

    if (rankedProducedTurns.length > 0) {
        lines.push("", "Prior user context from sessions that produced commits touching these files:");
        for (const turn of rankedProducedTurns.slice(0, 6)) {
            lines.push(`- ${clip((turn.text_excerpt ?? "").replace(/\s+/g, " "), 240)}`);
            lines.push(`  Source: ${turn.session} seq ${turn.seq ?? "?"}; intent=${turn.intent_kind ?? "?"}`);
        }
    }

    if (priorFileSessions.length > 0) {
        lines.push("", "Prior sessions that edited these files:");
        for (const session of priorFileSessions.slice(0, 6)) {
            const parts = [
                `${session.weight} edits`,
                `${session.files_touched} files`,
                `${session.produced_commits} commits`,
                `${session.user_turns}u/${session.assistant_turns}a`,
                session.corrections > 0 ? `${session.corrections} corrections` : null,
                session.interruptions > 0 ? `${session.interruptions} interruptions` : null,
                session.merged_to_main ? "main" : null,
                session.delivery_status,
                session.review_pain ? `${session.review_pain} review` : null,
            ].filter(Boolean);
            lines.push(`- ${clip((session.title ?? session.project ?? session.session).replace(/\s+/g, " "), 240)}`);
            lines.push(`  Source: ${session.session}; ${parts.join(", ")}`);
            if (session.top_files.length > 0) lines.push(`  Files: ${session.top_files.slice(0, 3).join(", ")}`);
        }
    }

    if (compactTouches.length > 0) {
        lines.push("", "Recent commits touching these files:");
        for (const touch of compactTouches.slice(0, 5)) {
            lines.push(`- ${touch.commit?.sha?.slice(0, 10) ?? "?"}: ${clip(touch.commit?.message ?? "(no message)", 180)}`);
        }
    }

    if (neighbors.length > 0) {
        lines.push("", "Neighbor files often changed with these files:");
        for (const neighbor of neighbors.slice(0, 8)) lines.push(`- ${neighbor.path} (${neighbor.count})`);
    }

    lines.push("</ax_file_context>");
    return lines.join("\n");
}

function rankToolEvidence(row: ToolEvidenceRow): number {
    let score = row.kind === "searched_file" ? 12 : 10;
    if (row.command_norm === "rg" || row.command_norm === "grep") score += 3;
    if (row.tool_name === "Read") score += 2;
    if (row.turn?.intent_kind === "correction" || row.turn?.intent_kind === "preference") score += 2;
    return score;
}

function rankSessionTurn(turn: SessionTurn, tokens: readonly string[]): number {
    const text = (turn.text_excerpt ?? "").toLowerCase();
    let score = 0;
    if (turn.intent_kind === "correction" || turn.intent_kind === "preference") score += 4;
    if (turn.intent_kind === "organic_task") score += 2;
    for (const token of tokens) {
        if (text.includes(token)) score += 2;
    }
    if (text.length > 20) score += 1;
    return score;
}

function rankSessionTurns(turns: readonly SessionTurn[], tokens: readonly string[]): readonly SessionTurn[] {
    return turns
        .filter((turn) => !!turn.text_excerpt?.trim())
        .slice()
        .sort((a, b) => rankSessionTurn(b, tokens) - rankSessionTurn(a, tokens) || (b.ts ?? "").localeCompare(a.ts ?? ""));
}

function compactTouchesForContext(touches: readonly TouchRow[]): readonly TouchRow[] {
    const best = new Map<string, TouchRow>();
    for (const touch of touches) {
        const key = touch.commit?.sha ?? touch.commit?.message ?? touch.id;
        if (!best.has(key)) best.set(key, touch);
    }
    return Array.from(best.values());
}

function compactToolEvidence(rows: readonly ToolEvidenceRow[]): ToolEvidenceRow[] {
    const best = new Map<string, ToolEvidenceRow>();
    for (const row of rows) {
        const key = [row.kind, row.path ?? row.path_seen ?? "?", row.tool_name ?? "", row.command_norm ?? ""].join("|");
        const existing = best.get(key);
        if (!existing || rankToolEvidence(row) > rankToolEvidence(existing)) {
            best.set(key, row);
        }
    }
    return Array.from(best.values())
        .sort((a, b) => rankToolEvidence(b) - rankToolEvidence(a) || (b.ts ?? "").localeCompare(a.ts ?? ""));
}

/** Exact-path-only lookup. Hot path for the hook - never falls back to
 *  `string::ends_with` against bare basenames, which can scan large slices of
 *  the file table when a basename (e.g. `route.tsx`) appears in many repos. */
const findFilesExact = (paths: readonly string[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const clean = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
        if (clean.length === 0) return [] as FileRow[];
        const exactList = clean.map(sqlString).join(", ");
        const [rows] = yield* db.query<[FileRow[]]>(`
            SELECT <string>id AS id, path, repo, <string>repository AS repository
            FROM file
            WHERE path IN [${exactList}]
            LIMIT 20;
        `);
        return rows.slice(0, 8);
    });

const findFiles = (signals: MentionSignals) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const clean = Array.from(new Set(signals.paths.map((path) => path.trim()).filter(Boolean)));
        if (clean.length === 0) return [] as FileRow[];
        const exactList = clean.map(sqlString).join(", ");
        const [exactRows] = yield* db.query<[FileRow[]]>(`
            SELECT <string>id AS id, path, repo, <string>repository AS repository
            FROM file
            WHERE path IN [${exactList}]
            LIMIT 20;
        `);
        if (exactRows.length > 0) return exactRows.slice(0, 8);

        const clauses = clean.flatMap((path) => {
            const base = path.split("/").at(-1) ?? path;
            const pathClauses = [`string::ends_with(path, ${sqlString(path)})`];
            if (path.includes("/") && !GENERIC_BASENAMES.has(base)) {
                pathClauses.push(`string::ends_with(path, ${sqlString(base)})`);
            }
            return pathClauses;
        });
        const [rows] = yield* db.query<[FileRow[]]>(`
            SELECT <string>id AS id, path, repo, <string>repository AS repository
            FROM file
            WHERE ${clauses.join(" OR ")}
            LIMIT 20;
        `);
        return rows.slice(0, 8);
    });

const loadToolEvidenceTable = (table: "read_file" | "searched_file", fileIds: readonly string[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (fileIds.length === 0) return [] as ToolEvidenceRow[];
        const [rows] = yield* db.query<[Array<Omit<ToolEvidenceRow, "kind">>]>(`
            SELECT
                evidence,
                path_seen,
                excerpt,
                <string>ts AS ts,
                out.path AS path,
                in.name AS tool_name,
                in.command_norm AS command_norm,
                in.turn.{ id, seq, intent_kind, text_excerpt, session: session.{ id, source } } AS turn
            FROM ${table}
            WHERE out IN [${fileIds.join(", ")}]
              AND in.session.source != "claude-subagent"
            ORDER BY ts DESC
            LIMIT 30;
        `);
        return rows.map((row) => ({ ...row, kind: table })).sort((a, b) => rankToolEvidence(b) - rankToolEvidence(a));
    });

const loadTouches = (fileIds: readonly string[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (fileIds.length === 0) return [] as TouchRow[];
        const [rows] = yield* db.query<[TouchRow[]]>(`
            SELECT
                <string>id AS id,
                additions,
                deletions,
                <string>ts AS ts,
                out.{ id, path, repo, repository } AS file,
                in.{ id, sha, message, author, ts, sessions: <-produced.in.{ id, source, cwd } } AS commit
            FROM touched
            WHERE out IN [${fileIds.join(", ")}]
            ORDER BY ts DESC
            LIMIT 40;
        `);
        return rows;
    });

const loadMentions = (signals: MentionSignals, files: readonly FileRow[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const scored = new Map<string, MentionTurn>();
        const addRows = (rows: Array<Omit<MentionTurn, "score" | "why"> & { readonly score: number; readonly why: string }>) => {
            for (const row of rows) {
                if (row.source === "claude-subagent") continue;
                if (!["organic_task", "correction", "preference"].includes(row.intent_kind ?? "")) continue;
                if (!row.text_excerpt?.trim()) continue;
                const existing = scored.get(row.id);
                const next = existing
                    ? { ...existing, score: existing.score + row.score, why: [...existing.why, row.why] }
                    : { ...row, score: row.score, why: [row.why] };
                scored.set(row.id, next);
            }
        };

        const fileIds = files.map((file) => file.id);
        if (fileIds.length > 0) {
            const [rows] = yield* db.query<[Array<Omit<MentionTurn, "score" | "why"> & { score: number; why: string }>]>(`
                SELECT <string>in.id AS id, <string>in.session AS session, in.session.source AS source, in.seq AS seq,
                       <string>in.ts AS ts, in.intent_kind AS intent_kind, in.text_excerpt AS text_excerpt,
                       8 AS score, string::concat(source, ": ", out.path) AS why
                FROM mentioned_file
                WHERE out IN [${fileIds.join(", ")}]
                  AND in.session.source != "claude-subagent"
                ORDER BY ts DESC
                LIMIT 40;
            `);
            addRows(rows);
        }

        const symbolIds = signals.symbols.map((symbol) => `symbol:\`${symbolRecordKey(symbol)}\``);
        if (symbolIds.length > 0) {
            const [rows] = yield* db.query<[Array<Omit<MentionTurn, "score" | "why"> & { score: number; why: string }>]>(`
                SELECT <string>in.id AS id, <string>in.session AS session, in.session.source AS source, in.seq AS seq,
                       <string>in.ts AS ts, in.intent_kind AS intent_kind, in.text_excerpt AS text_excerpt,
                       5 AS score, string::concat(source, ": ", out.name) AS why
                FROM mentioned_symbol
                WHERE out IN [${symbolIds.join(", ")}]
                  AND in.session.source != "claude-subagent"
                ORDER BY ts DESC
                LIMIT 40;
            `);
            addRows(rows);
        }

        const errorIds = signals.errors.map((error) => `error_signature:\`${errorSignatureRecordKey(normalizeErrorSignature(error))}\``);
        if (errorIds.length > 0) {
            const [rows] = yield* db.query<[Array<Omit<MentionTurn, "score" | "why"> & { score: number; why: string }>]>(`
                SELECT <string>in.id AS id, <string>in.session AS session, in.session.source AS source, in.seq AS seq,
                       <string>in.ts AS ts, in.intent_kind AS intent_kind, in.text_excerpt AS text_excerpt,
                       10 AS score, string::concat(source, ": ", out.text) AS why
                FROM mentioned_error
                WHERE out IN [${errorIds.join(", ")}]
                  AND in.session.source != "claude-subagent"
                ORDER BY ts DESC
                LIMIT 40;
            `);
            addRows(rows);
        }

        return Array.from(scored.values())
            .sort((a, b) => b.score - a.score || (b.ts ?? "").localeCompare(a.ts ?? ""))
            .slice(0, 12);
    });

const loadProducedSessionTurns = (touches: readonly TouchRow[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sessionIds = Array.from(
            new Set(
                touches.flatMap((touch) =>
                    (touch.commit?.sessions ?? [])
                        .map((session) => session.id)
                        .filter((id): id is string => !!id),
                ),
            ),
        ).slice(0, 8);
        if (sessionIds.length === 0) return [] as SessionTurn[];
        const [rows] = yield* db.query<[SessionTurn[]]>(`
            SELECT
                <string>id AS id,
                <string>session AS session,
                session.source AS source,
                seq,
                <string>ts AS ts,
                message_kind,
                intent_kind,
                text_excerpt
            FROM turn
            WHERE session IN [${sessionIds.join(", ")}]
              AND text_excerpt IS NOT NONE
              AND message_kind = "task"
              AND session.source != "claude-subagent"
            ORDER BY ts ASC
            LIMIT 40;
        `);
        return rows
            .map((row) => ({
                ...row,
                intent_kind: row.intent_kind ?? classifyTurnIntent({
                    role: "user",
                    messageKind: row.message_kind ?? "task",
                    source: row.source ?? null,
                    text: row.text_excerpt ?? null,
                }),
            }))
            .filter((row) => ["organic_task", "correction", "preference"].includes(row.intent_kind ?? ""));
    });

interface PriorFileSessionRow {
    readonly session?: string | null;
    readonly title?: string | null;
    readonly project?: string | null;
    readonly source?: string | null;
    readonly file?: string | null;
    readonly weight?: number | null;
    readonly last_seen?: string | null;
    readonly started_at?: string | null;
    readonly ended_at?: string | null;
    readonly user_turns?: number | null;
    readonly assistant_turns?: number | null;
    readonly corrections?: number | null;
    readonly interruptions?: number | null;
    readonly hands_free_ms?: number | null;
    readonly produced_commits?: number | null;
    readonly delivery_status?: string | null;
    readonly review_pain?: string | null;
    readonly pr_size?: string | null;
    readonly pr_title?: string | null;
}

function numeric(value: number | null | undefined): number {
    return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function durationMs(startedAt: string | null | undefined, endedAt: string | null | undefined): number | null {
    if (!startedAt || !endedAt) return null;
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return end - start;
}

/**
 * Hook hot path: two-stage aggregation.
 *
 * `loadPriorFileSessions` builds the full per-session summary via SurrealQL
 * per-row subqueries against `turn`, `produced`, `delivery_outcome`,
 * `session_health`, and `phase_span`. SurrealDB v3 cannot use index lookups
 * inside `$parent.session` references, so each subquery does a partial scan;
 * empirically a single high-signal session costs ~3.5 s.
 *
 * This variant runs the cheap inner aggregation first (one indexed query),
 * then issues five batched `IN [sessions]` queries in parallel and aggregates
 * counts client-side. Same shape, ~27 ms instead of ~3500 ms.
 */
const loadPriorFileSessionsLean = (fileIds: readonly string[], limit: number) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (fileIds.length === 0) return [] as PriorFileSession[];
        const cappedLimit = Math.max(1, Math.min(limit, 50));
        const [aggRows] = yield* db.query<[
            Array<{
                session: string;
                file: string;
                weight: number;
                last_seen: string;
            }>
        ]>(`
            SELECT <string>in.session AS session, <string>out AS file, count() AS weight, time::max(ts) AS last_seen
            FROM edited
            WHERE out IN [${fileIds.join(", ")}]
              AND in.session.source != "claude-subagent"
            GROUP BY session, file
            ORDER BY weight DESC, last_seen DESC
            LIMIT ${cappedLimit};
        `);
        if (aggRows.length === 0) return [] as PriorFileSession[];

        const sessionIds = Array.from(new Set(aggRows.map((r) => r.session)));
        const sidLiteral = sessionIds.join(", ");

        const [sessionsResult, turnsResult, producedResult, deliveryResult, healthResult, titleResult] =
            yield* Effect.all([
                db.query<[Array<{ id: string; project: string | null; source: string | null; started_at: string | null; ended_at: string | null }>]>(
                    `SELECT <string>id AS id, project, source, started_at, ended_at FROM session WHERE id IN [${sidLiteral}];`,
                ),
                db.query<[Array<{ session: string; role: string; intent_kind: string | null }>]>(
                    `SELECT <string>session AS session, role, intent_kind FROM turn WHERE session IN [${sidLiteral}] AND role IN ['user','assistant'];`,
                ),
                db.query<[Array<{ in: string }>]>(
                    `SELECT <string>in AS in FROM produced WHERE in IN [${sidLiteral}];`,
                ),
                db.query<[Array<{ session: string; status: string | null; review_pain: string | null; pr_size: string | null; pr_title: string | null }>]>(
                    `SELECT <string>session AS session, status, review_pain, pr_size, pull_request.title AS pr_title FROM delivery_outcome WHERE session IN [${sidLiteral}];`,
                ),
                db.query<[Array<{ session: string; interruptions: number }>]>(
                    `SELECT <string>session AS session, interruptions FROM session_health WHERE session IN [${sidLiteral}];`,
                ),
                db.query<[Array<{ session: string; text_excerpt: string; seq: number; intent_kind: string | null }>]>(
                    `SELECT <string>session AS session, text_excerpt, seq, intent_kind FROM turn WHERE session IN [${sidLiteral}] AND role = 'user' AND message_kind = 'task' AND intent_kind IN ['organic_task','preference','correction'] AND text_excerpt IS NOT NONE ORDER BY seq ASC;`,
                ),
            ], { concurrency: "unbounded" });

        const [sessionsRows] = sessionsResult;
        const [turnsRows] = turnsResult;
        const [producedRows] = producedResult;
        const [deliveryRows] = deliveryResult;
        const [healthRows] = healthResult;
        const [titleRows] = titleResult;

        const sessionMeta = new Map<string, { project: string | null; source: string | null; started_at: string | null; ended_at: string | null }>();
        for (const row of sessionsRows) sessionMeta.set(row.id, row);

        const turnCounts = new Map<string, { user: number; assistant: number; corrections: number }>();
        for (const row of turnsRows) {
            const counts = turnCounts.get(row.session) ?? { user: 0, assistant: 0, corrections: 0 };
            if (row.role === "user") {
                counts.user += 1;
                if (row.intent_kind === "correction") counts.corrections += 1;
            } else if (row.role === "assistant") {
                counts.assistant += 1;
            }
            turnCounts.set(row.session, counts);
        }

        const producedCounts = new Map<string, number>();
        for (const row of producedRows) producedCounts.set(row.in, (producedCounts.get(row.in) ?? 0) + 1);

        const deliveryBySession = new Map<string, { status: string | null; review_pain: string | null; pr_size: string | null; pr_title: string | null }>();
        for (const row of deliveryRows) {
            if (!deliveryBySession.has(row.session)) deliveryBySession.set(row.session, row);
        }

        const interruptionsBySession = new Map<string, number>();
        for (const row of healthRows) interruptionsBySession.set(row.session, numeric(row.interruptions));

        // Title priority: shipped PR title > correction text > preference text >
        // organic_task. PR titles describe what was DELIVERED; corrections
        // capture the precise user-feedback that drove behaviour change; both
        // are more file-relevant than the session-opening organic_task, which
        // is often a generic kickoff prompt.
        const INTENT_PRIORITY: Record<string, number> = { correction: 3, preference: 2, organic_task: 1 };
        const turnsBySession = new Map<string, Array<{ text_excerpt: string; seq: number; intent_kind: string | null }>>();
        for (const row of titleRows) {
            const list = turnsBySession.get(row.session) ?? [];
            list.push({ text_excerpt: row.text_excerpt, seq: row.seq, intent_kind: row.intent_kind });
            turnsBySession.set(row.session, list);
        }
        const titleBySession = new Map<string, string>();
        for (const [session, turns] of turnsBySession) {
            const ranked = turns.slice().sort((a, b) => {
                const pa = INTENT_PRIORITY[a.intent_kind ?? ""] ?? 0;
                const pb = INTENT_PRIORITY[b.intent_kind ?? ""] ?? 0;
                if (pa !== pb) return pb - pa;
                // Same priority: corrections benefit from being most recent;
                // organic_task benefits from being earliest (session intent).
                if ((a.intent_kind ?? "") === "correction") return b.seq - a.seq;
                return a.seq - b.seq;
            });
            const pick = ranked[0];
            if (pick) titleBySession.set(session, pick.text_excerpt);
        }

        const bySession = new Map<string, PriorFileSessionAccumulator>();
        for (const row of aggRows) {
            const meta = sessionMeta.get(row.session);
            const delivery = deliveryBySession.get(row.session);
            const turns = turnCounts.get(row.session) ?? { user: 0, assistant: 0, corrections: 0 };
            const weight = Math.max(1, numeric(row.weight));
            const existing = bySession.get(row.session);
            const base: PriorFileSessionAccumulator = existing ?? {
                session: row.session,
                // Shipped PR title takes top priority for "what made this session matter to this file".
                title: delivery?.pr_title ?? titleBySession.get(row.session) ?? meta?.project ?? row.session,
                project: meta?.project ?? null,
                source: meta?.source ?? null,
                weight: 0,
                produced_commits: producedCounts.get(row.session) ?? 0,
                delivery_status: delivery?.status ?? null,
                review_pain: delivery?.review_pain ?? null,
                pr_size: delivery?.pr_size ?? null,
                pr_title: delivery?.pr_title ?? null,
                merged_to_main: delivery?.status === "merged_to_main" || delivery?.status === "promoted_without_pr",
                user_turns: turns.user,
                assistant_turns: turns.assistant,
                corrections: turns.corrections,
                interruptions: interruptionsBySession.get(row.session) ?? 0,
                duration_ms: durationMs(meta?.started_at, meta?.ended_at),
                hands_free_ms: null,
                last_seen: row.last_seen ?? null,
                fileWeights: new Map(),
            };
            base.weight += weight;
            if (row.file) base.fileWeights.set(row.file, (base.fileWeights.get(row.file) ?? 0) + weight);
            bySession.set(row.session, base);
        }

        return Array.from(bySession.values())
            .map((session): PriorFileSession => ({
                session: session.session,
                title: session.title,
                project: session.project,
                source: session.source,
                weight: session.weight,
                files_touched: session.fileWeights.size,
                top_files: Array.from(session.fileWeights.entries())
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .slice(0, 4)
                    .map(([path]) => path),
                produced_commits: session.produced_commits,
                delivery_status: session.delivery_status,
                review_pain: session.review_pain,
                pr_size: session.pr_size,
                pr_title: session.pr_title,
                merged_to_main: session.merged_to_main,
                user_turns: session.user_turns,
                assistant_turns: session.assistant_turns,
                corrections: session.corrections,
                interruptions: session.interruptions,
                duration_ms: session.duration_ms,
                hands_free_ms: session.hands_free_ms,
                last_seen: session.last_seen,
            }))
            .sort((a, b) => b.weight - a.weight || (b.last_seen ?? "").localeCompare(a.last_seen ?? ""))
            .slice(0, 8);
    });

const loadPriorFileSessions = (fileIds: readonly string[], limit = 40) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (fileIds.length === 0) return [] as PriorFileSession[];
        const cappedLimit = Math.max(1, Math.min(limit, 200));
        const [rows] = yield* db.query<[PriorFileSessionRow[]]>(`
            SELECT
                <string>session AS session,
                (
                    (SELECT text_excerpt, seq FROM turn
                        WHERE session = $parent.session
                          AND role = "user"
                          AND message_kind = "task"
                          AND intent_kind IN ["organic_task", "preference", "correction"]
                          AND text_excerpt IS NOT NONE
                        ORDER BY seq ASC
                        LIMIT 1
                    )[0].text_excerpt
                    ?? session.project
                    ?? <string>session
                ) AS title,
                session.project AS project,
                session.source AS source,
                session.started_at AS started_at,
                session.ended_at AS ended_at,
                file.path AS file,
                weight,
                last_seen,
                array::len((SELECT id FROM turn WHERE session = $parent.session AND role = "user")) AS user_turns,
                array::len((SELECT id FROM turn WHERE session = $parent.session AND role = "assistant")) AS assistant_turns,
                array::len((SELECT id FROM turn WHERE session = $parent.session AND role = "user" AND intent_kind = "correction")) AS corrections,
                ((SELECT interruptions FROM session_health WHERE session = $parent.session LIMIT 1)[0].interruptions ?? 0) AS interruptions,
                ((SELECT math::sum(duration_ms) AS total, session FROM phase_span WHERE session = $parent.session AND user_turns = 0 GROUP BY session)[0].total ?? NONE) AS hands_free_ms,
                array::len((SELECT id FROM produced WHERE in = $parent.session)) AS produced_commits,
                ((SELECT status FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].status ?? NONE) AS delivery_status,
                ((SELECT review_pain FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].review_pain ?? NONE) AS review_pain,
                ((SELECT pr_size FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].pr_size ?? NONE) AS pr_size,
                ((SELECT pull_request.title AS pr_title FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].pr_title ?? NONE) AS pr_title
            FROM (
                SELECT in.session AS session, out AS file, count() AS weight, time::max(ts) AS last_seen
                FROM edited
                WHERE out IN [${fileIds.join(", ")}]
                  AND in.session.source != "claude-subagent"
                GROUP BY session, file
            )
            ORDER BY weight DESC, last_seen DESC
            LIMIT ${cappedLimit};
        `);

        const bySession = new Map<string, PriorFileSessionAccumulator>();
        for (const row of rows) {
            if (!row.session) continue;
            const existing = bySession.get(row.session);
            const weight = Math.max(1, numeric(row.weight));
            const base: PriorFileSessionAccumulator = existing ?? {
                session: row.session,
                title: row.title ?? row.project ?? row.session,
                project: row.project ?? null,
                source: row.source ?? null,
                weight: 0,
                produced_commits: numeric(row.produced_commits),
                delivery_status: row.delivery_status ?? null,
                review_pain: row.review_pain ?? null,
                pr_size: row.pr_size ?? null,
                pr_title: row.pr_title ?? null,
                merged_to_main: row.delivery_status === "merged_to_main" || row.delivery_status === "promoted_without_pr",
                user_turns: numeric(row.user_turns),
                assistant_turns: numeric(row.assistant_turns),
                corrections: numeric(row.corrections),
                interruptions: numeric(row.interruptions),
                duration_ms: durationMs(row.started_at, row.ended_at),
                hands_free_ms: row.hands_free_ms ?? null,
                last_seen: row.last_seen ?? null,
                fileWeights: new Map(),
            };
            base.weight += weight;
            base.produced_commits = Math.max(base.produced_commits, numeric(row.produced_commits));
            base.user_turns = Math.max(base.user_turns, numeric(row.user_turns));
            base.assistant_turns = Math.max(base.assistant_turns, numeric(row.assistant_turns));
            base.corrections = Math.max(base.corrections, numeric(row.corrections));
            base.interruptions = Math.max(base.interruptions, numeric(row.interruptions));
            if (row.file) base.fileWeights.set(row.file, (base.fileWeights.get(row.file) ?? 0) + weight);
            bySession.set(row.session, base);
        }

        return Array.from(bySession.values())
            .map((session): PriorFileSession => ({
                session: session.session,
                title: session.title,
                project: session.project,
                source: session.source,
                weight: session.weight,
                files_touched: session.fileWeights.size,
                top_files: Array.from(session.fileWeights.entries())
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .slice(0, 4)
                    .map(([path]) => path),
                produced_commits: session.produced_commits,
                delivery_status: session.delivery_status,
                review_pain: session.review_pain,
                pr_size: session.pr_size,
                pr_title: session.pr_title,
                merged_to_main: session.merged_to_main,
                user_turns: session.user_turns,
                assistant_turns: session.assistant_turns,
                corrections: session.corrections,
                interruptions: session.interruptions,
                duration_ms: session.duration_ms,
                hands_free_ms: session.hands_free_ms,
                last_seen: session.last_seen,
            }))
            .sort((a, b) => b.weight - a.weight || (b.last_seen ?? "").localeCompare(a.last_seen ?? ""))
            .slice(0, 8);
    });

const loadNeighborFiles = (touches: readonly TouchRow[], targetPaths: readonly string[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const commitIds = Array.from(new Set(touches.map((touch) => touch.commit?.id).filter((id): id is string => !!id))).slice(0, 12);
        if (commitIds.length === 0) return [] as NeighborFile[];
        const [rows] = yield* db.query<Array<Array<{ path: string }>>>(`
            SELECT out.path AS path
            FROM touched
            WHERE in IN [${commitIds.join(", ")}]
            LIMIT 200;
        `);
        const target = new Set(targetPaths);
        const counts = new Map<string, number>();
        for (const row of rows) {
            if (!row.path || target.has(row.path)) continue;
            counts.set(row.path, (counts.get(row.path) ?? 0) + 1);
        }
        return Array.from(counts.entries())
            .map(([path, count]) => ({ path, count }))
            .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
            .slice(0, 12);
    });

export interface FileMemoryCorrection {
    readonly turn_id: string;
    readonly session_id: string;
    readonly ts: string | null;
    readonly text: string;
    readonly delivery_status: string | null;
    readonly pr_title: string | null;
}

export interface FileMemoryCommit {
    readonly commit_id: string;
    readonly sha: string | null;
    readonly message: string | null;
    readonly ts: string | null;
}

export interface FileMemoryCoTouch {
    readonly path: string;
    readonly co_sessions: number;
    readonly total_sessions: number;
}

export interface FileContextHookEvidence {
    readonly files: readonly FileRow[];
    readonly prior_file_sessions: readonly PriorFileSession[];
    readonly corrections: readonly FileMemoryCorrection[];
    readonly commits: readonly FileMemoryCommit[];
    readonly co_touched: readonly FileMemoryCoTouch[];
}

/** Pull turns where intent_kind=correction AND the user explicitly mentioned
 *  one of the target files (via `mentioned_file` relation). Strictness =
 *  precision: matches only when the user named the file or a symbol it owns,
 *  not "any correction in a session that happened to edit this file." */
const loadFileTargetedCorrections = (fileIds: readonly string[], limit: number) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (fileIds.length === 0) return [] as FileMemoryCorrection[];
        const cap = Math.max(1, Math.min(limit, 20));
        // Defense-in-depth: existing turn rows still carry the old (loose)
        // intent_kind classification. Filter slash-command bodies and long
        // text at query time so the hook doesn't surface non-corrections
        // until a re-derivation pass cleans them up.
        const [rows] = yield* db.query<[
            Array<{
                turn_id: string;
                session_id: string;
                ts: string | null;
                text: string | null;
            }>
        ]>(`
            SELECT
                <string>in.id AS turn_id,
                <string>in.session AS session_id,
                <string>in.ts AS ts,
                in.text_excerpt AS text
            FROM mentioned_file
            WHERE out IN [${fileIds.join(", ")}]
              AND in.role = "user"
              AND in.intent_kind = "correction"
              AND in.session.source != "claude-subagent"
              AND in.text_excerpt IS NOT NONE
              AND string::len(in.text_excerpt) < 500
            ORDER BY ts DESC
            LIMIT ${cap * 2};
        `);
        if (rows.length === 0) return [] as FileMemoryCorrection[];

        // Defense-in-depth filter (TS side): existing rows still carry old
        // loose intent classification. Drop wrapper-instruction-shaped text
        // that slipped through. Once intent-kind.ts is re-derived this becomes
        // a no-op.
        const filtered = rows.filter((r) => {
            const t = (r.text ?? "").trimStart();
            if (t.startsWith("## Your task")) return false;
            if (t.startsWith("# /")) return false;
            if (t.startsWith("<task")) return false;
            return true;
        }).slice(0, cap);
        if (filtered.length === 0) return [] as FileMemoryCorrection[];

        // Batch-fetch delivery_outcome for the unique sessions to surface
        // `merged_to_main` and PR titles next to each correction quote.
        const sessionIds = Array.from(new Set(filtered.map((r) => r.session_id)));
        const sidLiteral = sessionIds.join(", ");
        const [deliveryRows] = yield* db.query<[
            Array<{ session: string; status: string | null; pr_title: string | null }>
        ]>(
            `SELECT <string>session AS session, status, pull_request.title AS pr_title FROM delivery_outcome WHERE session IN [${sidLiteral}];`,
        );
        const deliveryBySession = new Map<string, { status: string | null; pr_title: string | null }>();
        for (const row of deliveryRows) deliveryBySession.set(row.session, row);

        return filtered.map((row): FileMemoryCorrection => {
            const delivery = deliveryBySession.get(row.session_id);
            return {
                turn_id: row.turn_id,
                session_id: row.session_id,
                ts: row.ts,
                text: (row.text ?? "").trim(),
                delivery_status: delivery?.status ?? null,
                pr_title: delivery?.pr_title ?? null,
            };
        });
    });

/** Recent commits whose `touched` relation points to any of these files. */
const loadRecentCommitsForFile = (fileIds: readonly string[], limit: number) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (fileIds.length === 0) return [] as FileMemoryCommit[];
        const cap = Math.max(1, Math.min(limit, 20));
        const [rows] = yield* db.query<[
            Array<{ commit_id: string; sha: string | null; message: string | null; ts: string | null }>
        ]>(`
            SELECT
                <string>in.id AS commit_id,
                in.sha AS sha,
                in.message AS message,
                <string>in.ts AS ts
            FROM touched
            WHERE out IN [${fileIds.join(", ")}]
            ORDER BY ts DESC
            LIMIT ${cap};
        `);
        // De-dupe by commit_id (multiple touched rows can share a commit when
        // we feed in several file-id variants for the same canonical file).
        const seen = new Set<string>();
        const out: FileMemoryCommit[] = [];
        for (const row of rows) {
            if (seen.has(row.commit_id)) continue;
            seen.add(row.commit_id);
            out.push({
                commit_id: row.commit_id,
                sha: row.sha,
                message: row.message?.split("\n")[0]?.trim() ?? null,
                ts: row.ts,
            });
            if (out.length >= cap) break;
        }
        return out;
    });

/** Files that show up alongside the target file across many sessions. Surfaces
 *  hidden coupling that single-commit `git log` can't see. */
const loadCoTouchedFiles = (fileIds: readonly string[], limit: number) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (fileIds.length === 0) return [] as FileMemoryCoTouch[];
        const cap = Math.max(1, Math.min(limit, 20));
        const targetSet = new Set(fileIds);

        // Stage 1: top sessions that edited the target file. `count()` must
        // appear in SELECT to be sortable in ORDER BY under SurrealDB v3.
        const [sessionsRows] = yield* db.query<[Array<{ session: string; n: number }>]>(`
            SELECT <string>in.session AS session, count() AS n
            FROM edited
            WHERE out IN [${fileIds.join(", ")}]
              AND in.session.source != "claude-subagent"
            GROUP BY session
            ORDER BY n DESC
            LIMIT 15;
        `);
        const sessionIds = sessionsRows.map((r) => r.session).filter(Boolean);
        if (sessionIds.length === 0) return [] as FileMemoryCoTouch[];

        // Stage 2: all files those sessions touched. Aggregate per file in JS.
        const [editedRows] = yield* db.query<[
            Array<{ session: string; file: string; path: string | null }>
        ]>(`
            SELECT <string>in.session AS session, <string>out AS file, out.path AS path
            FROM edited
            WHERE in.session IN [${sessionIds.join(", ")}];
        `);

        // Count distinct sessions per co-touched file (not total edits, to
        // weight files that show up across MANY sessions over heavy churn in
        // one session).
        const sessionsByFile = new Map<string, { path: string | null; sessions: Set<string> }>();
        for (const row of editedRows) {
            if (targetSet.has(row.file)) continue;
            const entry = sessionsByFile.get(row.file) ?? { path: row.path, sessions: new Set<string>() };
            entry.sessions.add(row.session);
            if (!entry.path && row.path) entry.path = row.path;
            sessionsByFile.set(row.file, entry);
        }

        // Filter out trivia: co-touch is only a useful signal when there are
        // enough sessions for a pattern to emerge. With 1-2 sessions, every
        // co-edited file looks like a "always touched together" but is really
        // just "happened to be in the same session."
        const MIN_SESSIONS = 3;
        const MIN_CO_RATIO = 0.5;
        if (sessionIds.length < MIN_SESSIONS) return [] as FileMemoryCoTouch[];

        return Array.from(sessionsByFile.entries())
            .map(([, entry]): FileMemoryCoTouch => ({
                path: entry.path ?? "(unknown)",
                co_sessions: entry.sessions.size,
                total_sessions: sessionIds.length,
            }))
            .filter((c) => c.co_sessions / c.total_sessions >= MIN_CO_RATIO)
            .sort((a, b) => b.co_sessions - a.co_sessions || a.path.localeCompare(b.path))
            .slice(0, cap);
    });

/**
 * Lean evidence path for the agent-harness hook. Resolves files exactly, then
 * fetches: aggregate prior-session stats (for inject-or-not decision), file-
 * targeted user corrections (the novel "what user pushed back on" signal),
 * recent commits (concrete shipped intent with SHA), and co-touched files
 * (hidden coupling). All queries run in parallel, file-id-scoped, indexed.
 */
export const buildFileContextHookEvidence = (
    input: BuildFileContextInput,
): Effect.Effect<FileContextHookEvidence, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const signals = extractFileContextSignals(input.q, input.files);
        const files = yield* findFilesExact(signals.paths);
        if (files.length === 0) {
            return {
                files: [] as readonly FileRow[],
                prior_file_sessions: [] as readonly PriorFileSession[],
                corrections: [] as readonly FileMemoryCorrection[],
                commits: [] as readonly FileMemoryCommit[],
                co_touched: [] as readonly FileMemoryCoTouch[],
            };
        }
        const fileIds = files.map((file) => file.id);
        // Each evidence query is isolated: a SQL failure in one (schema drift,
        // bad cast, missing table) must not block the hook output. Degrade to
        // empty and log to stderr; the agent still gets whatever did succeed.
        const guard = <T,>(eff: Effect.Effect<T, DbError, SurrealClient>, label: string, fallback: T) =>
            eff.pipe(Effect.catch((err) =>
                Effect.sync(() => {
                    console.error(`axctl hook ${label} query failed:`, err.message);
                    return fallback;
                }),
            ));
        const [prior_file_sessions, corrections, commits, co_touched] = yield* Effect.all([
            guard(loadPriorFileSessionsLean(fileIds, 5), "prior_file_sessions", [] as readonly PriorFileSession[]),
            guard(loadFileTargetedCorrections(fileIds, 5), "corrections", [] as readonly FileMemoryCorrection[]),
            guard(loadRecentCommitsForFile(fileIds, 5), "commits", [] as readonly FileMemoryCommit[]),
            guard(loadCoTouchedFiles(fileIds, 5), "co_touched", [] as readonly FileMemoryCoTouch[]),
        ], { concurrency: "unbounded" });
        return { files, prior_file_sessions, corrections, commits, co_touched };
    });

export const buildFileContextPack = (input: BuildFileContextInput): Effect.Effect<FileContextPack, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const signals = extractFileContextSignals(input.q, input.files);
        const files = yield* findFiles(signals);
        const fileIds = files.map((file) => file.id);
        const [reads, searches, touches, mentions] = yield* Effect.all([
            loadToolEvidenceTable("read_file", fileIds),
            loadToolEvidenceTable("searched_file", fileIds),
            loadTouches(fileIds),
            loadMentions(signals, files),
        ]);
        const toolEvidence = compactToolEvidence([...reads, ...searches]).slice(0, 12);
        const [producedSessionTurns, priorFileSessions, neighbors] = yield* Effect.all([
            loadProducedSessionTurns(touches),
            loadPriorFileSessions(fileIds),
            loadNeighborFiles(touches, files.map((file) => file.path)),
        ]);
        return {
            kind: "ax.file_context_pack",
            task: input.q,
            generated_at: new Date().toISOString(),
            signals,
            files,
            ai_context: renderAiContext(input, signals, files, toolEvidence, touches, producedSessionTurns, priorFileSessions, mentions, neighbors),
            graph_inspection_query: renderInspectionQuery(files),
            evidence: {
                tool_file: toolEvidence,
                touches,
                produced_session_turns: producedSessionTurns,
                prior_file_sessions: priorFileSessions,
                mention_turns: mentions,
                neighbor_files: neighbors,
            },
        };
    });
