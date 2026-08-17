/**
 * insights-enrich.ts - post-query context enrichment for the classifier
 * insight views.
 *
 * classifier-facts / correction-contexts / classifier-outcomes fetch their
 * per-row context (previous assistant turn, recent tool failures, later
 * tool calls / command outcomes / user turns) via literal-session-id lookups
 * fanned out at bounded concurrency, so a view row never pays a correlated
 * per-row scan. Field names and shapes match what `insights.ts` emits, so
 * `formatInsightRows` is unchanged.
 *
 * Runs over the DuckDB `CacheRead` seam: `session` is a bare VARCHAR (no
 * record-id wrapper) and every lookup binds its session id / seq / ts as
 * ordinary parameters instead of splicing literals into statement text.
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import type { InsightView } from "./insights.ts";
import { bareSession, enrichRowsWithTelemetryCost } from "./telemetry-rollup.ts";

/** Per-row fan-out width for the context lookups. */
const ENRICH_FANOUT = 8;

type Row = Record<string, unknown>;

const ENRICHED_VIEWS = new Set<InsightView>([
    "classifier-facts",
    "correction-contexts",
    "classifier-outcomes",
]);

/** Bare session id from a row's `session` field. DuckDB rows carry the plain
 *  VARCHAR id directly - no `session:` record-id unwrapping needed. Null when
 *  absent/malformed, so the row passes through unenriched rather than failing
 *  the whole view. */
const sessionIdOf = (row: Row): string | null => {
    const raw = row.session;
    if (typeof raw !== "string" || raw.length === 0) return null;
    return raw;
};

const tsOf = (row: Row): Date | null => {
    const ts = row.ts;
    if (ts instanceof Date) return ts;
    if (typeof ts === "string" && ts.length > 0) {
        const parsed = new Date(ts);
        return Number.isFinite(parsed.getTime()) ? parsed : null;
    }
    return null;
};

const seqOf = (row: Row): number | null =>
    typeof row.user_seq === "number" && Number.isFinite(row.user_seq) ? row.user_seq : null;

const one = <T>(rows: readonly T[] | undefined): T | null => rows?.[0] ?? null;

// ---------------------------------------------------------------------------
// Row contracts for the enrichment lookups
// ---------------------------------------------------------------------------

const PrevAssistantRow = Schema.Struct({
    id: Schema.String,
    seq: NumberFromBigIntColumn,
    text: Schema.NullOr(Schema.String),
});

const ToolFailureRow = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    command_norm: Schema.NullOr(Schema.String),
    error_text: Schema.NullOr(Schema.String),
    output_excerpt: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
});

const LaterToolCallRow = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    command_norm: Schema.NullOr(Schema.String),
    has_error: Schema.Boolean,
    status: Schema.NullOr(Schema.String),
    exit_code: Schema.NullOr(NumberFromBigIntColumn),
    output_excerpt: Schema.NullOr(Schema.String),
    error_text: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
});

const LaterCommandOutcomeRow = Schema.Struct({
    id: Schema.String,
    kind: Schema.String,
    status: Schema.String,
    command_norm: Schema.NullOr(Schema.String),
    command_tool: Schema.NullOr(Schema.String),
    text: Schema.NullOr(Schema.String),
    tool_call: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
});

const LaterUserTurnRow = Schema.Struct({
    id: Schema.String,
    seq: NumberFromBigIntColumn,
    role: Schema.String,
    text: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
});

const PREV_ASSISTANT_SQL = `
SELECT id, seq, text_excerpt AS text
FROM turn
WHERE session = ? AND role = 'assistant' AND seq < ?
ORDER BY seq DESC
LIMIT 1;
`;

const RECENT_TOOL_FAILURES_SQL = (limit: number) => `
SELECT id, name, command_norm, error_text, output_excerpt, ts
FROM tool_call
WHERE session = ? AND has_error = TRUE AND ts <= ?
ORDER BY ts DESC
LIMIT ${limit};
`;

const LATER_TOOL_CALLS_SQL = `
SELECT id, name, command_norm, has_error, status, exit_code, output_excerpt, error_text, ts
FROM tool_call
WHERE session = ? AND ts > ?
ORDER BY ts ASC
LIMIT 5;
`;

const LATER_COMMAND_OUTCOMES_SQL = `
SELECT id, kind, status, command_norm, command_tool, text, tool_call, ts
FROM command_outcome
WHERE session = ? AND ts > ?
ORDER BY ts ASC
LIMIT 5;
`;

const LATER_USER_TURNS_SQL = `
SELECT id, seq, role, text_excerpt AS text, ts
FROM turn
WHERE session = ? AND role = 'user' AND seq > ?
ORDER BY seq ASC
LIMIT 3;
`;

const enrichRow = Effect.fn("queries.enrichRow")(function* (
    view: InsightView,
    row: Row,
) {
    const read = yield* CacheRead;
    const sid = sessionIdOf(row);
    if (sid === null) return row;
    const seq = seqOf(row);
    const ts = tsOf(row);

    if (view === "classifier-facts" || view === "correction-contexts") {
        const failureLimit = view === "classifier-facts" ? 3 : 5;
        const [prevResult, failResult] = yield* Effect.all([
            seq === null
                ? Effect.succeed([])
                : read.rows(PrevAssistantRow, PREV_ASSISTANT_SQL, [sid, seq]),
            ts === null
                ? Effect.succeed([])
                : read.rows(ToolFailureRow, RECENT_TOOL_FAILURES_SQL(failureLimit), [sid, ts]),
        ], { concurrency: 2 });
        return {
            ...row,
            previous_assistant: one(prevResult),
            recent_tool_failures: failResult,
        };
    }

    // classifier-outcomes: what happened AFTER the classified turn.
    const [toolResult, outcomeResult, userResult] = yield* Effect.all([
        ts === null
            ? Effect.succeed([])
            : read.rows(LaterToolCallRow, LATER_TOOL_CALLS_SQL, [sid, ts]),
        ts === null
            ? Effect.succeed([])
            : read.rows(LaterCommandOutcomeRow, LATER_COMMAND_OUTCOMES_SQL, [sid, ts]),
        seq === null
            ? Effect.succeed([])
            : read.rows(LaterUserTurnRow, LATER_USER_TURNS_SQL, [sid, seq]),
    ], { concurrency: 3 });
    return {
        ...row,
        later_tool_calls: toolResult,
        later_command_outcomes: outcomeResult,
        later_user_turns: userResult,
    };
});

/** Extract a bare session UUID from a friction row's session_ref/session field. */
const frictionSessionId = (row: Row): string =>
    bareSession(
        typeof row.session_ref === "string"
            ? row.session_ref
            : typeof row.session === "string"
                ? row.session
                : String(row.session ?? ""),
    );

/** Pure fold - exported for unit testing. Tags each friction row with the
 *  dominant content type of its session. `bySession` is keyed by bare session
 *  UUID (no `session:` prefix). Returns `null` when no content data exists. */
export const foldContentTypeOntoFriction = (
    rows: ReadonlyArray<Row>,
    bySession: ReadonlyMap<string, string>,
): Array<Row & { readonly contentType: string | null }> =>
    rows.map((r) => ({ ...r, contentType: bySession.get(frictionSessionId(r)) ?? null }));

const FrictionContentTypeRow = Schema.Struct({
    sid: Schema.String,
    ct: Schema.String,
    bytes: NumberFromBigIntColumn,
});

/** Batch lookup: for each session in `ids`, return the dominant content-type
 *  category (most bytes) from the `has_content` edge. Deref-free - the edge
 *  already denormalizes `session`. */
const fetchFrictionContentTypes = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, string>, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        if (sessionIds.length === 0) return new Map<string, string>();
        const read = yield* CacheRead;
        const bareIds = [...new Set(sessionIds.map((id) => bareSession(id)))];
        const placeholders = bareIds.map(() => "?").join(", ");
        const raw = yield* read.rows(
            FrictionContentTypeRow,
            `SELECT session AS sid, out_id AS ct, coalesce(sum(bytes), 0) AS bytes
FROM has_content WHERE session IN (${placeholders}) GROUP BY sid, ct;`,
            bareIds,
        );
        // Per session: pick the category with the most bytes
        const best = new Map<string, { ct: string; bytes: number }>();
        for (const r of raw) {
            const sid = bareSession(r.sid);
            const prev = best.get(sid);
            if (!prev || r.bytes > prev.bytes) {
                best.set(sid, { ct: r.ct.replace(/^content_type:/, ""), bytes: r.bytes });
            }
        }
        const out = new Map<string, string>();
        for (const [k, v] of best) out.set(k, v.ct);
        return out;
    });

/** Enrich the rows of a classifier insight view with per-row context via
 *  indexed lookups. Views outside ENRICHED_VIEWS pass through untouched.
 *  The "friction" view gets a single batched OTLP cost lookup and a
 *  session-dominant content-type tag appended. */
export const enrichInsightRows = Effect.fn("queries.enrichInsightRows")(
    function* (view: InsightView, rows: ReadonlyArray<Row>) {
        const read = yield* CacheRead;
        if (view === "friction") {
            const contentTypes = yield* fetchFrictionContentTypes(rows.map(frictionSessionId));
            const withCost = yield* enrichRowsWithTelemetryCost(read, rows, frictionSessionId, (row, cost): Row => ({
                ...row,
                otlp_cost_usd: cost?.cost_usd ?? null,
                otlp_tokens: cost?.tokens ?? null,
            }));
            return foldContentTypeOntoFriction(withCost, contentTypes);
        }
        if (!ENRICHED_VIEWS.has(view)) return rows;
        return yield* Effect.forEach(rows, (row) => enrichRow(view, row), { concurrency: ENRICH_FANOUT });
    },
);
