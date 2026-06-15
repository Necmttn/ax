import { Effect } from "effect";
import { jsonRecordField } from "@ax/lib/decode";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { surrealDate, surrealString } from "@ax/lib/shared/surql";
import { stringOrNull } from "@ax/lib/shared/surreal";
import { sessionProjectClause } from "../metrics/session-filter.ts";

// ---------------------------------------------------------------------------
// Lines-of-code metric (analog of Claude Code OTEL `claude_code.lines_of_code.count`).
//
// CC emits this from its own edit pipeline; ax has no live OTEL feed, so we
// derive it after the fact from the `tool_call` rows we already ingest. This is
// an ESTIMATE: we count whole lines in each edit's before/after strings rather
// than running a real line diff, matching CC's added/removed framing closely
// enough for rollups. The durable version stores `lines_added`/`lines_removed`
// on `tool_call` at ingest time so this becomes a pure `math::sum`.
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

// stringOrNull imported from @ax/lib/shared/surreal - local definition removed.

const toRecordRef = (table: string, id: string): string => {
    let key = id.trim().replace(new RegExp(`^${table}:`), "");
    if (key.startsWith("⟨") && key.endsWith("⟩")) key = key.slice(1, -1);
    if (key.startsWith("`") && key.endsWith("`")) key = key.slice(1, -1);
    return recordLiteral(table, key);
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

const editToolList = EDIT_TOOLS.map((t) => surrealString(t)).join(", ");

const mapRows = (rows: ReadonlyArray<Record<string, unknown>>): RawEditRow[] =>
    rows.map((row) => ({
        session: String(row.session ?? ""),
        source: String(row.source ?? ""),
        name: String(row.name ?? ""),
        input_json: stringOrNull(row.input_json),
    }));

const querySessionClauses = (selector: Extract<LocSelector, { kind: "query" }>): string[] => {
    const clauses: string[] = [];
    if (selector.since) clauses.push(`session.started_at >= ${surrealDate(selector.since)}`);
    if (selector.project) clauses.push(sessionProjectClause(selector.project, "session."));
    if (selector.repositoryKey) {
        clauses.push(`session.repository = ${recordLiteral("repository", selector.repositoryKey)}`);
    }
    return clauses;
};

const queryTerms = (selector: Extract<LocSelector, { kind: "query" }>): string[] =>
    [...new Set((selector.terms ?? []).map((term) => term.trim()).filter((term) => term.length > 0))];

export const fetchLocSummary = (
    selector: LocSelector,
): Effect.Effect<LocSummary, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        if (selector.kind === "session") {
            const sessionRef = toRecordRef("session", selector.sessionId);
            const result = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(session) AS session, session.source AS source, name, input_json
FROM tool_call
WHERE session = ${sessionRef} AND name IN [${editToolList}];`);
            return summarize(
                `session:${selector.sessionId}`,
                "tool_call Edit/Write rows for the session",
                mapRows(result?.[0] ?? []),
            );
        }

        const limit = Math.min(Math.max(selector.limit, 1), 200);
        const terms = queryTerms(selector);
        const clauses = querySessionClauses(selector);
        const sessionWhere = clauses.length > 0 ? `${clauses.join("\n  AND ")}\n  AND ` : "";
        const sessionFilter =
            terms.length === 0
                ? ""
                : `\n  AND session IN (
    SELECT VALUE session FROM turn
    WHERE ${terms.map((term) => `text_excerpt @0@ ${surrealString(term)}`).join("\n       OR ")}
    GROUP BY session
    LIMIT ${limit}
  )`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(session) AS session, session.source AS source, name, input_json
FROM tool_call
WHERE name IN [${editToolList}]
  AND ${sessionWhere}true${sessionFilter}
LIMIT 50000;`);
        return summarize(
            `query:${terms.join("|")}`,
            terms.length === 0 ? "edits across selected sessions" : "edits in sessions with matching turn text",
            mapRows(result?.[0] ?? []),
        );
    });
