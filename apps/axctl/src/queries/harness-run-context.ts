import type { OtelLogEventRow } from "../otel/rows.ts";
import { classifyHarnessSurface } from "./harness-surface.ts";

export interface HarnessRunContextProjection {
    readonly sessionId: string | null;
    readonly harness: string;
    readonly surface: string | null;
    readonly entrypoint: string | null;
    readonly deploymentProvider: string | null;
    readonly authMode: string | null;
    readonly modelProvider: string | null;
    readonly model: string | null;
    readonly reasoningEffort: string | null;
    readonly reasoningSummary: string | null;
    readonly approvalPolicy: string | null;
    readonly sandboxPolicy: string | null;
    readonly permissionProfile: string | null;
    readonly webSearchMode: string | null;
    readonly mcpServers: string | null;
    readonly appVersion: string | null;
    readonly terminalType: string | null;
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

export const projectHarnessRunContext = (row: OtelLogEventRow): HarnessRunContextProjection => {
    const attrs = parseAttrs(row.attrs);
    const surface = classifyHarnessSurface({
        harness: row.harness,
        serviceName: str(attrs["service.name"]),
        originator: str(attrs.originator),
        entrypoint: str(attrs.entrypoint),
        deploymentProvider: str(attrs.deployment_provider),
    });

    return {
        sessionId: row.session_id ?? str(attrs["conversation.id"]) ?? str(attrs["session.id"]),
        harness: row.harness,
        surface: surface.surface,
        entrypoint: surface.entrypoint,
        deploymentProvider: surface.deploymentProvider,
        authMode: str(attrs.auth_mode),
        modelProvider: str(attrs.provider_name) ?? str(attrs.model_provider),
        model: row.model ?? str(attrs.model),
        reasoningEffort: str(attrs.reasoning_effort),
        reasoningSummary: str(attrs.reasoning_summary),
        approvalPolicy: str(attrs.approval_policy),
        sandboxPolicy: str(attrs.sandbox_policy),
        permissionProfile: str(attrs.permission_profile) ?? str(attrs["permission.mode"]),
        webSearchMode: str(attrs.web_search_mode),
        mcpServers: str(attrs.mcp_servers),
        appVersion: str(attrs["app.version"]),
        terminalType: str(attrs["terminal.type"]),
        attrs,
    };
};
