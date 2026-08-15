import { Context, Effect, Layer } from "effect";
import { cacheRow } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import {
    metricPointKey,
    spanKey,
    logEventKey,
    type OtelMetricPointRow,
    type OtelSpanRow,
    type OtelLogEventRow,
} from "./rows.ts";

export interface OtelWriterShape {
    readonly writeMetrics: (rows: readonly OtelMetricPointRow[]) => Effect.Effect<void, CacheWriteError>;
    readonly writeSpans: (rows: readonly OtelSpanRow[]) => Effect.Effect<void, CacheWriteError>;
    readonly writeLogs: (rows: readonly OtelLogEventRow[]) => Effect.Effect<void, CacheWriteError>;
}

export class OtelWriter extends Context.Service<OtelWriter, OtelWriterShape>()("ax/otel/OtelWriter") {}

export const OtelWriterLive = (write: CacheWriteService): Layer.Layer<OtelWriter> =>
    Layer.succeed(OtelWriter, OtelWriter.of({
        writeMetrics: (rows) => write.putMany("otel_metric_point", rows.map((r) => cacheRow({
            id: metricPointKey(r),
            harness: r.harness,
            metric: r.metric,
            value: r.value,
            unit: r.unit,
            session_id: r.session_id,
            model: r.model,
            skill_name: r.skill_name,
            agent_name: r.agent_name,
            attrs: r.attrs,
            observed_at: r.observed_at,
        }))),
        writeSpans: (rows) => write.putMany("otel_span", rows.map((r) => cacheRow({
            id: spanKey(r),
            harness: r.harness,
            name: r.name,
            trace_id: r.trace_id,
            span_id: r.span_id,
            parent_span_id: r.parent_span_id,
            session_id: r.session_id,
            started_at: r.started_at,
            ended_at: r.ended_at,
            duration_ms: r.duration_ms,
            attrs: r.attrs,
            observed_at: r.observed_at,
        }))),
        writeLogs: (rows) => write.putMany("otel_log_event", rows.map((r, i) => cacheRow({
            id: logEventKey(r, i),
            harness: r.harness,
            event_name: r.event_name,
            session_id: r.session_id,
            model: r.model,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            reasoning_tokens: r.reasoning_tokens,
            cached_tokens: r.cached_tokens,
            tool_tokens: r.tool_tokens,
            duration_ms: r.duration_ms,
            status_code: r.status_code,
            attrs: r.attrs,
            observed_at: r.observed_at,
        }))),
    }));
