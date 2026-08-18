import { Effect, Schema } from "effect";
import { jsonRecordField } from "@ax/lib/decode";
import { andAll, eqClause, inClause, NO_CLAUSE, sinceClause, type Clause } from "@ax/lib/duckdb/clause";
import { matchBm25Sql } from "@ax/lib/duckdb/fts";
import { cacheRows } from "@ax/lib/duckdb/query";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { TURN_FTS } from "../queries/recall.ts";
import { toBareSessionId } from "@ax/lib/shared/session-id";

// ---------------------------------------------------------------------------
// Lines-of-code metric (analog of Claude Code OTEL `claude_code.lines_of_code.count`).
//
// CC emits this from its own edit pipeline; ax has no live OTEL feed, so we
// derive it after the fact from the `tool_call` rows we already ingest. This is
// an ESTIMATE: we count whole lines in each edit's before/after strings rather
// than running a real line diff, matching CC's added/removed framing closely
// enough for rollups. The durable version stores `lines_added`/`lines_removed`
// on `tool_call` at ingest time so this becomes a pure `sum`.
//
// PORT NOTES (Surreal -> DuckDB):
//  - `session.source` deref became a `JOIN session s ON s.id = tc.session`.
//  - The "query" selector's turn-text OR-of-terms became one `match_bm25` call
//    over the terms joined with a space (see `cost-query.ts` for the same
//    translation, and `queries/recall.ts` for the established pattern).
//  - `name IN [...]` stays an IN list, now bound rather than spliced.
//  - Defensive read policy: a DB failure degrades to an empty summary.
// ---------------------------------------------------------------------------

/** Edit-bearing tools we know how to score. */
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

export interface LocSessionRow {
    readonly session: string;
    readonly source: string;
    readonly edits: number;
    readonly linesAdded: number;
    readonly linesRemoved: number;
}

export interface LocSummary {
    readonly selector: string;
    readonly evidence: string;
    readonly sessions: LocSessionRow[];
    readonly totals: {
        readonly sessions: number;
        readonly edits: number;
        readonly linesAdded: number;
        readonly linesRemoved: number;
        readonly linesChanged: number;
    };
    readonly byTool: ReadonlyArray<{
        readonly tool: string;
        readonly edits: number;
        readonly linesAdded: number;
        readonly linesRemoved: number;
    }>;
}

export type LocSelector =
    | { readonly kind: "session"; readonly sessionId: string }
    | {
          readonly kind: "query";
          readonly terms?: readonly string[];
          readonly limit: number;
          readonly since?: Date | null;
          readonly project?: string | null;
          readonly repositoryKey?: string | null;
      };

/** Whole-line count of a string. Empty string contributes nothing. */
const lineCount = (value: unknown): number =>
    typeof value === "string" && value.length > 0 ? value.split("\n").length : 0;

interface EditDelta {
    readonly added: number;
    readonly removed: number;
}

/**
 * Estimate added/removed lines for one edit tool call from its raw `input_json`.
 * Returns zeros for shapes we can't parse so a bad row never breaks the rollup.
 */
export const editDelta = (name: string, inputJson: string | null): EditDelta => {
    const input = jsonRecordField.decode(inputJson);
    if (input === null) return { added: 0, removed: 0 };

    switch (name) {
        case "Edit":
            return { added: lineCount(input.new_string), removed: lineCount(input.old_string) };
        case "Write":
            // Whole-file write: every line counts as added; prior content is unknown.
            return { added: lineCount(input.content), removed: 0 };
        case "NotebookEdit": {
            const isDelete = input.edit_mode === "delete";
            return {
                added: isDelete ? 0 : lineCount(input.new_source),
                removed: isDelete ? lineCount(input.new_source) : 0,
            };
        }
        case "MultiEdit": {
            const edits = Array.isArray(input.edits) ? input.edits : [];
            return edits.reduce<EditDelta>(
                (acc, raw) => {
                    const e = (raw ?? {}) as Record<string, unknown>;
                    return {
                        added: acc.added + lineCount(e.new_string),
                        removed: acc.removed + lineCount(e.old_string),
                    };
                },
                { added: 0, removed: 0 },
            );
        }
        default:
            return { added: 0, removed: 0 };
    }
};

interface RawEditRow {
    readonly session: string;
    readonly source: string;
    readonly name: string;
    readonly input_json: string | null;
}

const summarize = (
    selector: string,
    evidence: string,
    rows: ReadonlyArray<RawEditRow>,
): LocSummary => {
    const sessions = new Map<string, LocSessionRow>();
    const tools = new Map<string, { tool: string; edits: number; linesAdded: number; linesRemoved: number }>();
    let edits = 0;
    let linesAdded = 0;
    let linesRemoved = 0;

    for (const row of rows) {
        const { added, removed } = editDelta(row.name, row.input_json);
        edits += 1;
        linesAdded += added;
        linesRemoved += removed;

        const s = sessions.get(row.session) ?? {
            session: row.session,
            source: row.source,
            edits: 0,
            linesAdded: 0,
            linesRemoved: 0,
        };
        sessions.set(row.session, {
            ...s,
            edits: s.edits + 1,
            linesAdded: s.linesAdded + added,
            linesRemoved: s.linesRemoved + removed,
        });

        const t = tools.get(row.name) ?? { tool: row.name, edits: 0, linesAdded: 0, linesRemoved: 0 };
        tools.set(row.name, {
            ...t,
            edits: t.edits + 1,
            linesAdded: t.linesAdded + added,
            linesRemoved: t.linesRemoved + removed,
        });
    }

    return {
        selector,
        evidence,
        sessions: [...sessions.values()].sort(
            (a, b) => b.linesAdded + b.linesRemoved - (a.linesAdded + a.linesRemoved),
        ),
        totals: {
            sessions: sessions.size,
            edits,
            linesAdded,
            linesRemoved,
            linesChanged: linesAdded + linesRemoved,
        },
        byTool: [...tools.values()].sort((a, b) => b.linesAdded + b.linesRemoved - (a.linesAdded + a.linesRemoved)),
    };
};

const EditRow = Schema.Struct({
    session: Schema.String,
    source: Schema.NullOr(Schema.String),
    name: Schema.String,
    input_json: Schema.NullOr(Schema.String),
});

const toRawRows = (rows: ReadonlyArray<typeof EditRow.Type>): RawEditRow[] =>
    rows.map((row) => ({
        session: row.session,
        source: row.source ?? "",
        name: row.name,
        input_json: row.input_json,
    }));

const queryTerms = (selector: Extract<LocSelector, { kind: "query" }>): string[] =>
    [...new Set((selector.terms ?? []).map((term) => term.trim()).filter((term) => term.length > 0))];

const fetchEditRows = (where: Clause): Effect.Effect<RawEditRow[], never, CacheRead> =>
    Effect.map(
        cacheRows(
            EditRow,
            {
                sql: `SELECT tc.session AS session, s.source AS source, tc.name AS name, tc.input_json AS input_json
                      FROM tool_call tc JOIN session s ON s.id = tc.session
                      WHERE ${inClause("tc.name", [...EDIT_TOOLS]).sql.replace(/^AND /, "")}
                      ${where.sql}
                      LIMIT 50000`,
                params: [...inClause("tc.name", [...EDIT_TOOLS]).params, ...where.params],
            },
            "loc-query.rows",
        ),
        toRawRows,
    );

export const fetchLocSummary = (
    selector: LocSelector,
): Effect.Effect<LocSummary, never, CacheRead> =>
    Effect.gen(function* () {
        if (selector.kind === "session") {
            const rows = yield* fetchEditRows(andAll([eqClause("tc.session", toBareSessionId(selector.sessionId))]));
            return summarize(
                `session:${selector.sessionId}`,
                "tool_call Edit/Write rows for the session",
                rows,
            );
        }

        const limit = Math.min(Math.max(selector.limit, 1), 200);
        const terms = queryTerms(selector);
        const projectClause: Clause = selector.project
            ? { sql: "AND (s.project = ? OR s.cwd = ?)", params: [selector.project, selector.project] }
            : NO_CLAUSE;
        const where = andAll([
            projectClause,
            eqClause("s.repository", selector.repositoryKey),
            selector.since ? sinceClause("s.started_at", selector.since) : NO_CLAUSE,
        ]);
        const textFilter: Clause =
            terms.length === 0
                ? NO_CLAUSE
                : {
                      sql: `AND tc.session IN (
                          SELECT DISTINCT session_id FROM (
                              SELECT t.session AS session_id, ${matchBm25Sql(TURN_FTS, "t")} AS score
                              FROM turn t
                          ) matches
                          WHERE score IS NOT NULL
                          LIMIT ?
                      )`,
                      params: [terms.join(" "), limit],
                  };
        const rows = yield* fetchEditRows({
            sql: `${where.sql} ${textFilter.sql}`,
            params: [...where.params, ...textFilter.params],
        });
        return summarize(
            `query:${terms.join("|")}`,
            terms.length === 0 ? "edits across selected sessions" : "edits in sessions with matching turn text",
            rows,
        );
    });
