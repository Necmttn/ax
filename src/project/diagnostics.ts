import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { DiagnosticConfig, DiagnosticIssue, LiveDiagnostics } from "./types.ts";

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrDefault(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function emptyDiagnosticConfig(): DiagnosticConfig {
    return {
        healthUrl: null,
        statusUrl: null,
        errorsUrl: null,
        timeoutMs: 1000,
    };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function parseDiagnosticConfig(raw: string): DiagnosticConfig {
    const parsed = JSON.parse(raw) as unknown;
    const root = recordOrNull(parsed);
    if (!root) return emptyDiagnosticConfig();

    const diagnostics = recordOrNull(root.diagnostics) ?? {};
    return {
        healthUrl: stringOrNull(diagnostics.healthUrl),
        statusUrl: stringOrNull(diagnostics.statusUrl),
        errorsUrl: stringOrNull(diagnostics.errorsUrl),
        timeoutMs: numberOrDefault(diagnostics.timeoutMs, 1000),
    };
}

export const loadDiagnosticConfig = (root: string | null): Effect.Effect<DiagnosticConfig | null, string> =>
    Effect.gen(function* () {
        if (!root) return null;
        const path = join(root, ".agentctl", "config.json");
        if (!existsSync(path)) return null;
        const raw = yield* Effect.tryPromise({
            try: () => readFile(path, "utf8"),
            catch: (error) => String(error),
        });
        return yield* Effect.try({
            try: () => parseDiagnosticConfig(raw),
            catch: (error) => String(error),
        });
    });

function severity(value: unknown): DiagnosticIssue["severity"] {
    return value === "critical" || value === "warning" || value === "info" ? value : "info";
}

export function normalizeDiagnosticIssue(value: unknown): DiagnosticIssue {
    const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
        severity: severity(row.severity),
        title: typeof row.title === "string" ? row.title : "Diagnostic issue",
        detail: typeof row.detail === "string" ? row.detail : "",
        suggestedAction: stringOrNull(row.suggestedAction),
        traceId: stringOrNull(row.traceId),
        service: stringOrNull(row.service),
    };
}

function statusFromPayload(value: unknown): LiveDiagnostics["status"] {
    if (!value || typeof value !== "object") return "unknown";
    const row = value as Record<string, unknown>;
    const status = row.status;
    if (status === "green" || status === "yellow" || status === "red") return status;
    return "unknown";
}

function issuesFromPayload(value: unknown): ReadonlyArray<DiagnosticIssue> {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const issues = Array.isArray(row.issues) ? row.issues : [];
    return issues.map(normalizeDiagnosticIssue);
}

function localUrlsFromPayload(value: unknown): ReadonlyArray<string> {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const urls = row.localUrls;
    return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string") : [];
}

const emptyDiagnostics = (configured: boolean, error: string | null): LiveDiagnostics => ({
    configured,
    available: false,
    source: null,
    status: "unknown",
    issues: [],
    localUrls: [],
    checkedAt: new Date().toISOString(),
    error,
});

export const queryLiveDiagnostics = (root: string | null): Effect.Effect<LiveDiagnostics> =>
    Effect.gen(function* () {
        const configResult = yield* loadDiagnosticConfig(root).pipe(
            Effect.match({
                onFailure: (error) => ({ _tag: "Error" as const, error }),
                onSuccess: (config) => ({ _tag: "Success" as const, config }),
            }),
        );
        if (configResult._tag === "Error") return emptyDiagnostics(true, configResult.error);

        const config = configResult.config;
        if (!config || !config.healthUrl) return emptyDiagnostics(false, null);

        const result = yield* Effect.tryPromise({
            try: async () => {
                const response = await fetch(config.healthUrl!, {
                    signal: AbortSignal.timeout(config.timeoutMs),
                });
                if (!response.ok) throw new Error(`diagnostics returned HTTP ${response.status}`);
                return (await response.json()) as unknown;
            },
            catch: (error) => String(error),
        }).pipe(
            Effect.match({
                onFailure: (error) => emptyDiagnostics(true, error),
                onSuccess: (payload): LiveDiagnostics => ({
                    configured: true,
                    available: true,
                    source: config.healthUrl,
                    status: statusFromPayload(payload),
                    issues: issuesFromPayload(payload),
                    localUrls: localUrlsFromPayload(payload),
                    checkedAt: new Date().toISOString(),
                    error: null,
                }),
            }),
        );

        return result;
    });
