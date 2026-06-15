import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

export interface TelemetryCost { readonly cost_usd: number | null; readonly tokens: number; readonly source: "otlp"; }
export interface TelemetryLatency { readonly duration_ms: number | null; readonly span_count: number; }

const CHUNK = 500;
const chunk = <T>(xs: readonly T[], n: number): T[][] => {
    const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out;
};
const numOf = (v: unknown): number => typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : 0;
/** otel_*.session_id holds the bare session uuid; normalize any "table:uuid" form. */
export const bareSession = (v: unknown): string => { const s = String(v ?? ""); const c = s.indexOf(":"); return c >= 0 ? s.slice(c + 1) : s; };
const quotedList = (ids: readonly string[]): string => ids.map((i) => `"${bareSession(i)}"`).join(", ");

export const sessionTelemetryCost = (sessionIds: readonly string[]): Effect.Effect<Map<string, TelemetryCost>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        if (sessionIds.length === 0) return new Map<string, TelemetryCost>();
        const db = yield* SurrealClient;
        const acc = new Map<string, { cost_usd: number | null; tokens: number }>();
        for (const ids of chunk(sessionIds, CHUNK)) {
            const list = quotedList(ids);
            const mrows = (yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT session_id, metric, math::sum(value) AS total FROM otel_metric_point`
                + ` WHERE session_id IN [${list}] GROUP BY session_id, metric;`))?.[0] ?? [];
            for (const r of mrows) {
                const sid = bareSession(r.session_id);
                const cur = acc.get(sid) ?? { cost_usd: null, tokens: 0 };
                if (r.metric === "claude_code.cost.usage") cur.cost_usd = (cur.cost_usd ?? 0) + numOf(r.total);
                if (r.metric === "claude_code.token.usage") cur.tokens += numOf(r.total);
                acc.set(sid, cur);
            }
            const lrows = (yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT session_id, math::sum(input_tokens) AS i, math::sum(output_tokens) AS o,`
                + ` math::sum(reasoning_tokens) AS r, math::sum(tool_tokens) AS t FROM otel_log_event`
                + ` WHERE session_id IN [${list}] GROUP BY session_id;`))?.[0] ?? [];
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

export const sessionTelemetryLatency = (sessionIds: readonly string[]): Effect.Effect<Map<string, TelemetryLatency>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const out = new Map<string, TelemetryLatency>();
        if (sessionIds.length === 0) return out;
        const db = yield* SurrealClient;
        for (const ids of chunk(sessionIds, CHUNK)) {
            const rows = (yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT session_id, math::sum(duration_ms) AS d, count() AS n FROM otel_log_event`
                + ` WHERE session_id IN [${quotedList(ids)}] AND duration_ms != NONE GROUP BY session_id;`))?.[0] ?? [];
            for (const r of rows) out.set(bareSession(r.session_id), { duration_ms: numOf(r.d), span_count: numOf(r.n) });
        }
        return out;
    });
