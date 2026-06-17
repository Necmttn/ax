import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { errorSignatureRecordKey, symbolRecordKey } from "../ingest/record-keys.ts";
import { refListSource } from "@ax/lib/shared/record-select";
import { surrealString } from "@ax/lib/shared/surql";
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
export const resolveFiles = (paths: readonly string[], opts: { readonly fuzzyFallback: boolean }) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const clean = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
        if (clean.length === 0) return [] as FileRow[];
        const exactList = clean.map(surrealString).join(", ");
        const [exactRows] = yield* db.query<[FileRow[]]>(`
            SELECT <string>id AS id, path, repo, <string>repository AS repository
            FROM file
            WHERE path IN [${exactList}]
            LIMIT 20;
        `);
        if (!opts.fuzzyFallback) return exactRows.slice(0, 8);
        if (exactRows.length > 0) return exactRows.slice(0, 8);

        const clauses = clean.flatMap((path) => {
            const base = path.split("/").at(-1) ?? path;
            const pathClauses = [`string::ends_with(path, ${surrealString(path)})`];
            if (path.includes("/") && !GENERIC_BASENAMES.has(base)) {
                pathClauses.push(`string::ends_with(path, ${surrealString(base)})`);
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

export const loadToolEvidenceTable = (table: "read_file" | "searched_file", fileIds: readonly string[]) =>
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

export const loadTouches = (fileIds: readonly string[]) =>
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

export const loadMentions = (signals: MentionSignals, files: readonly FileRow[]) =>
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

export const loadProducedSessionTurns = (touches: readonly TouchRow[]) =>
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

/**
 * Prior sessions that edited the target files, with per-session summary stats.
 *
 * Two-stage aggregation: run the cheap inner aggregation first (one indexed
 * query), then issue batched `IN [sessions]` reads in parallel plus per-session
 * INDEXED turn reads, aggregating client-side. `turn WHERE session IN [<sids>]`
 * is a membership scan over the 560k-row turn table (~3s for 50 sessions);
 * `session = <lit>` hits `turn_session_seq` (~1ms), so the turn reads fan out.
 * The other reads stay batched (session/produced/delivery_outcome/
 * session_health are tiny). This is the single loader both adapters share;
 * the old per-row-subquery variant cost ~3.5s per high-signal session and its
 * only extra output (`hands_free_ms`) had no consumer.
 */
const CONTEXT_TURN_FANOUT = 16;

export const loadPriorFileSessions = (fileIds: readonly string[], limit: number) =>
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
            SELECT <string>in.session AS session, out.path AS file, count() AS weight, time::max(ts) AS last_seen
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

        const perSessionTurns = <Row>(sqlFor: (sid: string) => string) =>
            Effect.forEach(
                sessionIds,
                (sid) => db.query<[Row[]]>(sqlFor(sid)).pipe(Effect.map(([rows]) => rows ?? [])),
                { concurrency: CONTEXT_TURN_FANOUT },
            ).pipe(Effect.map((chunks) => chunks.flat()));

        const [sessionsResult, producedResult, deliveryResult, healthResult] =
            yield* Effect.all([
                // Record-list selection for the by-id fetch - `FROM session
                // WHERE id IN [...]` happens to work on `session` today, but
                // the id IN-list form silently matches nothing on other tables
                // (see @ax/lib/shared/record-select); don't rely on it. The
                // non-id field IN-lists below are fine.
                db.query<[Array<{ id: string; project: string | null; source: string | null; started_at: string | null; ended_at: string | null }>]>(
                    `SELECT <string>id AS id, project, source, started_at, ended_at FROM ${refListSource(sessionIds)};`,
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
            ], { concurrency: "unbounded" });

        const turnsRows = yield* perSessionTurns<{ session: string; role: string; intent_kind: string | null }>(
            (sid) => `SELECT <string>session AS session, role, intent_kind FROM turn WHERE session = ${sid} AND role IN ['user','assistant'];`,
        );
        const titleRows = yield* perSessionTurns<{ session: string; text_excerpt: string; seq: number; intent_kind: string | null }>(
            (sid) => `SELECT <string>session AS session, text_excerpt, seq, intent_kind FROM turn WHERE session = ${sid} AND role = 'user' AND message_kind = 'task' AND intent_kind IN ['organic_task','preference','correction'] AND text_excerpt IS NOT NONE ORDER BY seq ASC;`,
        );

        const [sessionsRows] = sessionsResult;
        const [producedRows] = producedResult;
        const [deliveryRows] = deliveryResult;
        const [healthRows] = healthResult;

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

export const loadNeighborFiles = (touches: readonly TouchRow[], targetPaths: readonly string[]) =>
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

/** Pull turns where intent_kind=correction AND the user explicitly mentioned
 *  one of the target files (via `mentioned_file` relation). Strictness =
 *  precision: matches only when the user named the file or a symbol it owns,
 *  not "any correction in a session that happened to edit this file." */
export const loadFileTargetedCorrections = (fileIds: readonly string[], limit: number) =>
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
export const loadRecentCommitsForFile = (fileIds: readonly string[], limit: number) =>
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
export const loadCoTouchedFiles = (fileIds: readonly string[], limit: number) =>
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
