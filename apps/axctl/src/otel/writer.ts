import { Context, Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import {
    executeStatements,
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

export interface OtelWriterShape {
    readonly writeMetrics: (rows: readonly OtelMetricPointRow[]) => Effect.Effect<void, DbError, SurrealClient>;
    readonly writeSpans: (rows: readonly OtelSpanRow[]) => Effect.Effect<void, DbError, SurrealClient>;
    readonly writeLogs: (rows: readonly OtelLogEventRow[]) => Effect.Effect<void, DbError, SurrealClient>;
}

export class OtelWriter extends Context.Service<OtelWriter, OtelWriterShape>()("ax/otel/OtelWriter") {}

const optNum = (n: number | null): string => n === null ? "NONE" : String(n);

const metricStmt = (r: OtelMetricPointRow): string => {
    return (
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
        `observed_at = ${surrealDate(r.observed_at)};`
    );
};

const spanStmt = (r: OtelSpanRow): string => {
    return (
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
        `observed_at = ${surrealDate(r.observed_at)};`
    );
};

const logStmt = (r: OtelLogEventRow, i: number): string =>
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
    writeMetrics: (rows) =>
        rows.length === 0 ? Effect.void : executeStatements(rows.map(metricStmt)),
    writeSpans: (rows) =>
        rows.length === 0 ? Effect.void : executeStatements(rows.map(spanStmt)),
    writeLogs: (rows) =>
        rows.length === 0 ? Effect.void : executeStatements(rows.map((r, i) => logStmt(r, i))),
});
