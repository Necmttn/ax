/**
 * insights-enrich.ts - post-query context enrichment for the classifier
 * insight views.
 *
 * classifier-facts / correction-contexts / classifier-outcomes used to fetch
 * their per-row context (previous assistant turn, recent tool failures, later
 * tool calls / command outcomes / user turns) via correlated
 * `WHERE session = $parent.session` subqueries inside the view SQL. SurrealDB
 * v3 cannot use index lookups through `$parent.*`, so each subquery partial-
 * scans the 560k-turn / 150k-tool_call tables: with the default LIMIT 20 that
 * was ~20s (facts/contexts) and ~38s (outcomes) per view.
 *
 * The view SQL now returns just the classifier rows (indexed, fast) and this
 * module resolves the same context per row with LITERAL session ids - each an
 * indexed ~1ms lookup (turn_session_seq / tool_call_session_ts) - fanned out
 * at bounded concurrency. Field names and shapes match what the old SQL
 * emitted, so `formatInsightRows` is unchanged.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordIdString } from "@ax/lib/shared/row-fields";
import { surrealDate } from "@ax/lib/shared/surql";
import type { InsightView } from "./insights.ts";

/** Per-row fan-out width for the context lookups. */
const ENRICH_FANOUT = 8;

type Row = Record<string, unknown>;

const ENRICHED_VIEWS = new Set<InsightView>([
    "classifier-facts",
    "correction-contexts",
    "classifier-outcomes",
]);

/** `session:⟨uuid⟩`-style literal from a row's raw `session` field (RecordId
 *  object or string). Null when absent/malformed - the row passes through
 *  unenriched rather than failing the whole view. */
const sessionLiteral = (row: Row): string | null => {
    const raw = recordIdString(row.session);
    if (!raw || !raw.startsWith("session:")) return null;
    let key = raw.slice("session:".length);
    if (key.startsWith("⟨") && key.endsWith("⟩")) key = key.slice(1, -1);
    else if (key.startsWith("`") && key.endsWith("`")) key = key.slice(1, -1);
    if (!key) return null;
    return `session:\`${key.replace(/`/g, "")}\``;
};

const tsLiteral = (row: Row): string | null => {
    const ts = row.ts;
    if (ts instanceof Date) return surrealDate(ts);
    if (typeof ts === "string" && ts.length > 0) return surrealDate(ts);
    return null;
};

const seqOf = (row: Row): number | null =>
    typeof row.user_seq === "number" && Number.isFinite(row.user_seq) ? row.user_seq : null;

const one = <T>(rows: readonly T[] | undefined): T | null => rows?.[0] ?? null;

const enrichRow = (
    view: InsightView,
    row: Row,
): Effect.Effect<Row, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sid = sessionLiteral(row);
        if (sid === null) return row;
        const seq = seqOf(row);
        const ts = tsLiteral(row);

        if (view === "classifier-facts" || view === "correction-contexts") {
            const failureLimit = view === "classifier-facts" ? 3 : 5;
            const [prevResult, failResult] = yield* Effect.all([
                seq === null
                    ? Effect.succeed([[]] as [Row[]])
                    : db.query<[Row[]]>(
                        `SELECT id, seq, text_excerpt AS text FROM turn WHERE session = ${sid} AND role = "assistant" AND seq < ${seq} ORDER BY seq DESC LIMIT 1;`,
                    ),
                ts === null
                    ? Effect.succeed([[]] as [Row[]])
                    : db.query<[Row[]]>(
                        `SELECT id, name, command_norm, error_text, output_excerpt, ts FROM tool_call WHERE session = ${sid} AND has_error = true AND ts <= ${ts} ORDER BY ts DESC LIMIT ${failureLimit};`,
                    ),
            ], { concurrency: 2 });
            return {
                ...row,
                previous_assistant: one(prevResult?.[0]),
                recent_tool_failures: failResult?.[0] ?? [],
            };
        }

        // classifier-outcomes: what happened AFTER the classified turn.
        const [toolResult, outcomeResult, userResult] = yield* Effect.all([
            ts === null
                ? Effect.succeed([[]] as [Row[]])
                : db.query<[Row[]]>(
                    `SELECT id, name, command_norm, has_error, status, exit_code, output_excerpt, error_text, ts FROM tool_call WHERE session = ${sid} AND ts > ${ts} ORDER BY ts ASC LIMIT 5;`,
                ),
            ts === null
                ? Effect.succeed([[]] as [Row[]])
                : db.query<[Row[]]>(
                    `SELECT id, kind, status, command_norm, command_tool, text, tool_call, ts FROM command_outcome WHERE session = ${sid} AND ts > ${ts} ORDER BY ts ASC LIMIT 5;`,
                ),
            seq === null
                ? Effect.succeed([[]] as [Row[]])
                : db.query<[Row[]]>(
                    `SELECT id, seq, role, text_excerpt AS text, ts FROM turn WHERE session = ${sid} AND role = "user" AND seq > ${seq} ORDER BY seq ASC LIMIT 3;`,
                ),
        ], { concurrency: 3 });
        return {
            ...row,
            later_tool_calls: toolResult?.[0] ?? [],
            later_command_outcomes: outcomeResult?.[0] ?? [],
            later_user_turns: userResult?.[0] ?? [],
        };
    });

/** Enrich the rows of a classifier insight view with per-row context via
 *  indexed lookups. Views outside ENRICHED_VIEWS pass through untouched. */
export const enrichInsightRows = (
    view: InsightView,
    rows: ReadonlyArray<Row>,
): Effect.Effect<ReadonlyArray<Row>, DbError, SurrealClient> =>
    ENRICHED_VIEWS.has(view)
        ? Effect.forEach(rows, (row) => enrichRow(view, row), { concurrency: ENRICH_FANOUT })
        : Effect.succeed(rows);
