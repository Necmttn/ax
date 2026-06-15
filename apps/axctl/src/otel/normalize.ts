import { attrMap, nanoToDate, type MetricsPayload, type TracePayload, type LogsPayload } from "./otlp-schema.ts";
import type { OtelMetricPointRow, OtelSpanRow, OtelLogEventRow } from "./rows.ts";

/** Map an OTLP service.name to ax's harness label. */
const harnessOf = (serviceName: string | number | boolean | null | undefined): string => {
    if (serviceName === "claude-code" || serviceName === "claude_code") return "claude";
    if (serviceName === "codex_cli_rs") return "codex";
    if (serviceName === "opencode") return "opencode";
    if (typeof serviceName === "string" && serviceName.startsWith("pi")) return "pi";
    if (typeof serviceName === "string" && serviceName.startsWith("codex")) return "codex";
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

const LOG_ALLOWLIST: Record<string, ReadonlySet<string>> = {
    codex: new Set([
        "codex.sse_event", "codex.api_request", "codex.user_prompt",
        "codex.turn_ttft", "codex.conversation_starts",
    ]),
    claude: new Set([
        "claude_code.tool_decision", "claude_code.skill_activated",
        "claude_code.user_prompt", "claude_code.api_error",
    ]),
};

const num = (v: string | number | boolean | null | undefined): number | null =>
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : null;

const eventTime = (
    a: Map<string, string | number | boolean | null>,
    observedNano: string | undefined,
    nano: string | undefined,
): Date => {
    const ts = a.get("event.timestamp");
    if (typeof ts === "string") { const d = new Date(ts); if (!Number.isNaN(d.getTime())) return d; }
    return nanoToDate(observedNano ?? nano);
};

export const normalizeLogs = (payload: LogsPayload): OtelLogEventRow[] => {
    const out: OtelLogEventRow[] = [];
    for (const rl of payload.resourceLogs) {
        const res = attrMap(rl.resource?.attributes);
        const harness = harnessOf(res.get("service.name") ?? null);
        const allow = LOG_ALLOWLIST[harness];
        for (const sl of rl.scopeLogs) {
            for (const rec of sl.logRecords) {
                const a = attrMap(rec.attributes);
                const eventName = a.get("event.name");
                if (typeof eventName !== "string") continue;
                if (!allow || !allow.has(eventName)) continue;
                out.push({
                    harness,
                    event_name: eventName,
                    session_id: str(a.get("conversation.id") ?? a.get("session.id") ?? res.get("session.id")),
                    model: str(a.get("model")),
                    input_tokens: num(a.get("input_token_count")),
                    output_tokens: num(a.get("output_token_count")),
                    reasoning_tokens: num(a.get("reasoning_token_count")),
                    cached_tokens: num(a.get("cached_token_count")),
                    tool_tokens: num(a.get("tool_token_count")),
                    duration_ms: num(a.get("duration_ms")),
                    status_code: num(a.get("http.response.status_code")),
                    attrs: a.size ? JSON.stringify(Object.fromEntries(a)) : null,
                    observed_at: eventTime(a, rec.observedTimeUnixNano, rec.timeUnixNano),
                });
            }
        }
    }
    return out;
};
