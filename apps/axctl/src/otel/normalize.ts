import { attrMap, nanoToDate, type MetricsPayload, type TracePayload } from "./otlp-schema.ts";
import type { OtelMetricPointRow, OtelSpanRow } from "./rows.ts";

/** Map an OTLP service.name to ax's harness label. */
const harnessOf = (serviceName: string | number | boolean | null | undefined): string => {
    if (serviceName === "claude-code" || serviceName === "claude_code") return "claude";
    if (serviceName === "codex_cli_rs") return "codex";
    if (serviceName === "opencode") return "opencode";
    if (typeof serviceName === "string" && serviceName.startsWith("pi")) return "pi";
    return "unknown";
};

const str = (v: string | number | boolean | null | undefined): string | null =>
    typeof v === "string" ? v : v == null ? null : String(v);

export const normalizeMetrics = (payload: MetricsPayload): OtelMetricPointRow[] => {
    const out: OtelMetricPointRow[] = [];
    for (const rm of payload.resourceMetrics) {
        const res = attrMap(rm.resource?.attributes);
        const harness = harnessOf(res.get("service.name"));
        for (const sm of rm.scopeMetrics) {
            for (const metric of sm.metrics) {
                const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
                for (const dp of points) {
                    const a = attrMap(dp.attributes);
                    const value = dp.asDouble ?? (dp.asInt !== undefined ? Number(dp.asInt) : 0);
                    out.push({
                        harness,
                        metric: metric.name,
                        value,
                        unit: metric.unit ?? null,
                        session_id: str(a.get("session.id") ?? res.get("session.id")),
                        model: str(a.get("model")),
                        skill_name: str(a.get("skill.name")),
                        agent_name: str(a.get("agent.name")),
                        attrs: a.size ? JSON.stringify(Object.fromEntries(a.entries())) : null,
                        observed_at: nanoToDate(dp.timeUnixNano),
                    });
                }
            }
        }
    }
    return out;
};

export const normalizeTrace = (payload: TracePayload): OtelSpanRow[] => {
    const out: OtelSpanRow[] = [];
    for (const rs of payload.resourceSpans) {
        const res = attrMap(rs.resource?.attributes);
        const harness = harnessOf(res.get("service.name"));
        for (const ss of rs.scopeSpans) {
            for (const span of ss.spans) {
                const a = attrMap(span.attributes);
                const started = nanoToDate(span.startTimeUnixNano);
                const ended = nanoToDate(span.endTimeUnixNano);
                out.push({
                    harness,
                    name: span.name,
                    trace_id: span.traceId,
                    span_id: span.spanId,
                    parent_span_id: span.parentSpanId ?? null,
                    session_id: str(a.get("session.id") ?? res.get("session.id")),
                    started_at: started,
                    ended_at: ended,
                    duration_ms: ended.getTime() - started.getTime(),
                    attrs: a.size ? JSON.stringify(Object.fromEntries(a.entries())) : null,
                    observed_at: started,
                });
            }
        }
    }
    return out;
};
