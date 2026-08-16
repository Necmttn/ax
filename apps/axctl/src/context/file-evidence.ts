import { Effect, Schema } from "effect";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { errorSignatureRecordKey, symbolRecordKey } from "../ingest/record-keys.ts";
import { normalizeErrorSignature } from "../ingest/turn-references.ts";
import { classifyTurnIntent } from "../ingest/intent-kind.ts";
import { numeric, durationMs, rankToolEvidence } from "./file-evidence-rank.ts";
import type {
    BuildFileContextInput,
    FileMemoryCommit,
    FileMemoryCorrection,
    FileMemoryCoTouch,
    FileRow,
    MentionSignals,
    MentionTurn,
    NeighborFile,
    PriorFileSession,
    SessionTurn,
    ToolEvidenceRow,
    TouchRow,
} from "./file-evidence-types.ts";

// ============================================================================
// File Evidence - the graph-derived, rendering-free evidence about a File.
//
// A library of retrieval primitives behind small `fileIds -> rows` interfaces
// (CONTEXT.md "File Evidence"). The File Context Pack (CLI) and File Memory
// injection (hook) are the two adapters that compose and render these. This
// module owns NO rendering and NO product composition.
// ============================================================================

// Re-export the row/result types so the two adapters keep importing the File
// Evidence surface from one place while the definitions live in the bottom
// types module.
export type {
    BuildFileContextInput,
    FileMemoryCommit,
    FileMemoryCorrection,
    FileMemoryCoTouch,
    FileRow,
    MentionSignals,
    MentionTurn,
    NeighborFile,
    PriorFileSession,
    SessionTurn,
    ToolEvidenceRow,
    TouchRow,
};

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

const GENERIC_BASENAMES = new Set(["index.ts", "index.tsx", "index.js", "README.md", "package.json", "tsconfig.json"]);

/**
 * Resolve file paths to canonical `file` records.
 *
 * `fuzzyFallback: false` is the hook hot path: exact-path-only, never falling
 * back to `string::ends_with` against bare basenames, which can scan large
 * slices of the file table when a basename (e.g. `route.tsx`) appears in many
 * repos. `fuzzyFallback: true` (the CLI pack) widens to suffix matching only
 * when the exact lookup finds nothing.
 */
const FileRowSchema = Schema.Struct({
    id: Schema.String,
    path: Schema.String,
    repo: Schema.NullOr(Schema.String),
    repository: Schema.NullOr(Schema.String),
});

export const resolveFiles = (paths: readonly string[], opts: { readonly fuzzyFallback: boolean }) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const clean = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
        if (clean.length === 0) return [] as FileRow[];
        const exactRows = yield* read.rows(FileRowSchema, `
            SELECT id, path, repo, repository
            FROM file
            WHERE path IN (${clean.map(() => "?").join(", ")})
            LIMIT 20
        `, clean);
        if (!opts.fuzzyFallback) return exactRows.slice(0, 8) as FileRow[];
        if (exactRows.length > 0) return exactRows.slice(0, 8) as FileRow[];

        const clauses: string[] = [];
        const params: string[] = [];
        for (const path of clean) {
            const base = path.split("/").at(-1) ?? path;
            clauses.push("ends_with(path, ?)");
            params.push(path);
            if (path.includes("/") && !GENERIC_BASENAMES.has(base)) {
                clauses.push("ends_with(path, ?)");
                params.push(base);
            }
        }
        const rows = yield* read.rows(FileRowSchema, `
            SELECT id, path, repo, repository
            FROM file
            WHERE ${clauses.join(" OR ")}
            LIMIT 20
        `, params);
        return rows.slice(0, 8) as FileRow[];
    });

const ToolEvidenceQueryRow = Schema.Struct({
    evidence: Schema.NullOr(Schema.String),
    path_seen: Schema.NullOr(Schema.String),
    excerpt: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
    path: Schema.NullOr(Schema.String),
    tool_name: Schema.NullOr(Schema.String),
    command_norm: Schema.NullOr(Schema.String),
    turn_id: Schema.NullOr(Schema.String),
    turn_seq: Schema.NullOr(NumberFromBigIntColumn),
    turn_intent_kind: Schema.NullOr(Schema.String),
    turn_text_excerpt: Schema.NullOr(Schema.String),
    turn_session_id: Schema.NullOr(Schema.String),
    turn_session_source: Schema.NullOr(Schema.String),
});

/**
 * `read_file`/`searched_file` are `(tool_call) -in-> edge -out-> (file)` edges.
 * The `claude-subagent` filter is against the TOOL CALL's own session (`tc`),
 * matching the original `in.session.source` - not the (possibly different)
 * turn's session.
 */
export const loadToolEvidenceTable = (table: "read_file" | "searched_file", fileIds: readonly string[]) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        if (fileIds.length === 0) return [] as ToolEvidenceRow[];
        const rows = yield* read.rows(ToolEvidenceQueryRow, `
            SELECT
                e.evidence AS evidence,
                e.path_seen AS path_seen,
                e.excerpt AS excerpt,
                e.ts AS ts,
                f.path AS path,
                tc.name AS tool_name,
                tc.command_norm AS command_norm,
                t.id AS turn_id,
                t.seq AS turn_seq,
                t.intent_kind AS turn_intent_kind,
                t.text_excerpt AS turn_text_excerpt,
                tsess.id AS turn_session_id,
                tsess.source AS turn_session_source
            FROM ${table} e
            JOIN file f ON f.id = e.out_id
            JOIN tool_call tc ON tc.id = e.in_id
            JOIN session s ON s.id = tc.session
            LEFT JOIN turn t ON t.id = tc.turn
            LEFT JOIN session tsess ON tsess.id = t.session
            WHERE e.out_id IN (${fileIds.map(() => "?").join(", ")})
              AND s.source <> 'claude-subagent'
            ORDER BY e.ts DESC
            LIMIT 30
        `, fileIds);
        const mapped: ToolEvidenceRow[] = rows.map((row) => ({
            kind: table,
            evidence: row.evidence,
            path_seen: row.path_seen,
            excerpt: row.excerpt,
            ts: row.ts.toISOString(),
            path: row.path,
            tool_name: row.tool_name,
            command_norm: row.command_norm,
            turn: row.turn_id === null ? null : {
                id: row.turn_id,
                seq: row.turn_seq,
                intent_kind: row.turn_intent_kind,
                text_excerpt: row.turn_text_excerpt,
                session: row.turn_session_id === null ? null : {
                    id: row.turn_session_id,
                    source: row.turn_session_source,
                },
            },
        }));
        return mapped.sort((a, b) => rankToolEvidence(b) - rankToolEvidence(a));
    });

const TouchQueryRow = Schema.Struct({
    id: Schema.String,
    additions: Schema.NullOr(NumberFromBigIntColumn),
    deletions: Schema.NullOr(NumberFromBigIntColumn),
    ts: TimestampColumn,
    file_id: Schema.NullOr(Schema.String),
    file_path: Schema.NullOr(Schema.String),
    file_repo: Schema.NullOr(Schema.String),
    file_repository: Schema.NullOr(Schema.String),
    commit_id: Schema.NullOr(Schema.String),
    commit_sha: Schema.NullOr(Schema.String),
    commit_message: Schema.NullOr(Schema.String),
    commit_author: Schema.NullOr(Schema.String),
    commit_ts: Schema.NullOr(TimestampColumn),
});

const ProducedSessionRow = Schema.Struct({
    commit_id: Schema.String,
    session_id: Schema.String,
    source: Schema.NullOr(Schema.String),
    cwd: Schema.NullOr(Schema.String),
});

/**
 * `touched` is a `(commit) -in-> edge -out-> (file)` edge; `commit.sessions`
 * (the sessions that produced the commit) was a reverse graph traversal
 * (`<-produced.in`) in SurrealQL. DuckDB has no record-graph traversal, so
 * this is a second batched query over `produced` (session -in-> commit -out->)
 * for the commit ids the first query returned, grouped back onto each commit
 * in JS - same batching shape as `prevTurnQuery` in label-mining-service.ts.
 */
export const loadTouches = (fileIds: readonly string[]) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        if (fileIds.length === 0) return [] as TouchRow[];
        const rows = yield* read.rows(TouchQueryRow, `
            SELECT
                t.id AS id,
                t.additions AS additions,
                t.deletions AS deletions,
                t.ts AS ts,
                f.id AS file_id,
                f.path AS file_path,
                f.repo AS file_repo,
                f.repository AS file_repository,
                c.id AS commit_id,
                c.sha AS commit_sha,
                c.message AS commit_message,
                c.author AS commit_author,
                c.ts AS commit_ts
            FROM touched t
            JOIN file f ON f.id = t.out_id
            JOIN "commit" c ON c.id = t.in_id
            WHERE t.out_id IN (${fileIds.map(() => "?").join(", ")})
            ORDER BY t.ts DESC
            LIMIT 40
        `, fileIds);

        const commitIds = Array.from(new Set(rows.map((row) => row.commit_id).filter((id): id is string => id !== null)));
        const sessionsByCommit = new Map<string, Array<{ id: string; source: string | null; cwd: string | null }>>();
        if (commitIds.length > 0) {
            const producedRows = yield* read.rows(ProducedSessionRow, `
                SELECT p.out_id AS commit_id, s.id AS session_id, s.source AS source, s.cwd AS cwd
                FROM produced p
                JOIN session s ON s.id = p.in_id
                WHERE p.out_id IN (${commitIds.map(() => "?").join(", ")})
            `, commitIds);
            for (const row of producedRows) {
                const list = sessionsByCommit.get(row.commit_id) ?? [];
                list.push({ id: row.session_id, source: row.source, cwd: row.cwd });
                sessionsByCommit.set(row.commit_id, list);
            }
        }

        return rows.map((row): TouchRow => ({
            id: row.id,
            additions: row.additions,
            deletions: row.deletions,
            ts: row.ts.toISOString(),
            file: row.file_id === null ? null : {
                id: row.file_id,
                path: row.file_path ?? "",
                repo: row.file_repo,
                repository: row.file_repository,
            },
            commit: row.commit_id === null ? null : {
                id: row.commit_id,
                sha: row.commit_sha,
                message: row.commit_message,
                author: row.commit_author,
                ts: row.commit_ts?.toISOString() ?? null,
                sessions: sessionsByCommit.get(row.commit_id) ?? [],
            },
        }));
    });

const MentionQueryRow = Schema.Struct({
    id: Schema.String,
    session: Schema.String,
    source: Schema.NullOr(Schema.String),
    seq: Schema.NullOr(NumberFromBigIntColumn),
    ts: TimestampColumn,
    intent_kind: Schema.NullOr(Schema.String),
    text_excerpt: Schema.NullOr(Schema.String),
    score: NumberFromBigIntColumn,
    why: Schema.String,
});
type MentionQueryRowType = typeof MentionQueryRow.Type;

const mentionRowToTurn = (row: MentionQueryRowType): Omit<MentionTurn, "score" | "why"> & { score: number; why: string } => ({
    id: row.id,
    session: row.session,
    source: row.source,
    seq: row.seq,
    ts: row.ts.toISOString(),
    intent_kind: row.intent_kind,
    text_excerpt: row.text_excerpt,
    score: row.score,
    why: row.why,
});

/**
 * `mentioned_file`/`mentioned_symbol`/`mentioned_error` are `(turn) -in->
 * edge -out-> (target)` edges. `why` was `string::concat(source, ": ", ...)`
 * self-referencing the `source` alias defined earlier in the same SELECT -
 * DuckDB (standard SQL) cannot do that, so the expression is repeated.
 */
export const loadMentions = (signals: MentionSignals, files: readonly FileRow[]) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const scored = new Map<string, MentionTurn>();
        const addRows = (rows: readonly (Omit<MentionTurn, "score" | "why"> & { readonly score: number; readonly why: string })[]) => {
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
            const rows = yield* read.rows(MentionQueryRow, `
                SELECT t.id AS id, t.session AS session, s.source AS source, t.seq AS seq,
                       t.ts AS ts, t.intent_kind AS intent_kind, t.text_excerpt AS text_excerpt,
                       8 AS score, (s.source || ': ' || f.path) AS why
                FROM mentioned_file mf
                JOIN turn t ON t.id = mf.in_id
                JOIN session s ON s.id = t.session
                JOIN file f ON f.id = mf.out_id
                WHERE mf.out_id IN (${fileIds.map(() => "?").join(", ")})
                  AND s.source <> 'claude-subagent'
                ORDER BY t.ts DESC
                LIMIT 40
            `, fileIds);
            addRows(rows.map(mentionRowToTurn));
        }

        const symbolIds = signals.symbols.map((symbol) => `symbol:${symbolRecordKey(symbol)}`);
        if (symbolIds.length > 0) {
            const rows = yield* read.rows(MentionQueryRow, `
                SELECT t.id AS id, t.session AS session, s.source AS source, t.seq AS seq,
                       t.ts AS ts, t.intent_kind AS intent_kind, t.text_excerpt AS text_excerpt,
                       5 AS score, (s.source || ': ' || sym.name) AS why
                FROM mentioned_symbol ms
                JOIN turn t ON t.id = ms.in_id
                JOIN session s ON s.id = t.session
                JOIN symbol sym ON sym.id = ms.out_id
                WHERE ms.out_id IN (${symbolIds.map(() => "?").join(", ")})
                  AND s.source <> 'claude-subagent'
                ORDER BY t.ts DESC
                LIMIT 40
            `, symbolIds);
            addRows(rows.map(mentionRowToTurn));
        }

        const errorIds = signals.errors.map((error) => `error_signature:${errorSignatureRecordKey(normalizeErrorSignature(error))}`);
        if (errorIds.length > 0) {
            const rows = yield* read.rows(MentionQueryRow, `
                SELECT t.id AS id, t.session AS session, s.source AS source, t.seq AS seq,
                       t.ts AS ts, t.intent_kind AS intent_kind, t.text_excerpt AS text_excerpt,
                       10 AS score, (s.source || ': ' || es.text) AS why
                FROM mentioned_error me
                JOIN turn t ON t.id = me.in_id
                JOIN session s ON s.id = t.session
                JOIN error_signature es ON es.id = me.out_id
                WHERE me.out_id IN (${errorIds.map(() => "?").join(", ")})
                  AND s.source <> 'claude-subagent'
                ORDER BY t.ts DESC
                LIMIT 40
            `, errorIds);
            addRows(rows.map(mentionRowToTurn));
        }

        return Array.from(scored.values())
            .sort((a, b) => b.score - a.score || (b.ts ?? "").localeCompare(a.ts ?? ""))
            .slice(0, 12);
    });

const SessionTurnQueryRow = Schema.Struct({
    id: Schema.String,
    session: Schema.String,
    source: Schema.NullOr(Schema.String),
    seq: Schema.NullOr(NumberFromBigIntColumn),
    ts: TimestampColumn,
    message_kind: Schema.NullOr(Schema.String),
    intent_kind: Schema.NullOr(Schema.String),
    text_excerpt: Schema.NullOr(Schema.String),
});

export const loadProducedSessionTurns = (touches: readonly TouchRow[]) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
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
        const rows = yield* read.rows(SessionTurnQueryRow, `
            SELECT
                t.id AS id,
                t.session AS session,
                s.source AS source,
                t.seq AS seq,
                t.ts AS ts,
                t.message_kind AS message_kind,
                t.intent_kind AS intent_kind,
                t.text_excerpt AS text_excerpt
            FROM turn t
            JOIN session s ON s.id = t.session
            WHERE t.session IN (${sessionIds.map(() => "?").join(", ")})
              AND t.text_excerpt IS NOT NULL
              AND t.message_kind = 'task'
              AND s.source <> 'claude-subagent'
            ORDER BY t.ts ASC
            LIMIT 40
        `, sessionIds);
        return rows
            .map((row): SessionTurn => ({
                id: row.id,
                session: row.session,
                source: row.source,
                seq: row.seq,
                ts: row.ts.toISOString(),
                message_kind: row.message_kind,
                intent_kind: row.intent_kind ?? classifyTurnIntent({
                    role: "user",
                    messageKind: row.message_kind ?? "task",
                    source: row.source ?? null,
                    text: row.text_excerpt ?? null,
                }),
                text_excerpt: row.text_excerpt,
            }))
            .filter((row) => ["organic_task", "correction", "preference"].includes(row.intent_kind ?? ""));
    });

/**
 * Prior sessions that edited the target files, with per-session summary stats.
 *
 * Two-stage aggregation: run the cheap inner aggregation first (one indexed
 * query), then issue batched `session IN (...)` reads through CacheRead,
 * aggregating client-side. Ported off the SurrealDB-specific "N per-session
 * queries beat one IN-list scan" tuning (Surreal's `session = <lit>` hit a
 * point index the `IN [...]` form didn't); DuckDB's turn_session_seq index
 * serves an IN-list scan directly, so this is one batched query per shape
 * instead of a fanned-out per-session loop.
 */
export const loadPriorFileSessions = (fileIds: readonly string[], limit: number) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        if (fileIds.length === 0) return [] as PriorFileSession[];
        const cappedLimit = Math.max(1, Math.min(limit, 50));
        const aggRows = yield* read.rows(Schema.Struct({
            session: Schema.String,
            file: Schema.String,
            weight: NumberFromBigIntColumn,
            last_seen: TimestampColumn,
        }), `
            SELECT t.session AS session, f.path AS file, count(*) AS weight, max(e.ts) AS last_seen
            FROM edited e
            JOIN turn t ON t.id = e.in_id
            JOIN session s ON s.id = t.session
            JOIN file f ON f.id = e.out_id
            WHERE e.out_id IN (${fileIds.map(() => "?").join(", ")})
              AND s.source <> 'claude-subagent'
            GROUP BY t.session, f.path
            ORDER BY weight DESC, last_seen DESC
            LIMIT ?
        `, [...fileIds, cappedLimit]);
        if (aggRows.length === 0) return [] as PriorFileSession[];

        const sessionIds = Array.from(new Set(aggRows.map((r) => r.session)));
        const sidPlaceholders = sessionIds.map(() => "?").join(", ");

        const [sessionsRows, producedRows, deliveryRows, healthRows, turnsRows, titleRows] =
            yield* Effect.all([
                read.rows(Schema.Struct({
                    id: Schema.String,
                    project: Schema.NullOr(Schema.String),
                    source: Schema.NullOr(Schema.String),
                    started_at: Schema.NullOr(TimestampColumn),
                    ended_at: Schema.NullOr(TimestampColumn),
                }), `SELECT id, project, source, started_at, ended_at FROM session WHERE id IN (${sidPlaceholders})`, sessionIds),
                read.rows(Schema.Struct({ session_id: Schema.String }),
                    `SELECT in_id AS session_id FROM produced WHERE in_id IN (${sidPlaceholders})`, sessionIds),
                read.rows(Schema.Struct({
                    session: Schema.NullOr(Schema.String),
                    status: Schema.NullOr(Schema.String),
                    review_pain: Schema.NullOr(Schema.String),
                    pr_size: Schema.NullOr(Schema.String),
                    pr_title: Schema.NullOr(Schema.String),
                }), `
                    SELECT d.session AS session, d.status AS status, d.review_pain AS review_pain,
                           d.pr_size AS pr_size, pr.title AS pr_title
                    FROM delivery_outcome d
                    LEFT JOIN pull_request pr ON pr.id = d.pull_request
                    WHERE d.session IN (${sidPlaceholders})
                `, sessionIds),
                read.rows(Schema.Struct({ session: Schema.String, interruptions: NumberFromBigIntColumn }),
                    `SELECT session, interruptions FROM session_health WHERE session IN (${sidPlaceholders})`, sessionIds),
                read.rows(Schema.Struct({ session: Schema.String, role: Schema.String, intent_kind: Schema.NullOr(Schema.String) }),
                    `SELECT session, role, intent_kind FROM turn WHERE session IN (${sidPlaceholders}) AND role IN ('user', 'assistant')`, sessionIds),
                read.rows(Schema.Struct({
                    session: Schema.String,
                    text_excerpt: Schema.String,
                    seq: NumberFromBigIntColumn,
                    intent_kind: Schema.NullOr(Schema.String),
                }), `
                    SELECT session, text_excerpt, seq, intent_kind FROM turn
                    WHERE session IN (${sidPlaceholders}) AND role = 'user' AND message_kind = 'task'
                      AND intent_kind IN ('organic_task', 'preference', 'correction')
                      AND text_excerpt IS NOT NULL
                    ORDER BY seq ASC
                `, sessionIds),
            ], { concurrency: "unbounded" });

        const sessionMeta = new Map<string, { project: string | null; source: string | null; started_at: string | null; ended_at: string | null }>();
        for (const row of sessionsRows) {
            sessionMeta.set(row.id, {
                project: row.project,
                source: row.source,
                started_at: row.started_at?.toISOString() ?? null,
                ended_at: row.ended_at?.toISOString() ?? null,
            });
        }

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
        for (const row of producedRows) producedCounts.set(row.session_id, (producedCounts.get(row.session_id) ?? 0) + 1);

        const deliveryBySession = new Map<string, { status: string | null; review_pain: string | null; pr_size: string | null; pr_title: string | null }>();
        for (const row of deliveryRows) {
            if (row.session && !deliveryBySession.has(row.session)) deliveryBySession.set(row.session, row);
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
                last_seen: row.last_seen.toISOString(),
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

export const loadNeighborFiles = (touches: readonly TouchRow[], targetPaths: readonly string[]) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const commitIds = Array.from(new Set(touches.map((touch) => touch.commit?.id).filter((id): id is string => !!id))).slice(0, 12);
        if (commitIds.length === 0) return [] as NeighborFile[];
        const rows = yield* read.rows(Schema.Struct({ path: Schema.String }), `
            SELECT f.path AS path
            FROM touched t
            JOIN file f ON f.id = t.out_id
            WHERE t.in_id IN (${commitIds.map(() => "?").join(", ")})
            LIMIT 200
        `, commitIds);
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

/** Pull turns where intent_kind=correction AND the user explicitly mentioned
 *  one of the target files (via `mentioned_file` relation). Strictness =
 *  precision: matches only when the user named the file or a symbol it owns,
 *  not "any correction in a session that happened to edit this file." */
export const loadFileTargetedCorrections = (fileIds: readonly string[], limit: number) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        if (fileIds.length === 0) return [] as FileMemoryCorrection[];
        const cap = Math.max(1, Math.min(limit, 20));
        // Defense-in-depth: existing turn rows still carry the old (loose)
        // intent_kind classification. Filter slash-command bodies and long
        // text at query time so the hook doesn't surface non-corrections
        // until a re-derivation pass cleans them up.
        const rows = yield* read.rows(Schema.Struct({
            turn_id: Schema.String,
            session_id: Schema.String,
            ts: Schema.NullOr(TimestampColumn),
            text: Schema.NullOr(Schema.String),
        }), `
            SELECT
                t.id AS turn_id,
                t.session AS session_id,
                t.ts AS ts,
                t.text_excerpt AS text
            FROM mentioned_file mf
            JOIN turn t ON t.id = mf.in_id
            JOIN session s ON s.id = t.session
            WHERE mf.out_id IN (${fileIds.map(() => "?").join(", ")})
              AND t.role = 'user'
              AND t.intent_kind = 'correction'
              AND s.source <> 'claude-subagent'
              AND t.text_excerpt IS NOT NULL
              AND length(t.text_excerpt) < 500
            ORDER BY t.ts DESC
            LIMIT ?
        `, [...fileIds, cap * 2]);
        if (rows.length === 0) return [] as FileMemoryCorrection[];

        // Defense-in-depth filter (TS side): existing rows still carry old
        // loose intent classification. Drop wrapper-instruction-shaped text
        // that slipped through. Once intent-kind.ts is re-derived this becomes
        // a no-op.
        const filtered = rows.map((row) => ({
            turn_id: row.turn_id,
            session_id: row.session_id,
            ts: row.ts?.toISOString() ?? null,
            text: row.text,
        })).filter((r) => {
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
        const deliveryRows = yield* read.rows(Schema.Struct({
            session: Schema.NullOr(Schema.String),
            status: Schema.NullOr(Schema.String),
            pr_title: Schema.NullOr(Schema.String),
        }), `
            SELECT d.session AS session, d.status AS status, pr.title AS pr_title
            FROM delivery_outcome d
            LEFT JOIN pull_request pr ON pr.id = d.pull_request
            WHERE d.session IN (${sessionIds.map(() => "?").join(", ")})
        `, sessionIds);
        const deliveryBySession = new Map<string, { status: string | null; pr_title: string | null }>();
        for (const row of deliveryRows) if (row.session) deliveryBySession.set(row.session, row);

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
export const loadRecentCommitsForFile = (fileIds: readonly string[], limit: number) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        if (fileIds.length === 0) return [] as FileMemoryCommit[];
        const cap = Math.max(1, Math.min(limit, 20));
        const rows = yield* read.rows(Schema.Struct({
            commit_id: Schema.String,
            sha: Schema.NullOr(Schema.String),
            message: Schema.NullOr(Schema.String),
            ts: Schema.NullOr(TimestampColumn),
        }), `
            SELECT
                c.id AS commit_id,
                c.sha AS sha,
                c.message AS message,
                c.ts AS ts
            FROM touched t
            JOIN "commit" c ON c.id = t.in_id
            WHERE t.out_id IN (${fileIds.map(() => "?").join(", ")})
            ORDER BY c.ts DESC
            LIMIT ?
        `, [...fileIds, cap]);
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
                ts: row.ts?.toISOString() ?? null,
            });
            if (out.length >= cap) break;
        }
        return out;
    });

/** Files that show up alongside the target file across many sessions. Surfaces
 *  hidden coupling that single-commit `git log` can't see. */
export const loadCoTouchedFiles = (fileIds: readonly string[], limit: number) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        if (fileIds.length === 0) return [] as FileMemoryCoTouch[];
        const cap = Math.max(1, Math.min(limit, 20));
        const targetSet = new Set(fileIds);

        // Stage 1: top sessions that edited the target file.
        const sessionsRows = yield* read.rows(Schema.Struct({ session: Schema.String, n: NumberFromBigIntColumn }), `
            SELECT t.session AS session, count(*) AS n
            FROM edited e
            JOIN turn t ON t.id = e.in_id
            JOIN session s ON s.id = t.session
            WHERE e.out_id IN (${fileIds.map(() => "?").join(", ")})
              AND s.source <> 'claude-subagent'
            GROUP BY t.session
            ORDER BY n DESC
            LIMIT 15
        `, fileIds);
        const sessionIds = sessionsRows.map((r) => r.session).filter(Boolean);
        if (sessionIds.length === 0) return [] as FileMemoryCoTouch[];

        // Stage 2: all files those sessions touched. Aggregate per file in JS.
        const editedRows = yield* read.rows(Schema.Struct({
            session: Schema.String,
            file: Schema.String,
            path: Schema.NullOr(Schema.String),
        }), `
            SELECT t.session AS session, e.out_id AS file, f.path AS path
            FROM edited e
            JOIN turn t ON t.id = e.in_id
            JOIN file f ON f.id = e.out_id
            WHERE t.session IN (${sessionIds.map(() => "?").join(", ")})
        `, sessionIds);

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
