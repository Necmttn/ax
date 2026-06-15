import { Context, Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { executeStatements } from "@ax/lib/shared/surreal";
import {
    surrealString,
    surrealDate,
    surrealOptionString,
} from "@ax/lib/shared/surreal";
import {
    metricPointKey,
    spanKey,
    type OtelMetricPointRow,
    type OtelSpanRow,
} from "./rows.ts";

export interface OtelWriterShape {
    readonly writeMetrics: (rows: readonly OtelMetricPointRow[]) => Effect.Effect<void, DbError, SurrealClient>;
    readonly writeSpans: (rows: readonly OtelSpanRow[]) => Effect.Effect<void, DbError, SurrealClient>;
}

export class OtelWriter extends Context.Service<OtelWriter, OtelWriterShape>()("ax/otel/OtelWriter") {}

const metricStmt = (r: OtelMetricPointRow): string => {
    const id = metricPointKey(r).replace(/`/g, "");
    return (
        `UPSERT otel_metric_point:\`${id}\` SET ` +
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
    const id = spanKey(r).replace(/`/g, "");
    return (
        `UPSERT otel_span:\`${id}\` SET ` +
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

export const OtelWriterLive: Layer.Layer<OtelWriter> = Layer.succeed(OtelWriter, {
    writeMetrics: (rows) =>
        rows.length === 0 ? Effect.void : executeStatements(rows.map(metricStmt)),
    writeSpans: (rows) =>
        rows.length === 0 ? Effect.void : executeStatements(rows.map(spanStmt)),
});
