import { attrMap, nanoToDate, type MetricsPayload, type TracePayload, type LogsPayload } from "./otlp-schema.ts";
import type { OtelMetricPointRow, OtelSpanRow, OtelLogEventRow } from "./rows.ts";
import { walkResources } from "./signal.ts";

const str = (v: string | number | boolean | null | undefined): string | null =>
    typeof v === "string" ? v : v == null ? null : String(v);

export const normalizeMetrics = (payload: MetricsPayload): OtelMetricPointRow[] =>
    walkResources(
        payload.resourceMetrics,
        (rm) => rm.resource,
        (rm) => rm.scopeMetrics,
        // Leaf stays per-signal: metric-level name/unit closure + sum/gauge 1→N fan-out.
        ({ res, harness }, sm) => {
            const out: OtelMetricPointRow[] = [];
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
            return out;
        },
    );

export const normalizeTrace = (payload: TracePayload): OtelSpanRow[] =>
    walkResources(
        payload.resourceSpans,
        (rs) => rs.resource,
        (rs) => rs.scopeSpans,
        ({ res, harness }, ss) =>
            ss.spans.map((span): OtelSpanRow => {
                const a = attrMap(span.attributes);
                const started = nanoToDate(span.startTimeUnixNano);
                const ended = nanoToDate(span.endTimeUnixNano);
                return {
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
                };
            }),
    );

const LOG_ALLOWLIST: Record<string, ReadonlySet<string>> = {
    codex: new Set([
        "codex.sse_event", "codex.api_request", "codex.user_prompt",
        "codex.turn_ttft", "codex.conversation_starts",
    ]),
    claude: new Set([
        "claude_code.tool_decision",
        "claude_code.skill_activated",
        "claude_code.user_prompt",
        "claude_code.api_error",
        "claude_code.tool_result",
        "claude_code.api_request",
        "claude_code.api_refusal",
        "claude_code.permission_mode_changed",
        "claude_code.mcp_server_connection",
        "claude_code.plugin_installed",
        "claude_code.plugin_loaded",
        "claude_code.hook_registered",
        "claude_code.hook_execution_start",
        "claude_code.hook_execution_complete",
        "claude_code.hook_plugin_metrics",
        "claude_code.compaction",
        "claude_code.auth",
        "claude_code.internal_error",
        "claude_code.api_retries_exhausted",
        "claude_code.feedback_survey",
        // Raw API body events are intentionally omitted: they can carry prompt,
        // system, message, and tool payloads. Keep normalized logs signal-only.
        // "claude_code.api_request_body",
        // "claude_code.api_response_body",
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

const bodyString = (body: unknown): string | null => {
    if (typeof body === "string") return body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    const value = (body as { readonly stringValue?: unknown }).stringValue;
    return typeof value === "string" ? value : null;
};

const canonicalLogEventName = (
    harness: string,
    body: unknown,
    attrEventName: string | number | boolean | null | undefined,
): string | null => {
    if (harness !== "claude") return typeof attrEventName === "string" ? attrEventName : null;

    const fromBody = bodyString(body);
    if (fromBody?.startsWith("claude_code.")) return fromBody;
    if (typeof attrEventName !== "string" || attrEventName === "") return null;
    return attrEventName.startsWith("claude_code.") ? attrEventName : `claude_code.${attrEventName}`;
};

export const normalizeLogs = (payload: LogsPayload): OtelLogEventRow[] =>
    walkResources(
        payload.resourceLogs,
        (rl) => rl.resource,
        (rl) => rl.scopeLogs,
        // Leaf stays per-signal: allowlist filter drops non-signal records, so the
        // emitted array (the one writer indexes at render time) is post-filter.
        ({ res, harness }, sl) => {
            const allow = LOG_ALLOWLIST[harness];
            const out: OtelLogEventRow[] = [];
            for (const rec of sl.logRecords) {
                const a = attrMap(rec.attributes);
                const eventName = canonicalLogEventName(harness, rec.body, a.get("event.name"));
                if (eventName === null) continue;
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
            return out;
        },
    );
