import type { OtelSpanRow } from "./rows.ts";

export interface SpanLatencyRollup {
    readonly sessionId: string;
    readonly spanCount: number;
    readonly promptWallMs: number;
    readonly modelRequestMs: number;
    readonly toolExecutionMs: number;
    readonly permissionWaitMs: number;
    readonly hookExecutionMs: number;
    readonly subagentMs: number;
    readonly subagentMaxDepth: number;
}

type SpanKind =
    | "prompt"
    | "model_request"
    | "tool_execution"
    | "permission_wait"
    | "hook_execution"
    | "subagent"
    | "other";

const parseAttrs = (attrs: string | null): Record<string, unknown> => {
    if (!attrs) return {};
    try {
        const parsed: unknown = JSON.parse(attrs);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
};

const loweredValues = (span: OtelSpanRow): readonly string[] => {
    const attrs = parseAttrs(span.attrs);
    const values = [span.name];
    for (const key of ["span.kind", "type", "kind", "otel.kind", "agent.type"]) {
        const value = attrs[key];
        if (typeof value === "string") values.push(value);
    }
    return values.map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));
};

const includesAny = (values: readonly string[], aliases: ReadonlySet<string>): boolean =>
    values.some((value) => aliases.has(value));

const PERMISSION_ALIASES = new Set([
    "permission_wait",
    "approval_wait",
    "blocked_on_user",
]);
const HOOK_ALIASES = new Set([
    "hook_execution",
    "hook_execution_start",
    "hook_execution_complete",
    "claude_code_hook_execution",
]);
const SUBAGENT_ALIASES = new Set([
    "subagent",
    "agent_span",
    "claude_code_subagent",
]);
const TOOL_ALIASES = new Set([
    "tool",
    "tool_execution",
    "tool_use",
    "claude_code_tool_execution",
]);
const MODEL_REQUEST_ALIASES = new Set([
    "api_request",
    "model_request",
    "llm_request",
    "claude_code_api_request",
]);
const PROMPT_ALIASES = new Set([
    "prompt",
    "user_turn",
    "session_loop",
    "claude_code_interaction",
    "interaction",
]);

export const classifySpanKind = (span: OtelSpanRow): SpanKind => {
    const values = loweredValues(span);
    if (includesAny(values, PERMISSION_ALIASES)) return "permission_wait";
    if (includesAny(values, HOOK_ALIASES)) return "hook_execution";
    if (includesAny(values, SUBAGENT_ALIASES)) return "subagent";
    if (includesAny(values, TOOL_ALIASES)) return "tool_execution";
    if (includesAny(values, MODEL_REQUEST_ALIASES)) return "model_request";
    if (includesAny(values, PROMPT_ALIASES)) return "prompt";
    return "other";
};

const spanLookupKey = (span: Pick<OtelSpanRow, "trace_id" | "span_id">): string =>
    `${span.trace_id}:${span.span_id}`;

const subagentAncestorDepthFor = (
    span: OtelSpanRow,
    spansById: ReadonlyMap<string, OtelSpanRow>,
    seen: ReadonlySet<string> = new Set(),
): number | null => {
    const parentId = span.parent_span_id;
    if (!parentId) return 0;
    const parentKey = `${span.trace_id}:${parentId}`;
    if (seen.has(parentKey)) return null;
    const parent = spansById.get(parentKey);
    if (!parent) return 0;
    const parentDepth = subagentAncestorDepthFor(parent, spansById, new Set([...seen, parentKey]));
    if (parentDepth === null) return null;
    return classifySpanKind(parent) === "subagent" ? parentDepth + 1 : parentDepth;
};

const emptyRollup = (sessionId: string): SpanLatencyRollup => ({
    sessionId,
    spanCount: 0,
    promptWallMs: 0,
    modelRequestMs: 0,
    toolExecutionMs: 0,
    permissionWaitMs: 0,
    hookExecutionMs: 0,
    subagentMs: 0,
    subagentMaxDepth: 0,
});

export const rollupSpanLatencies = (
    spans: ReadonlyArray<OtelSpanRow>,
): SpanLatencyRollup[] => {
    const spansById = new Map<string, OtelSpanRow>();
    for (const span of spans) spansById.set(spanLookupKey(span), span);

    const bySession = new Map<string, SpanLatencyRollup>();
    for (const span of spans) {
        if (!span.session_id) continue;
        const current = bySession.get(span.session_id) ?? emptyRollup(span.session_id);
        const duration = Number.isFinite(span.duration_ms) ? span.duration_ms : 0;
        const kind = classifySpanKind(span);
        const ancestorDepth = kind === "subagent"
            ? subagentAncestorDepthFor(span, spansById, new Set([spanLookupKey(span)]))
            : 0;
        const subagentDepth = kind === "subagent"
            ? 1 + (ancestorDepth ?? 0)
            : current.subagentMaxDepth;
        const next: SpanLatencyRollup = {
            ...current,
            spanCount: current.spanCount + 1,
            promptWallMs: current.promptWallMs + (kind === "prompt" ? duration : 0),
            modelRequestMs: current.modelRequestMs + (kind === "model_request" ? duration : 0),
            toolExecutionMs: current.toolExecutionMs + (kind === "tool_execution" ? duration : 0),
            permissionWaitMs: current.permissionWaitMs + (kind === "permission_wait" ? duration : 0),
            hookExecutionMs: current.hookExecutionMs + (kind === "hook_execution" ? duration : 0),
            subagentMs: current.subagentMs + (kind === "subagent" ? duration : 0),
            subagentMaxDepth: Math.max(current.subagentMaxDepth, subagentDepth),
        };
        bySession.set(span.session_id, next);
    }

    return [...bySession.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
};
