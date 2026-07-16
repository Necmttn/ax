/**
 * `ax otel` rollup: a read surface for the OTLP receiver itself.
 *
 * OTLP telemetry lands in `otel_metric_point` / `otel_log_event` / `otel_span`
 * and is otherwise only used to *enrich* existing insights via the
 * `telemetry_of` edge. There was no way to answer the operator's first
 * question - "is telemetry even flowing, and is it being correlated to my
 * sessions?" - so this query exposes:
 *
 *   - per (harness, signal) all-time volume + freshness (last-received age),
 *     reduced to a health verdict (flowing / stale / cold / none);
 *   - coverage: of windowed TOP-LEVEL sessions, how many have matching otel
 *     telemetry, by `session_id` match (NOT the `telemetry_of` edge - that is
 *     not what enrichment reads; telemetry-rollup.ts joins session_id directly).
 *     Subagents are excluded (OTLP is emitted at the top-level session);
 *   - OTLP-sourced cost/tokens vs transcript-parsed cost for the same window,
 *     side by side (they are stored separately to avoid double-counting).
 *
 * Deref-free: plain GROUP BY / count() aggregates per table, intersected in JS.
 * Signals are all-time (the "is the receiver alive" question is not windowed);
 * coverage + cost are scoped to `--days`.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { fetchCostModels } from "./cost-analytics.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OtelSignalKind = "metric" | "log" | "span";
/** flowing = fresh, stale = aging, cold = data exists but long silent, none = never. */
export type OtelHealth = "flowing" | "stale" | "cold" | "none";

export interface OtelSignalRow {
    readonly harness: string;
    readonly signal: OtelSignalKind;
    /** all-time row count for this (harness, signal) */
    readonly count: number;
    readonly last_observed_at: string | null;
    readonly age_ms: number | null;
    readonly health: OtelHealth;
}

export interface OtelCoverage {
    /** windowed TOP-LEVEL sessions (uuid id); subagents excluded - OTLP is emitted at the top-level session, never per-subagent. */
    readonly window_sessions: number;
    /** windowed top-level sessions whose uuid matches an otel `session_id` */
    readonly linked_sessions: number;
    /** linked / window, 0..100 (0 when no sessions in window) */
    readonly pct: number;
}

export interface OtelCostCompare {
    /** OTLP-reported cost from the `claude_code.cost.usage` metric (Claude only - Codex emits no cost metric). */
    readonly otlp_usd: number | null;
    /** transcript-parsed cost over the same window, as an independent cross-check. */
    readonly transcript_usd: number | null;
}

export interface OtelRollupResult {
    readonly since_days: number;
    readonly generated_at: string;
    readonly signals: ReadonlyArray<OtelSignalRow>;
    readonly coverage: OtelCoverage;
    readonly cost: OtelCostCompare;
}

export interface OtelRollupInput {
    readonly sinceDays: number;
}

export const OTEL_DEFAULT_WINDOW_DAYS = 14;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without a DB)
// ---------------------------------------------------------------------------

/** Fresh under 6h, stale under 48h, otherwise cold; no data ever -> none. */
export const FLOWING_MS = 6 * 3_600_000;
export const STALE_MS = 48 * 3_600_000;

export const otelHealth = (lastIso: string | null, nowMs: number): OtelHealth => {
    if (lastIso === null) return "none";
    const t = new Date(lastIso).getTime();
    if (Number.isNaN(t)) return "none";
    const age = nowMs - t;
    if (age < FLOWING_MS) return "flowing";
    if (age < STALE_MS) return "stale";
    return "cold";
};

export const healthGlyph = (h: OtelHealth): string =>
    h === "flowing" ? "✓" : h === "stale" ? "⚠" : h === "cold" ? "✗" : "·";

/** Human age like "2h", "3d", "12m"; null -> "never". */
export const formatAge = (ageMs: number | null): string => {
    if (ageMs === null) return "never";
    if (ageMs < 0) return "0m";
    const m = Math.floor(ageMs / 60_000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
};

export const coveragePct = (linked: number, total: number): number =>
    total <= 0 ? 0 : Math.round((linked / total) * 1000) / 10;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/**
 * Extract the bare uuid from either an otel `session_id` (already bare) or a
 * SurrealDB session record id, which stringifies as `session:⟨uuid⟩` (or a
 * RecordId object). Returns null when no uuid is present.
 */
export const bareUuid = (v: unknown): string | null => {
    if (v == null) return null;
    const s = typeof v === "string" ? v : String((v as { id?: unknown }).id ?? v);
    const m = UUID_RE.exec(s);
    return m ? m[0].toLowerCase() : null;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const numOf = (v: unknown): number =>
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : 0;

const isoOf = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    const s = String(v);
    return s.length > 0 ? s : null;
};

const SIGNAL_TABLES: ReadonlyArray<readonly [OtelSignalKind, string]> = [
    ["metric", "otel_metric_point"],
    ["log", "otel_log_event"],
    ["span", "otel_span"],
];

export const buildOtelSessionIdsQuery = (table: string, days: number): string =>
    `SELECT session_id FROM ${table}`
    + ` WHERE observed_at > time::now() - ${days}d`
    + " AND session_id != NONE GROUP BY session_id;";

export const fetchOtelRollup = (
    input: OtelRollupInput,
): Effect.Effect<OtelRollupResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const days = Math.max(1, Math.floor(input.sinceDays));
        const nowMs = Date.now();

        // -- signals: all-time count + freshness per (harness, signal) -------
        const signals: OtelSignalRow[] = [];
        for (const [signal, table] of SIGNAL_TABLES) {
            const rows = (yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT harness, count() AS n, time::max(observed_at) AS last FROM ${table} GROUP BY harness;`,
            ))?.[0] ?? [];
            for (const r of rows) {
                const last = isoOf(r.last);
                const age = last === null ? null : nowMs - new Date(last).getTime();
                signals.push({
                    harness: String(r.harness ?? "unknown"),
                    signal,
                    count: numOf(r.n),
                    last_observed_at: last,
                    age_ms: age !== null && Number.isFinite(age) ? age : null,
                    health: otelHealth(last, nowMs),
                });
            }
        }
        signals.sort((a, b) =>
            a.harness === b.harness ? a.signal.localeCompare(b.signal) : a.harness.localeCompare(b.harness),
        );

        // -- coverage: windowed sessions that have matching otel telemetry -----
        // Measured by session_id match, NOT the telemetry_of edge: the edge is
        // not what enrichment reads (telemetry-rollup.ts joins on session_id
        // directly), and otel's `session_id` is a bare uuid while `session.id`
        // is the escaped `session:⟨uuid⟩` record - so we compare bare uuids in JS.
        const idRows = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT id FROM session WHERE started_at > time::now() - ${days}d;`,
        ))?.[0] ?? [];
        const windowUuids = idRows.map((r) => bareUuid(r.id)).filter((u): u is string => u !== null);
        const window_sessions = windowUuids.length;

        const otelSids = new Set<string>();
        for (const [, table] of SIGNAL_TABLES) {
            const sidRows = (yield* db.query<[Array<Record<string, unknown>>]>(
                buildOtelSessionIdsQuery(table, days),
            ))?.[0] ?? [];
            for (const r of sidRows) {
                const u = bareUuid(r.session_id);
                if (u !== null) otelSids.add(u);
            }
        }
        let linked_sessions = 0;
        for (const u of windowUuids) if (otelSids.has(u)) linked_sessions++;

        // -- cost: OTLP claude cost metric vs transcript (independent cross-check)
        // Only `claude_code.cost.usage` is summed - it is the receiver's own cost
        // signal. Token sums across per-event logs double-count badly, so they are
        // intentionally not surfaced here (see telemetry-rollup.ts for per-session use).
        const metricRows = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT math::sum(value) AS v FROM otel_metric_point`
            + ` WHERE observed_at > time::now() - ${days}d`
            + ` AND metric = 'claude_code.cost.usage' GROUP ALL;`,
        ))?.[0] ?? [];
        const otlp_usd = metricRows.length > 0 ? numOf(metricRows[0]?.v) : null;

        const transcript = yield* fetchCostModels({ sinceDays: days });

        return {
            since_days: days,
            generated_at: new Date(nowMs).toISOString(),
            signals,
            coverage: {
                window_sessions,
                linked_sessions,
                pct: coveragePct(linked_sessions, window_sessions),
            },
            cost: {
                otlp_usd,
                transcript_usd: transcript.total_cost_usd ?? null,
            },
        } satisfies OtelRollupResult;
    });
