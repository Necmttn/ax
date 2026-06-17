import type { OtelLogEventRow } from "./rows.ts";

/**
 * Event-shape projection only. Token/duration usage stays on OtelLogEventRow's
 * lifted columns; log-only cost attributes remain in attrs for callers that need
 * them without widening this shared projection.
 */
export interface ClaudeLogEventProjection {
    readonly eventName: string;
    readonly promptId: string | null;
    readonly eventSequence: number | null;
    readonly toolUseId: string | null;
    readonly toolName: string | null;
    readonly decision: string | null;
    readonly decisionSource: string | null;
    readonly success: boolean | null;
    readonly mcpServerScope: string | null;
    readonly pluginScope: string | null;
    readonly preTokens: number | null;
    readonly postTokens: number | null;
}

type AttrValue = string | number | boolean | null;
type Attrs = Record<string, AttrValue>;

const isAttrValue = (value: unknown): value is AttrValue =>
    value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const parseAttrs = (attrs: string | null): Attrs => {
    if (!attrs) return {};
    try {
        const parsed = JSON.parse(attrs) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: Attrs = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (isAttrValue(value)) out[key] = value;
        }
        return out;
    } catch {
        return {};
    }
};

const attr = (attrs: Attrs, keys: readonly string[]): AttrValue | undefined => {
    for (const key of keys) {
        const value = attrs[key];
        if (value !== undefined && value !== null) return value;
    }
    return undefined;
};

const stringAttr = (attrs: Attrs, ...keys: readonly string[]): string | null => {
    const value = attr(attrs, keys);
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return String(value);
    return null;
};

const numberAttr = (attrs: Attrs, ...keys: readonly string[]): number | null => {
    const value = attr(attrs, keys);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string" || value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const booleanAttr = (attrs: Attrs, ...keys: readonly string[]): boolean | null => {
    const value = attr(attrs, keys);
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return null;
};

export const projectClaudeLogEvent = (row: OtelLogEventRow): ClaudeLogEventProjection => {
    const attrs = parseAttrs(row.attrs);
    return {
        eventName: row.event_name,
        promptId: stringAttr(attrs, "prompt.id", "prompt_id"),
        eventSequence: numberAttr(attrs, "event.sequence", "event_sequence"),
        toolUseId: stringAttr(attrs, "tool_use_id", "toolUseId"),
        toolName: stringAttr(attrs, "tool_name", "tool.name"),
        decision: stringAttr(attrs, "decision", "decision_type"),
        decisionSource: stringAttr(attrs, "source", "decision_source"),
        success: booleanAttr(attrs, "success"),
        mcpServerScope: stringAttr(attrs, "mcp_server_scope", "server_scope"),
        pluginScope: stringAttr(attrs, "plugin.scope", "plugin_scope"),
        preTokens: numberAttr(attrs, "pre_tokens"),
        postTokens: numberAttr(attrs, "post_tokens"),
    };
};
