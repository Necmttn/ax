import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { errorSignatureRecordKey, symbolRecordKey } from "../ingest/record-keys.ts";
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
        readonly mention_turns: readonly MentionTurn[];
        readonly neighbor_files: readonly NeighborFile[];
    };
}

export interface BuildFileContextInput {
    readonly q: string;
    readonly files: readonly string[];
}

const sqlString = (value: string): string => JSON.stringify(value);
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
        const [producedSessionTurns, neighbors] = yield* Effect.all([
            loadProducedSessionTurns(touches),
            loadNeighborFiles(touches, files.map((file) => file.path)),
        ]);
        return {
            kind: "ax.file_context_pack",
            task: input.q,
            generated_at: new Date().toISOString(),
            signals,
            files,
            ai_context: renderAiContext(input, signals, files, toolEvidence, touches, producedSessionTurns, mentions, neighbors),
            graph_inspection_query: renderInspectionQuery(files),
            evidence: {
                tool_file: toolEvidence,
                touches,
                produced_session_turns: producedSessionTurns,
                mention_turns: mentions,
                neighbor_files: neighbors,
            },
        };
    });
