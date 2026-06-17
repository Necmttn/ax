import type { OtelLogEventRow } from "../otel/rows.ts";

export interface HarnessToolEventProjection {
    readonly sessionId: string | null;
    readonly harness: string;
    readonly eventKind: "decision" | "result" | "request" | "permission_wait" | "unknown";
    readonly toolName: string | null;
    readonly promptId: string | null;
    readonly toolUseId: string | null;
    readonly decision: string | null;
    readonly decisionSource: string | null;
    readonly success: boolean | null;
    readonly errorType: string | null;
    readonly durationMs: number | null;
    readonly attrs: Record<string, unknown>;
}

const parseAttrs = (attrs: string | null): Record<string, unknown> => {
    if (attrs === null) return {};
    try {
        const parsed = JSON.parse(attrs) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as Record<string, unknown>;
    } catch {
        return {};
    }
};

const str = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
};

const eventKind = (eventName: string): HarnessToolEventProjection["eventKind"] => {
    if (eventName.includes("tool_decision")) return "decision";
    if (eventName.includes("tool_result")) return "result";
    if (eventName.includes("api_request")) return "request";
    if (eventName.includes("blocked_on_user") || eventName.includes("permission")) return "permission_wait";
    return "unknown";
};

const success = (value: unknown): boolean | null => {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
};

const numeric = (value: unknown): number | null => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
};

export const projectHarnessToolEvent = (row: OtelLogEventRow): HarnessToolEventProjection => {
    const attrs = parseAttrs(row.attrs);

    return {
        sessionId: row.session_id,
        harness: row.harness,
        eventKind: eventKind(row.event_name),
        toolName: str(attrs.tool_name) ?? str(attrs.toolName),
        promptId: str(attrs["prompt.id"]),
        toolUseId: str(attrs.tool_use_id) ?? str(attrs.tool_call_id),
        decision: str(attrs.decision),
        decisionSource: str(attrs.source) ?? str(attrs.decision_source),
        success: success(attrs.success),
        errorType: str(attrs.error_type),
        durationMs: row.duration_ms ?? numeric(attrs.duration_ms),
        attrs,
    };
};
