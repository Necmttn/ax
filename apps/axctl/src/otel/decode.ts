import { MetricsPayload, TracePayload, LogsPayload } from "./otlp-schema.ts";
import { decodeSignal, OtelDecodeError } from "./signal.ts";

/** Re-exported so existing importers keep `./decode.ts` as the source. */
export { OtelDecodeError };

export const decodeMetricsPayload = decodeSignal(MetricsPayload, "metrics");
export const decodeTracePayload = decodeSignal(TracePayload, "traces");
export const decodeLogsPayload = decodeSignal(LogsPayload, "logs");
