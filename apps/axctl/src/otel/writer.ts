import { Context, Layer } from "effect";
import type { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import {
    recordRef,
    surrealString,
    surrealDate,
    surrealOptionString,
} from "@ax/lib/shared/surreal";
import {
    metricPointKey,
    spanKey,
    logEventKey,
    type OtelMetricPointRow,
    type OtelSpanRow,
    type OtelLogEventRow,
} from "./rows.ts";
import { writeRows } from "./signal.ts";

export interface OtelWriterShape {
    readonly writeMetrics: (rows: readonly OtelMetricPointRow[]) => Effect.Effect<void, DbError, SurrealClient>;
    readonly writeSpans: (rows: readonly OtelSpanRow[]) => Effect.Effect<void, DbError, SurrealClient>;
    readonly writeLogs: (rows: readonly OtelLogEventRow[]) => Effect.Effect<void, DbError, SurrealClient>;
}

export class OtelWriter extends Context.Service<OtelWriter, OtelWriterShape>()("ax/otel/OtelWriter") {}

/** null → SurrealQL `NONE` for the log token/cost columns (declared `option<number>`). */
const optNum = (n: number | null): string => n === null ? "NONE" : String(n);

// ---------------------------------------------------------------- statements
// Flat, greppable per-column UPSERT SQL - deliberately NOT a Column DSL. The
// column-name arrays below are asserted (signal.test.ts) to be a superset of
// each Row schema's fields AND to match what the stmt actually renders.
// NONE-vs-raw is load-bearing: metric `value` + span `duration_ms` render RAW
// (non-null Schema.Number); log token/cost columns render NONE via `optNum`.

export const METRIC_COLUMNS = [
    "harness", "metric", "value", "unit", "session_id", "model",
    "skill_name", "agent_name", "attrs", "observed_at",
] as const;

export const metricStmt = (r: OtelMetricPointRow, _i: number): string =>
    `UPSERT ${recordRef("otel_metric_point", metricPointKey(r))} SET ` +
    `harness = ${surrealString(r.harness)}, ` +
    `metric = ${surrealString(r.metric)}, ` +
    `value = ${r.value}, ` +
    `unit = ${surrealOptionString(r.unit)}, ` +
    `session_id = ${surrealOptionString(r.session_id)}, ` +
    `model = ${surrealOptionString(r.model)}, ` +
    `skill_name = ${surrealOptionString(r.skill_name)}, ` +
    `agent_name = ${surrealOptionString(r.agent_name)}, ` +
    `attrs = ${surrealOptionString(r.attrs)}, ` +
    `observed_at = ${surrealDate(r.observed_at)};`;

export const SPAN_COLUMNS = [
    "harness", "name", "trace_id", "span_id", "parent_span_id", "session_id",
    "started_at", "ended_at", "duration_ms", "attrs", "observed_at",
] as const;

export const spanStmt = (r: OtelSpanRow, _i: number): string =>
    `UPSERT ${recordRef("otel_span", spanKey(r))} SET ` +
    `harness = ${surrealString(r.harness)}, ` +
    `name = ${surrealString(r.name)}, ` +
    `trace_id = ${surrealString(r.trace_id)}, ` +
    `span_id = ${surrealString(r.span_id)}, ` +
    `parent_span_id = ${surrealOptionString(r.parent_span_id)}, ` +
    `session_id = ${surrealOptionString(r.session_id)}, ` +
    `started_at = ${surrealDate(r.started_at)}, ` +
    `ended_at = ${surrealDate(r.ended_at)}, ` +
    `duration_ms = ${r.duration_ms}, ` +
    `attrs = ${surrealOptionString(r.attrs)}, ` +
    `observed_at = ${surrealDate(r.observed_at)};`;

export const LOG_COLUMNS = [
    "harness", "event_name", "session_id", "model", "input_tokens",
    "output_tokens", "reasoning_tokens", "cached_tokens", "tool_tokens",
    "duration_ms", "status_code", "attrs", "observed_at",
] as const;

// `i` is the post-allowlist-filter render index - folded into the record id so
// distinct same-name events at the same second do not collide.
export const logStmt = (r: OtelLogEventRow, i: number): string =>
    `UPSERT ${recordRef("otel_log_event", logEventKey(r, i))} SET ` +
    `harness = ${surrealString(r.harness)}, ` +
    `event_name = ${surrealString(r.event_name)}, ` +
    `session_id = ${surrealOptionString(r.session_id)}, ` +
    `model = ${surrealOptionString(r.model)}, ` +
    `input_tokens = ${optNum(r.input_tokens)}, ` +
    `output_tokens = ${optNum(r.output_tokens)}, ` +
    `reasoning_tokens = ${optNum(r.reasoning_tokens)}, ` +
    `cached_tokens = ${optNum(r.cached_tokens)}, ` +
    `tool_tokens = ${optNum(r.tool_tokens)}, ` +
    `duration_ms = ${optNum(r.duration_ms)}, ` +
    `status_code = ${optNum(r.status_code)}, ` +
    `attrs = ${surrealOptionString(r.attrs)}, ` +
    `observed_at = ${surrealDate(r.observed_at)};`;

export const OtelWriterLive: Layer.Layer<OtelWriter> = Layer.succeed(OtelWriter, {
    writeMetrics: (rows) => writeRows(rows, metricStmt),
    writeSpans: (rows) => writeRows(rows, spanStmt),
    writeLogs: (rows) => writeRows(rows, logStmt),
});
