/**
 * Memory-ops query: surface Claude Code memory-file activity.
 *
 * Background: Claude's auto-memory is *model-driven* - the agent saves memories
 * by calling `Write`/`Edit` on files under `~/.claude/projects/<slug>/memory/`
 * (and `~/.claude/.../memory/`). Those calls are already in the graph as
 * `edited` (turn -> file) edges; this query just labels and rolls them up as
 * "memory operations". Nothing new is ingested.
 *
 * Scope note: this covers memory *writes* only. Memory *recall* (the index +
 * relevant memories the harness injects into the system prompt) is assembled at
 * request-build time and never written to the transcript JSONL, so it is not
 * recoverable here - it would need a live capture hook.
 *
 * The `edited` edge already carries the path (`absolute_path_seen`), tool, and
 * ts, so the only deref is `in.session` for session/project attribution - bounded
 * (a few hundred memory edges), not the 87k-row aggregate that hangs production.
 * Filter is tightened to `/.claude/` AND `/memory/` so a repo's own `src/memory/`
 * never counts.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { countField, stringField, stringFieldOr } from "@ax/lib/shared/surreal";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MemoryOp = "create" | "update";
export type MemoryKind = "index" | "note";

export interface MemoryOpEvent {
    readonly ts: string;
    readonly tool: string;          // Write | Edit | NotebookEdit
    readonly op: MemoryOp;          // Write -> create, Edit/NotebookEdit -> update
    readonly slug: string;          // basename without .md ("MEMORY" for the index)
    readonly kind: MemoryKind;      // MEMORY.md -> index, else note
    readonly path: string;
    readonly session_id: string;    // cleaned (no "session:" prefix / backticks)
    readonly project: string | null;
    readonly source: string | null;
}

export interface MemoryFileRollup {
    readonly slug: string;
    readonly kind: MemoryKind;
    readonly writes: number;        // Write ops (new memory)
    readonly edits: number;         // Edit/NotebookEdit ops (updates)
    readonly ops: number;           // writes + edits
    readonly sessions: number;      // distinct sessions that touched it
    readonly first_seen: string;
    readonly last_seen: string;
}

export interface MemoryOpsResult {
    readonly events: MemoryOpEvent[];      // newest first
    readonly files: MemoryFileRollup[];    // by last_seen desc
    readonly totals: {
        readonly ops: number;
        readonly notes: number;            // distinct note slugs (index excluded)
        readonly index_ops: number;        // ops against MEMORY.md
        readonly sessions: number;         // distinct sessions overall
    };
    readonly since_days: number;
}

export interface MemoryOpsInput {
    readonly sinceDays: number;
}

// ---------------------------------------------------------------------------
// SQL - flat select over `edited`, single bounded deref of in.session
// ---------------------------------------------------------------------------

const buildSql = (sinceDays: number): string => `
SELECT
    ts,
    tool,
    absolute_path_seen AS path,
    type::string(in.session) AS session_id,
    in.session.project AS project,
    in.session.source AS source
FROM edited
WHERE absolute_path_seen CONTAINS '/.claude/'
    AND absolute_path_seen CONTAINS '/memory/'
    AND ts >= time::now() - ${sinceDays}d
ORDER BY ts DESC;
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanSessionId = (raw: string): string =>
    raw.replace(/^session:/, "").replace(/^`(.*)`$/, "$1");

const basename = (path: string): string => path.split("/").pop() ?? path;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const fetchMemoryOps = Effect.fn("queries.fetchMemoryOps")(function* (
    input: MemoryOpsInput,
) {
    const db = yield* SurrealClient;
    const [rows] = yield* db.query<[Array<Record<string, unknown>>]>(
        buildSql(input.sinceDays),
    );

    const events: MemoryOpEvent[] = (rows ?? []).map((row) => {
        const path = stringFieldOr(row, "path", "");
        const file = basename(path);
        const tool = stringFieldOr(row, "tool", "");
        return {
            ts: stringFieldOr(row, "ts", ""),
            tool,
            op: tool === "Write" ? "create" : "update",
            slug: file.replace(/\.md$/i, ""),
            kind: file === "MEMORY.md" ? "index" : "note",
            path,
            session_id: cleanSessionId(stringFieldOr(row, "session_id", "")),
            project: stringField(row, "project"),
            source: stringField(row, "source"),
        };
    });

    // Roll up per memory file.
    const bySlug = new Map<string, {
        slug: string;
        kind: MemoryKind;
        writes: number;
        edits: number;
        sessions: Set<string>;
        first: string;
        last: string;
    }>();
    for (const e of events) {
        let agg = bySlug.get(e.slug);
        if (!agg) {
            agg = { slug: e.slug, kind: e.kind, writes: 0, edits: 0, sessions: new Set(), first: e.ts, last: e.ts };
            bySlug.set(e.slug, agg);
        }
        if (e.op === "create") agg.writes += 1;
        else agg.edits += 1;
        if (e.session_id) agg.sessions.add(e.session_id);
        if (e.ts < agg.first) agg.first = e.ts;
        if (e.ts > agg.last) agg.last = e.ts;
    }

    const files: MemoryFileRollup[] = [...bySlug.values()]
        .map((a) => ({
            slug: a.slug,
            kind: a.kind,
            writes: a.writes,
            edits: a.edits,
            ops: a.writes + a.edits,
            sessions: a.sessions.size,
            first_seen: a.first,
            last_seen: a.last,
        }))
        .sort((a, b) => (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0));

    const allSessions = new Set<string>();
    for (const e of events) if (e.session_id) allSessions.add(e.session_id);

    const totals = {
        ops: events.length,
        notes: files.filter((f) => f.kind === "note").length,
        index_ops: events.filter((e) => e.kind === "index").length,
        sessions: allSessions.size,
    };

    // countField guards against any NaN sneaking into the rendered totals.
    return {
        events,
        files,
        totals: {
            ops: countField(totals, "ops"),
            notes: countField(totals, "notes"),
            index_ops: countField(totals, "index_ops"),
            sessions: countField(totals, "sessions"),
        },
        since_days: input.sinceDays,
    } satisfies MemoryOpsResult;
});
