/**
 * The OTLP signal registry - the thin dispatch table that kills the 3-way `if`
 * in `handleOtlp`. Each entry bundles a signal's decode + normalize + writer
 * binding + (for the meta-test) its statement renderer, declared column set, and
 * Row schema. The per-signal normalizers/leaves are NOT merged (no universal
 * leaf walker); only the resource→scope→harness machinery is shared (signal.ts).
 */
import type { Effect } from "effect";
import type { Schema } from "effect";
import type { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import type { OtelDecodeError, Signal } from "./signal.ts";
import { decodeLogsPayload, decodeMetricsPayload, decodeTracePayload } from "./decode.ts";
import { normalizeLogs, normalizeMetrics, normalizeTrace } from "./normalize.ts";
import {
    OtelMetricPointRow,
    OtelSpanRow,
    OtelLogEventRow,
} from "./rows.ts";
import {
    type OtelWriterShape,
    metricStmt,
    spanStmt,
    logStmt,
    METRIC_COLUMNS,
    SPAN_COLUMNS,
    LOG_COLUMNS,
} from "./writer.ts";

/**
 * A fully-typed signal spec. `P` = decoded payload, `Row` = normalized row. The
 * registry erases to `OtelSignalSpec<any, any>` at the dispatch seam (handleOtlp
 * only needs `json → Effect<void>`); `defineSignal` keeps each spec typed at its
 * definition site.
 */
export interface OtelSignalSpec<P, Row> {
    readonly signal: Signal;
    readonly table: string;
    readonly decode: (json: unknown) => Effect.Effect<P, OtelDecodeError>;
    readonly normalize: (payload: P) => Row[];
    readonly write: (writer: OtelWriterShape) => (rows: readonly Row[]) => Effect.Effect<void, DbError, SurrealClient>;
    /** Statement renderer (flat SQL, kept in writer.ts) - used by the column gate. */
    readonly stmt: (row: Row, i: number) => string;
    /** Declared SET column names - gated `⊇` the Row schema fields. */
    readonly columns: readonly string[];
    /** Row schema, for the column-set meta-test. */
    readonly rowSchema: Schema.Struct<Record<string, Schema.Top>>;
}

/** Identity helper: keeps each spec typed at the definition site. */
export const defineSignal = <P, Row>(spec: OtelSignalSpec<P, Row>): OtelSignalSpec<P, Row> => spec;

const metrics = defineSignal({
    signal: "metrics",
    table: "otel_metric_point",
    decode: decodeMetricsPayload,
    normalize: normalizeMetrics,
    write: (w) => w.writeMetrics,
    stmt: metricStmt,
    columns: METRIC_COLUMNS,
    rowSchema: OtelMetricPointRow as unknown as Schema.Struct<Record<string, Schema.Top>>,
});

const traces = defineSignal({
    signal: "traces",
    table: "otel_span",
    decode: decodeTracePayload,
    normalize: normalizeTrace,
    write: (w) => w.writeSpans,
    stmt: spanStmt,
    columns: SPAN_COLUMNS,
    rowSchema: OtelSpanRow as unknown as Schema.Struct<Record<string, Schema.Top>>,
});

const logs = defineSignal({
    signal: "logs",
    table: "otel_log_event",
    decode: decodeLogsPayload,
    normalize: normalizeLogs,
    write: (w) => w.writeLogs,
    stmt: logStmt,
    columns: LOG_COLUMNS,
    rowSchema: OtelLogEventRow as unknown as Schema.Struct<Record<string, Schema.Top>>,
});

export const SIGNALS: Record<Signal, OtelSignalSpec<any, any>> = { metrics, traces, logs };
