import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheReadService } from "@ax/lib/duckdb/seam";
import { inClause } from "@ax/lib/duckdb/clause";

export interface TelemetryCost { readonly cost_usd: number | null; readonly tokens: number; readonly source: "otlp"; }
export interface TelemetryLatency { readonly duration_ms: number | null; readonly span_count: number; }

const CHUNK = 500;
const chunk = <T>(xs: readonly T[], n: number): T[][] => {
    const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out;
};
const numOf = (v: unknown): number => typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : 0;
/** otel_*.session_id holds the bare session uuid; normalize any "table:uuid" form. */
export const bareSession = (v: unknown): string => { const s = String(v ?? ""); const c = s.indexOf(":"); return c >= 0 ? s.slice(c + 1) : s; };
const MetricRow = Schema.Struct({ session_id: Schema.String, metric: Schema.String, total: Schema.NullOr(Schema.Number) });
const TokenRow = Schema.Struct({
    session_id: Schema.String,
    i: Schema.NullOr(Schema.Number), o: Schema.NullOr(Schema.Number),
    r: Schema.NullOr(Schema.Number), t: Schema.NullOr(Schema.Number),
});
const LatencyRow = Schema.Struct({
    session_id: Schema.String,
    d: Schema.NullOr(Schema.Number),
    n: NumberFromBigIntColumn,
});

export const sessionTelemetryCost = (read: CacheReadService, sessionIds: readonly string[]): Effect.Effect<Map<string, TelemetryCost>, CacheReadError> =>
    Effect.gen(function* () {
        if (sessionIds.length === 0) return new Map<string, TelemetryCost>();
        const acc = new Map<string, { cost_usd: number | null; tokens: number }>();
        for (const ids of chunk(sessionIds, CHUNK)) {
            const sessions = inClause("session_id", ids.map(bareSession));
            const mrows = yield* read.rows(MetricRow,
                `SELECT session_id, metric, sum(value) AS total FROM otel_metric_point WHERE TRUE ${sessions.sql} GROUP BY session_id, metric`, sessions.params);
            for (const r of mrows) {
                const sid = bareSession(r.session_id);
                const cur = acc.get(sid) ?? { cost_usd: null, tokens: 0 };
                if (r.metric === "claude_code.cost.usage") cur.cost_usd = (cur.cost_usd ?? 0) + numOf(r.total);
                if (r.metric === "claude_code.token.usage") cur.tokens += numOf(r.total);
                acc.set(sid, cur);
            }
            const lrows = yield* read.rows(TokenRow,
                `SELECT session_id, sum(input_tokens) AS i, sum(output_tokens) AS o,`
                + ` sum(reasoning_tokens) AS r, sum(tool_tokens) AS t FROM otel_log_event`
                + ` WHERE TRUE ${sessions.sql} GROUP BY session_id`, sessions.params);
            for (const r of lrows) {
                const sid = bareSession(r.session_id);
                const cur = acc.get(sid) ?? { cost_usd: null, tokens: 0 };
                cur.tokens += numOf(r.i) + numOf(r.o) + numOf(r.r) + numOf(r.t);
                acc.set(sid, cur);
            }
        }
        const out = new Map<string, TelemetryCost>();
        for (const [k, v] of acc) out.set(k, { cost_usd: v.cost_usd, tokens: v.tokens, source: "otlp" });
        return out;
    });

export const sessionTelemetryLatency = (read: CacheReadService, sessionIds: readonly string[]): Effect.Effect<Map<string, TelemetryLatency>, CacheReadError> =>
    Effect.gen(function* () {
        const out = new Map<string, TelemetryLatency>();
        if (sessionIds.length === 0) return out;
        for (const ids of chunk(sessionIds, CHUNK)) {
            const sessions = inClause("session_id", ids.map(bareSession));
            const rows = yield* read.rows(LatencyRow,
                `SELECT session_id, sum(duration_ms) AS d, count(*) AS n FROM otel_log_event`
                + ` WHERE TRUE ${sessions.sql} AND duration_ms IS NOT NULL GROUP BY session_id`, sessions.params);
            for (const r of rows) out.set(bareSession(r.session_id), { duration_ms: numOf(r.d), span_count: numOf(r.n) });
        }
        return out;
    });

const uniqueBareSessions = <Row>(
    rows: ReadonlyArray<Row>,
    sessionOf: (row: Row) => unknown,
): readonly string[] =>
    [...new Set(rows.map((row) => bareSession(sessionOf(row))).filter((id) => id.length > 0))];

export const enrichRowsWithTelemetryCost = <Row, Out>(
    read: CacheReadService,
    rows: ReadonlyArray<Row>,
    sessionOf: (row: Row) => unknown,
    merge: (row: Row, telemetry: TelemetryCost | null) => Out,
): Effect.Effect<Out[], CacheReadError> =>
    Effect.gen(function* () {
        if (rows.length === 0) return [];
        const telemetry = yield* sessionTelemetryCost(read, uniqueBareSessions(rows, sessionOf));
        return rows.map((row) => merge(row, telemetry.get(bareSession(sessionOf(row))) ?? null));
    });

export const enrichRowsWithTelemetryLatency = <Row, Out>(
    read: CacheReadService,
    rows: ReadonlyArray<Row>,
    sessionOf: (row: Row) => unknown,
    merge: (row: Row, telemetry: TelemetryLatency | null) => Out,
): Effect.Effect<Out[], CacheReadError> =>
    Effect.gen(function* () {
        if (rows.length === 0) return [];
        const telemetry = yield* sessionTelemetryLatency(read, uniqueBareSessions(rows, sessionOf));
        return rows.map((row) => merge(row, telemetry.get(bareSession(sessionOf(row))) ?? null));
    });
