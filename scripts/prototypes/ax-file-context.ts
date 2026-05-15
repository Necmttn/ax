#!/usr/bin/env bun
// PROTOTYPE - throwaway graph-first file context injection.
// Question: when a bug mentions a file/error, can ax retrieve useful prior
// sessions/messages/commits through the file graph and show what the AI sees?

import { writeFile } from "node:fs/promises";
import { Surreal } from "surrealdb";
import { classifyTopics } from "./ax-memory-context-logic.ts";
import { classifyTurnIntent } from "../../src/ingest/intent-kind.ts";
import { errorSignatureRecordKey, symbolRecordKey } from "../../src/ingest/record-keys.ts";
import { normalizeErrorSignature } from "../../src/ingest/turn-references.ts";

const cfg = {
    url: process.env.AX_DB_URL ?? process.env.AGENTCTL_DB_URL ?? "ws://127.0.0.1:8521",
    ns: process.env.AX_DB_NS ?? process.env.AGENTCTL_DB_NS ?? "ax",
    db: process.env.AX_DB_DB ?? process.env.AGENTCTL_DB_DB ?? "main",
    user: process.env.AX_DB_USER ?? process.env.AGENTCTL_DB_USER ?? "root",
    pass: process.env.AX_DB_PASS ?? process.env.AGENTCTL_DB_PASS ?? "root",
};

interface Args {
    readonly q: string;
    readonly files: readonly string[];
    readonly html: string;
    readonly scanTurns: boolean;
    readonly timings: boolean;
    readonly json: boolean;
}

interface FileRow {
    readonly id: string;
    readonly path: string;
    readonly repo?: string | null;
    readonly repository?: string | null;
}

interface EditRow {
    readonly id: string;
    readonly tool?: string | null;
    readonly ts?: string | null;
    readonly turn?: {
        readonly id?: string;
        readonly session?: {
            readonly id?: string;
            readonly source?: string | null;
            readonly cwd?: string | null;
            readonly started_at?: string | null;
        } | null;
        readonly seq?: number | null;
        readonly ts?: string | null;
        readonly intent_kind?: string | null;
        readonly text?: string | null;
        readonly text_excerpt?: string | null;
    } | null;
    readonly file?: FileRow | null;
}

interface TouchRow {
    readonly id: string;
    readonly additions?: number | null;
    readonly deletions?: number | null;
    readonly status?: string | null;
    readonly ts?: string | null;
    readonly file?: FileRow | null;
    readonly commit?: {
        readonly id?: string;
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

interface NeighborFile {
    readonly path: string;
    readonly count: number;
}

interface SessionTurn {
    readonly id: string;
    readonly session: string;
    readonly source?: string | null;
    readonly seq?: number | null;
    readonly ts?: string | null;
    readonly intent_kind?: string | null;
    readonly message_kind?: string | null;
    readonly text?: string | null;
    readonly text_excerpt?: string | null;
}

interface MentionSignals {
    readonly paths: readonly string[];
    readonly symbols: readonly string[];
    readonly errors: readonly string[];
}

interface MentionTurn {
    readonly id: string;
    readonly session: string;
    readonly source?: string | null;
    readonly seq?: number | null;
    readonly ts?: string | null;
    readonly message_kind?: string | null;
    readonly intent_kind?: string | null;
    readonly text?: string | null;
    readonly text_excerpt?: string | null;
    readonly score: number;
    readonly why: readonly string[];
}

interface FileEvidenceRow {
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
        readonly text?: string | null;
        readonly text_excerpt?: string | null;
    } | null;
}

interface RankedFileEvidenceRow extends FileEvidenceRow {
    readonly observations: number;
    readonly score: number;
}

interface ContextPack {
    readonly kind: "ax.file_context_pack";
    readonly task: string;
    readonly generated_at: string;
    readonly html_path: string;
    readonly options: {
        readonly scan_turns: boolean;
    };
    readonly signals: MentionSignals;
    readonly files: readonly FileRow[];
    readonly ai_context: string;
    readonly graph_inspection_query: string;
    readonly evidence: {
        readonly tool_file: readonly FileEvidenceRow[];
        readonly edits: readonly EditRow[];
        readonly touches: readonly TouchRow[];
        readonly produced_session_turns: readonly SessionTurn[];
        readonly mention_turns: readonly MentionTurn[];
        readonly neighbor_files: readonly NeighborFile[];
    };
}

const argValue = (name: string): string | null => {
    const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const index = process.argv.indexOf(name);
    return index >= 0 ? (process.argv[index + 1] ?? null) : null;
};

const argValues = (name: string): string[] => {
    const values: string[] = [];
    for (let i = 0; i < process.argv.length; i += 1) {
        const arg = process.argv[i];
        if (arg === name && process.argv[i + 1]) values.push(process.argv[i + 1]);
        if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
    }
    return values;
};

function parseArgs(): Args {
    const q = argValue("--q") ?? "Working memory not initialized from update_working_memory";
    const files = argValues("--file");
    const html = argValue("--html") ?? "scripts/prototypes/ax-file-context-preview.html";
    const scanTurns = process.argv.includes("--scan-turns");
    const timings = process.argv.includes("--timings");
    const json = process.argv.includes("--json");
    return { q, files, html, scanTurns, timings, json };
}

const sqlString = (value: string): string => JSON.stringify(value);
const textOf = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const escapeHtml = (s: unknown): string =>
    textOf(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}...`);
const GENERIC_BASENAMES = new Set(["index.ts", "index.tsx", "index.js", "README.md", "package.json", "tsconfig.json"]);

async function timed<T>(args: Args, label: string, f: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
        return await f();
    } finally {
        if (args.timings) {
            const ms = Math.round(performance.now() - started);
            console.error(`[timing] ${label}: ${ms}ms`);
        }
    }
}

function rankFileEvidence(row: FileEvidenceRow): number {
    let score = row.kind === "searched_file" ? 12 : 10;
    if (row.command_norm === "rg" || row.command_norm === "grep") score += 3;
    if (row.tool_name === "Read") score += 2;
    if (row.turn?.intent_kind === "correction" || row.turn?.intent_kind === "preference") score += 2;
    return score;
}

function compactFileEvidence(rows: readonly FileEvidenceRow[]): RankedFileEvidenceRow[] {
    const best = new Map<string, RankedFileEvidenceRow>();
    for (const row of rows) {
        const key = [row.kind, row.path ?? row.path_seen ?? "?", row.tool_name ?? "", row.command_norm ?? ""].join("|");
        const score = rankFileEvidence(row);
        const existing = best.get(key);
        if (!existing) {
            best.set(key, { ...row, observations: 1, score });
            continue;
        }
        const next: RankedFileEvidenceRow = {
            ...(score > existing.score ? row : existing),
            observations: existing.observations + 1,
            score: Math.max(existing.score, score),
        };
        best.set(key, next);
    }
    return Array.from(best.values())
        .sort((a, b) => b.score - a.score || b.observations - a.observations || (b.ts ?? "").localeCompare(a.ts ?? ""));
}

function evidenceObservationCount(row: FileEvidenceRow): number {
    return "observations" in row && typeof row.observations === "number" ? row.observations : 1;
}

function renderGraphInspectionQuery(files: readonly FileRow[]): string {
    if (files.length === 0) return "-- No matched file records to inspect.";
    const fileRefs = files.map((file) => file.id).join(", ");
    return [
        `LET $files = [${fileRefs}];`,
        "",
        "SELECT id, path, repo, repository FROM file WHERE id IN $files;",
        "",
        "SELECT",
        "  id, evidence, path_seen, ts, out.{ id, path } AS file,",
        "  in.{ id, name, command_norm, turn, session } AS tool_call",
        "FROM read_file",
        "WHERE out IN $files",
        "ORDER BY ts DESC",
        "LIMIT 40;",
        "",
        "SELECT",
        "  id, evidence, path_seen, ts, out.{ id, path } AS file,",
        "  in.{ id, name, command_norm, turn, session } AS tool_call",
        "FROM searched_file",
        "WHERE out IN $files",
        "ORDER BY ts DESC",
        "LIMIT 40;",
        "",
        "SELECT",
        "  id, source, confidence, ts, out.{ id, path } AS file,",
        "  in.{ id, session, seq, intent_kind, text_excerpt } AS turn",
        "FROM mentioned_file",
        "WHERE out IN $files",
        "ORDER BY ts DESC",
        "LIMIT 40;",
        "",
        "SELECT",
        "  id, additions, deletions, ts, out.{ id, path } AS file,",
        "  in.{ sha, message, author, ts, sessions: <-produced.in.{ id, source, cwd } } AS commit",
        "FROM touched",
        "WHERE out IN $files",
        "ORDER BY ts DESC",
        "LIMIT 40;",
    ].join("\n");
}

function extractPathHints(q: string): string[] {
    const paths = q.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|surql|sql|md|json)/g) ?? [];
    return Array.from(new Set(paths));
}

function extractMentionSignals(q: string, files: readonly string[]): MentionSignals {
    const paths = Array.from(new Set([...extractPathHints(q), ...files]));
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
                ...(q.match(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g) ?? []),
                ...(q.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]{3,}\(/g) ?? []).map((s) => s.slice(0, -1)),
            ].filter((s) => !["Error", "Bug"].includes(s)),
        ),
    ).slice(0, 16);
    const errors = Array.from(new Set([...quoted, ...errorish])).slice(0, 8);
    return { paths, symbols, errors };
}

async function connect(): Promise<Surreal> {
    const db = new Surreal();
    await db.connect(cfg.url);
    await db.signin({ username: cfg.user, password: cfg.pass });
    await db.use({ namespace: cfg.ns, database: cfg.db });
    return db;
}

async function findFiles(db: Surreal, paths: readonly string[]): Promise<FileRow[]> {
    const clean = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
    if (clean.length === 0) return [];
    const exactList = clean.map(sqlString).join(", ");
    const [exactRows] = await db.query<[FileRow[]]>(`
        SELECT <string>id AS id, path, repo, <string>repository AS repository
        FROM file
        WHERE path IN [${exactList}]
        LIMIT 20;
    `);
    if (exactRows.length > 0) return exactRows.slice(0, 8);

    const clauses = clean.flatMap((path) => {
        const base = path.split("/").at(-1) ?? path;
        const pathClauses = [
            `string::ends_with(path, ${sqlString(path)})`,
        ];
        if (path.includes("/") && !GENERIC_BASENAMES.has(base)) {
            pathClauses.push(`string::ends_with(path, ${sqlString(base)})`);
        }
        return pathClauses;
    });
    const [rows] = await db.query<[FileRow[]]>(`
        SELECT <string>id AS id, path, repo, <string>repository AS repository
        FROM file
        WHERE ${clauses.join(" OR ")}
        LIMIT 20;
    `);
    const exact = rows.filter((row) => clean.includes(row.path));
    return (exact.length > 0 ? exact : rows).slice(0, 8);
}

async function loadEdits(db: Surreal, fileIds: readonly string[]): Promise<EditRow[]> {
    if (fileIds.length === 0) return [];
    const [rows] = await db.query<[EditRow[]]>(`
        SELECT
            <string>id AS id,
            tool,
            <string>ts AS ts,
            out.{ id, path, repo, repository } AS file,
            in.{
                id,
                session,
                seq,
                ts,
                intent_kind,
                text_excerpt,
                session: session.{ id, source, cwd, started_at }
            } AS turn
        FROM edited
        WHERE out IN [${fileIds.join(", ")}]
        ORDER BY ts DESC
        LIMIT 40;
    `);
    return rows;
}

async function loadTouches(db: Surreal, fileIds: readonly string[]): Promise<TouchRow[]> {
    if (fileIds.length === 0) return [];
    const [rows] = await db.query<[TouchRow[]]>(`
        SELECT
            <string>id AS id,
            additions,
            deletions,
            status,
            <string>ts AS ts,
            out.{ id, path, repo, repository } AS file,
            in.{
                id,
                sha,
                message,
                author,
                ts,
                sessions: <-produced.in.{ id, source, cwd }
            } AS commit
        FROM touched
        WHERE out IN [${fileIds.join(", ")}]
        ORDER BY ts DESC
        LIMIT 40;
    `);
    return rows;
}

async function loadFileEvidenceTable(
    db: Surreal,
    table: "read_file" | "searched_file",
    fileIds: readonly string[],
): Promise<FileEvidenceRow[]> {
    if (fileIds.length === 0) return [];
    const [rows] = await db.query<[Array<Omit<FileEvidenceRow, "kind">>]>(`
        SELECT
            evidence,
            path_seen,
            excerpt,
            <string>ts AS ts,
            out.path AS path,
            in.name AS tool_name,
            in.command_norm AS command_norm,
            in.turn.{
                id,
                seq,
                intent_kind,
                text_excerpt,
                session: session.{ id, source }
            } AS turn
        FROM ${table}
        WHERE out IN [${fileIds.join(", ")}]
          AND in.session.source != "claude-subagent"
        ORDER BY ts DESC
        LIMIT 30;
    `);
    return rows.map((row) => ({ ...row, kind: table }));
}

async function loadFileEvidence(db: Surreal, fileIds: readonly string[]): Promise<FileEvidenceRow[]> {
    const [reads, searches] = await Promise.all([
        loadFileEvidenceTable(db, "read_file", fileIds),
        loadFileEvidenceTable(db, "searched_file", fileIds),
    ]);
    return compactFileEvidence([...reads, ...searches])
        .slice(0, 12);
}

async function loadNeighborFiles(db: Surreal, touches: readonly TouchRow[], targetPaths: readonly string[]): Promise<NeighborFile[]> {
    const commitIds = Array.from(new Set(touches.map((touch) => touch.commit?.id).filter((id): id is string => !!id))).slice(0, 12);
    if (commitIds.length === 0) return [];
    const [rows] = await db.query<Array<Array<{ path: string }>>>(`
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
}

async function loadProducedSessionTurns(db: Surreal, touches: readonly TouchRow[]): Promise<SessionTurn[]> {
    const sessionIds = Array.from(
        new Set(
            touches.flatMap((touch) =>
                (touch.commit?.sessions ?? []).map((session) => session.id).filter((id): id is string => !!id),
            ),
        ),
    ).slice(0, 8);
    if (sessionIds.length === 0) return [];
    const [rows] = await db.query<[SessionTurn[]]>(`
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
          AND text IS NOT NONE
          AND message_kind = "task"
        ORDER BY ts ASC
        LIMIT 40;
    `);
    return rows
        .map((row) => ({
            ...row,
            intent_kind: row.intent_kind ?? classifyTurnIntent({ role: "user", messageKind: row.message_kind ?? "task", source: row.source ?? null, text: row.text ?? row.text_excerpt ?? null }),
        }))
        .filter((row) => ["organic_task", "correction", "preference"].includes(row.intent_kind ?? ""));
}

async function loadMentionTurns(db: Surreal, signals: MentionSignals, fileRows: readonly FileRow[], enabled: boolean): Promise<MentionTurn[]> {
    if (!enabled) return [];
    const needles = Array.from(
        new Set([
            ...signals.errors,
            ...signals.symbols,
            ...signals.paths,
            ...fileRows.map((file) => file.path),
            ...fileRows.map((file) => file.path.split("/").at(-1) ?? file.path),
        ].filter((needle) => needle.length >= 4)),
    ).slice(0, 32);
    if (needles.length === 0) return [];
    const [rows] = await db.query<[Array<Omit<MentionTurn, "score" | "why">>]>(`
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
        WHERE text_excerpt IS NOT NONE
          AND message_kind = "task"
        ORDER BY ts DESC
        LIMIT 1000;
    `);
    return rows
        .map((row) => {
            const intentKind = row.intent_kind ?? classifyTurnIntent({ role: "user", messageKind: row.message_kind ?? "task", source: row.source ?? null, text: row.text ?? row.text_excerpt ?? null });
            const text = `${row.text_excerpt ?? ""}`.toLowerCase();
            let score = 0;
            const why: string[] = [];
            for (const error of signals.errors) {
                if (text.includes(error.toLowerCase())) {
                    score += 8;
                    why.push(`error: ${error}`);
                }
            }
            for (const symbol of signals.symbols) {
                if (text.includes(symbol.toLowerCase())) {
                    score += 4;
                    why.push(`symbol: ${symbol}`);
                }
            }
            for (const path of signals.paths) {
                const base = path.split("/").at(-1) ?? path;
                if (text.includes(path.toLowerCase())) {
                    score += 6;
                    why.push(`path: ${path}`);
                } else if (base.length >= 4 && text.includes(base.toLowerCase())) {
                    score += 3;
                    why.push(`file: ${base}`);
                }
            }
            if (why.length > 0 && (intentKind === "correction" || intentKind === "preference")) score += 2;
            return { ...row, intent_kind: intentKind, score, why };
        })
        .filter((row) => row.source !== "claude-subagent")
        .filter((row) => ["organic_task", "correction", "preference"].includes(row.intent_kind ?? ""))
        .filter((row) => row.why.length > 0)
        .sort((a, b) => b.score - a.score || (b.ts ?? "").localeCompare(a.ts ?? ""))
        .slice(0, 12);
}

async function loadReferenceMentionTurns(db: Surreal, signals: MentionSignals, fileRows: readonly FileRow[]): Promise<MentionTurn[]> {
    const scored = new Map<string, MentionTurn>();
    const addRows = (rows: Array<Omit<MentionTurn, "score" | "why"> & { readonly score: number; readonly why: string }>) => {
        for (const row of rows) {
            if (row.source === "claude-subagent") continue;
            const intentKind = row.intent_kind ?? classifyTurnIntent({ role: "user", messageKind: "task", source: row.source ?? null, text: row.text ?? row.text_excerpt ?? null });
            if (!["organic_task", "correction", "preference"].includes(intentKind)) continue;
            const existing = scored.get(row.id);
            if (existing) {
                scored.set(row.id, {
                    ...existing,
                    score: existing.score + row.score,
                    why: [...existing.why, row.why],
                });
            } else {
                scored.set(row.id, {
                    id: row.id,
                    session: row.session,
                    source: row.source ?? null,
                    seq: row.seq ?? null,
                    ts: row.ts ?? null,
                    intent_kind: intentKind,
                    text: row.text ?? null,
                    text_excerpt: row.text_excerpt ?? null,
                    score: row.score,
                    why: [row.why],
                });
            }
        }
    };

    const fileIds = fileRows.map((file) => file.id);
    if (fileIds.length > 0) {
        const [rows] = await db.query<[Array<Omit<MentionTurn, "score" | "why"> & { score: number; why: string }>]>(`
            SELECT
                <string>in.id AS id,
                <string>in.session AS session,
                in.session.source AS source,
                in.seq AS seq,
                <string>in.ts AS ts,
                in.intent_kind AS intent_kind,
                in.text_excerpt AS text_excerpt,
                8 AS score,
                string::concat(source, ": ", out.path) AS why
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
        const [rows] = await db.query<[Array<Omit<MentionTurn, "score" | "why"> & { score: number; why: string }>]>(`
            SELECT
                <string>in.id AS id,
                <string>in.session AS session,
                in.session.source AS source,
                in.seq AS seq,
                <string>in.ts AS ts,
                in.intent_kind AS intent_kind,
                in.text_excerpt AS text_excerpt,
                5 AS score,
                string::concat(source, ": ", out.name) AS why
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
        const [rows] = await db.query<[Array<Omit<MentionTurn, "score" | "why"> & { score: number; why: string }>]>(`
            SELECT
                <string>in.id AS id,
                <string>in.session AS session,
                in.session.source AS source,
                in.seq AS seq,
                <string>in.ts AS ts,
                in.intent_kind AS intent_kind,
                in.text_excerpt AS text_excerpt,
                10 AS score,
                string::concat(source, ": ", out.text) AS why
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
}

function rankEdit(edit: EditRow, q: string): number {
    const text = `${edit.turn?.text ?? ""} ${edit.turn?.text_excerpt ?? ""}`.toLowerCase();
    let score = 10;
    if (edit.turn?.intent_kind === "correction" || edit.turn?.intent_kind === "preference") score += 5;
    if (edit.turn?.intent_kind === "organic_task") score += 3;
    for (const token of q.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 3)) {
        if (text.includes(token)) score += 1;
    }
    return score;
}

function renderAiContext(
    args: Args,
    signals: MentionSignals,
    files: readonly FileRow[],
    fileEvidence: readonly FileEvidenceRow[],
    edits: readonly EditRow[],
    touches: readonly TouchRow[],
    sessionTurns: readonly SessionTurn[],
    mentionTurns: readonly MentionTurn[],
    neighbors: readonly NeighborFile[],
): string {
    const rankedEdits = edits
        .filter((edit) => ["organic_task", "correction", "preference"].includes(edit.turn?.intent_kind ?? ""))
        .slice()
        .sort((a: EditRow, b: EditRow) => rankEdit(b, args.q) - rankEdit(a, args.q))
        .slice(0, 5);
    const commits = touches.slice(0, 5);
    const lines = [
        "<ax_file_context>",
        `Current bug/task: ${args.q}`,
        "",
        "Relevant files:",
        ...(files.length === 0 ? ["- No matching file nodes found."] : files.map((file) => `- ${file.path}`)),
    ];

    if (signals.errors.length > 0 || signals.symbols.length > 0) {
        lines.push("", "Extracted bug signals:");
        for (const error of signals.errors) lines.push(`- error: ${error}`);
        for (const symbol of signals.symbols.slice(0, 8)) lines.push(`- symbol: ${symbol}`);
    }

    if (fileEvidence.length > 0) {
        lines.push("", "Observed tool evidence for these files:");
        for (const evidence of fileEvidence.slice(0, 6)) {
            const turn = evidence.turn;
            const tool = [evidence.tool_name, evidence.command_norm].filter(Boolean).join("/") || "?";
            const observationCount = evidenceObservationCount(evidence);
            const observations = observationCount > 1 ? ` (${observationCount} observations)` : "";
            lines.push(`- ${evidence.kind}: ${evidence.path ?? evidence.path_seen ?? "?"} via ${tool}${observations}`);
            lines.push(`  Source: ${turn?.session?.source ?? "?"} ${turn?.session?.id ?? "?"} seq ${turn?.seq ?? "?"}; ${evidence.evidence ?? "observed"}`);
        }
    }

    if (rankedEdits.length > 0) {
        lines.push("", "Prior user context from sessions that edited these files:");
        for (const edit of rankedEdits) {
            const turn = edit.turn;
            lines.push(`- ${clip((turn?.text ?? turn?.text_excerpt ?? "").replace(/\s+/g, " "), 240)}`);
            lines.push(`  Source: ${turn?.session?.source ?? "?"} ${turn?.session?.id ?? "?"} seq ${turn?.seq ?? "?"}; intent=${turn?.intent_kind ?? "?"}`);
        }
    }

    if (sessionTurns.length > 0) {
        lines.push("", "Prior user context from sessions that produced commits touching these files:");
        for (const turn of sessionTurns.slice(0, 6)) {
            lines.push(`- ${clip((turn.text ?? turn.text_excerpt ?? "").replace(/\s+/g, " "), 240)}`);
            lines.push(`  Source: ${turn.session} seq ${turn.seq ?? "?"}; intent=${turn.intent_kind ?? "?"}`);
        }
    }

    if (mentionTurns.length > 0) {
        lines.push("", "Prior user context mentioning the same files/errors/symbols:");
        for (const turn of mentionTurns.slice(0, 6)) {
            lines.push(`- ${clip((turn.text ?? turn.text_excerpt ?? "").replace(/\s+/g, " "), 240)}`);
            lines.push(`  Source: ${turn.session} seq ${turn.seq ?? "?"}; intent=${turn.intent_kind ?? "?"}; ${turn.why.join(", ")}`);
        }
    }

    if (commits.length > 0) {
        lines.push("", "Recent commits touching these files:");
        for (const touch of commits) {
            const commit = touch.commit;
            lines.push(`- ${commit?.sha?.slice(0, 10) ?? "?"}: ${clip(commit?.message ?? "(no message)", 180)}`);
        }
    }

    if (neighbors.length > 0) {
        lines.push("", "Neighbor files often changed with these files:");
        for (const neighbor of neighbors.slice(0, 8)) {
            lines.push(`- ${neighbor.path} (${neighbor.count})`);
        }
    }

    lines.push("</ax_file_context>");
    return lines.join("\n");
}

function buildContextPack(
    args: Args,
    signals: MentionSignals,
    files: readonly FileRow[],
    fileEvidence: readonly FileEvidenceRow[],
    edits: readonly EditRow[],
    touches: readonly TouchRow[],
    sessionTurns: readonly SessionTurn[],
    mentionTurns: readonly MentionTurn[],
    neighbors: readonly NeighborFile[],
): ContextPack {
    return {
        kind: "ax.file_context_pack",
        task: args.q,
        generated_at: new Date().toISOString(),
        html_path: args.html,
        options: {
            scan_turns: args.scanTurns,
        },
        signals,
        files,
        ai_context: renderAiContext(args, signals, files, fileEvidence, edits, touches, sessionTurns, mentionTurns, neighbors),
        graph_inspection_query: renderGraphInspectionQuery(files),
        evidence: {
            tool_file: fileEvidence,
            edits,
            touches,
            produced_session_turns: sessionTurns,
            mention_turns: mentionTurns,
            neighbor_files: neighbors,
        },
    };
}

async function writeHtml(
    args: Args,
    signals: MentionSignals,
    files: readonly FileRow[],
    fileEvidence: readonly FileEvidenceRow[],
    edits: readonly EditRow[],
    touches: readonly TouchRow[],
    sessionTurns: readonly SessionTurn[],
    mentionTurns: readonly MentionTurn[],
    neighbors: readonly NeighborFile[],
) {
    const aiContext = renderAiContext(args, signals, files, fileEvidence, edits, touches, sessionTurns, mentionTurns, neighbors);
    const inspectionQuery = renderGraphInspectionQuery(files);
    const topics = classifyTopics(args.q);
    const fileRows = files.map((file) => `<tr><td>${escapeHtml(file.path)}</td><td>${escapeHtml(file.id)}</td><td>${escapeHtml(file.repo ?? "")}</td></tr>`).join("");
    const editRows = edits
        .slice(0, 16)
        .map((edit) => {
            const turn = edit.turn;
            return `<tr><td>${escapeHtml(edit.file?.path ?? "?")}</td><td>${escapeHtml(turn?.intent_kind ?? "?")}</td><td>${escapeHtml(turn?.session?.id ?? "?")}</td><td>${escapeHtml(clip((turn?.text ?? turn?.text_excerpt ?? "").replace(/\s+/g, " "), 220))}</td></tr>`;
        })
        .join("");
    const touchRows = touches
        .slice(0, 16)
        .map((touch) => `<tr><td>${escapeHtml(touch.file?.path ?? "?")}</td><td>${escapeHtml(touch.commit?.sha?.slice(0, 10) ?? "?")}</td><td>${escapeHtml(clip(touch.commit?.message ?? "", 180))}</td><td>${escapeHtml(String((touch.additions ?? 0) + (touch.deletions ?? 0)))}</td></tr>`)
        .join("");
    const sessionTurnRows = sessionTurns
        .slice(0, 20)
        .map((turn) => `<tr><td>${escapeHtml(turn.intent_kind ?? "?")}</td><td>${escapeHtml(turn.session)}</td><td>${escapeHtml(clip((turn.text ?? turn.text_excerpt ?? "").replace(/\s+/g, " "), 240))}</td></tr>`)
        .join("");
    const mentionTurnRows = mentionTurns
        .slice(0, 20)
        .map((turn) => `<tr><td>${escapeHtml(turn.score)}</td><td>${escapeHtml(turn.intent_kind ?? "?")}</td><td>${escapeHtml(turn.session)}</td><td>${escapeHtml(turn.why.join("; "))}</td><td>${escapeHtml(clip((turn.text ?? turn.text_excerpt ?? "").replace(/\s+/g, " "), 240))}</td></tr>`)
        .join("");
    const fileEvidenceRows = fileEvidence
        .slice(0, 20)
        .map((evidence) => {
            const observations = evidenceObservationCount(evidence);
            return `<tr><td>${escapeHtml(evidence.kind)}</td><td>${escapeHtml(fileEvidence.indexOf(evidence) + 1)}</td><td>${escapeHtml(observations)}</td><td>${escapeHtml(evidence.path ?? evidence.path_seen ?? "?")}</td><td>${escapeHtml([evidence.tool_name, evidence.command_norm].filter(Boolean).join("/") || "?")}</td><td>${escapeHtml(evidence.evidence ?? "")}</td><td>${escapeHtml(evidence.turn?.session?.id ?? "?")}</td><td>${escapeHtml(clip((evidence.excerpt ?? "").replace(/\s+/g, " "), 180))}</td></tr>`;
        })
        .join("");
    const neighborRows = neighbors.map((n) => `<li>${escapeHtml(n.path)} <span class="muted">(${n.count})</span></li>`).join("");
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ax File Context Prototype</title>
  <style>
    body { margin: 0; background: #f5f3ee; color: #171717; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 26px 0 10px; font-size: 18px; }
    .meta { color: #666; margin-bottom: 18px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
    section { background: white; border: 1px solid #d8d3c8; border-radius: 8px; padding: 18px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #111; color: #f7f1e8; border-radius: 6px; padding: 16px; margin: 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; border-bottom: 1px solid #e7e2d8; text-align: left; vertical-align: top; }
    th { color: #666; font-size: 12px; text-transform: uppercase; }
    .muted { color: #6b675f; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } main { padding: 18px; } }
  </style>
</head>
<body>
<main>
  <h1>Ax File Context Prototype</h1>
  <div class="meta">Task: ${escapeHtml(args.q)}<br>Input files: ${escapeHtml(args.files.join(", ") || "(path hints from prompt)") || "(none)"}<br>Fallback transcript scan: ${args.scanTurns ? "on" : "off"}<br>Detected topics: ${escapeHtml(topics.join(", ") || "none")}<br>Extracted symbols: ${escapeHtml(signals.symbols.join(", ") || "none")}<br>Extracted errors: ${escapeHtml(signals.errors.join(", ") || "none")}</div>
  <div class="grid">
    <section><h2>What The AI Sees</h2><pre>${escapeHtml(aiContext)}</pre></section>
    <section><h2>Matched File Nodes</h2><table><thead><tr><th>Path</th><th>ID</th><th>Repo</th></tr></thead><tbody>${fileRows}</tbody></table></section>
  </div>
  <section><h2>Graph Inspection Query</h2><pre>${escapeHtml(inspectionQuery)}</pre></section>
  <section><h2>Observed Tool Evidence</h2><table><thead><tr><th>Kind</th><th>Rank</th><th>Obs</th><th>File</th><th>Tool</th><th>Evidence</th><th>Session</th><th>Excerpt</th></tr></thead><tbody>${fileEvidenceRows}</tbody></table></section>
  <section><h2>Prior Edited Turns</h2><table><thead><tr><th>File</th><th>Intent</th><th>Session</th><th>Message</th></tr></thead><tbody>${editRows}</tbody></table></section>
  <section><h2>Turns From Sessions That Produced Touching Commits</h2><table><thead><tr><th>Intent</th><th>Session</th><th>Message</th></tr></thead><tbody>${sessionTurnRows}</tbody></table></section>
  <section><h2>Turns Mentioning Same Files / Errors / Symbols</h2><table><thead><tr><th>Score</th><th>Intent</th><th>Session</th><th>Why</th><th>Message</th></tr></thead><tbody>${mentionTurnRows}</tbody></table></section>
  <section><h2>Commits Touching Files</h2><table><thead><tr><th>File</th><th>Commit</th><th>Message</th><th>Churn</th></tr></thead><tbody>${touchRows}</tbody></table></section>
  <section><h2>Neighbor Files</h2><ol>${neighborRows}</ol></section>
</main>
</body>
</html>`;
    await writeFile(args.html, html);
}

async function main() {
    const args = parseArgs();
    const db = await connect();
    try {
        const signals = extractMentionSignals(args.q, args.files);
        const files = await timed(args, "findFiles", () => findFiles(db, signals.paths));
        const fileIds = files.map((file) => file.id);
        const fileEvidence = await timed(args, "loadFileEvidence", () => loadFileEvidence(db, fileIds));
        const edits = await timed(args, "loadEdits", () => loadEdits(db, fileIds));
        const touches = await timed(args, "loadTouches", () => loadTouches(db, fileIds));
        const sessionTurns = await timed(args, "loadProducedSessionTurns", () => loadProducedSessionTurns(db, touches));
        const referenceMentionTurns = await timed(args, "loadReferenceMentionTurns", () => loadReferenceMentionTurns(db, signals, files));
        const mentionTurns = referenceMentionTurns.length > 0 ? referenceMentionTurns : await timed(args, "loadMentionTurns", () => loadMentionTurns(db, signals, files, args.scanTurns));
        const neighbors = await timed(args, "loadNeighborFiles", () => loadNeighborFiles(db, touches, files.map((file) => file.path)));
        const pack = buildContextPack(args, signals, files, fileEvidence, edits, touches, sessionTurns, mentionTurns, neighbors);
        await timed(args, "writeHtml", () => writeHtml(args, signals, files, fileEvidence, edits, touches, sessionTurns, mentionTurns, neighbors));
        if (args.json) {
            console.log(JSON.stringify(pack, null, 2));
        } else {
            console.log(`HTML preview: ${args.html}`);
            console.log(pack.ai_context);
            console.log("");
            console.log("Graph inspection query:");
            console.log(pack.graph_inspection_query);
        }
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
