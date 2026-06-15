interface ClaudeSettings { env?: Record<string, string>; [k: string]: unknown }

const CC_ENV = (endpoint: string): Record<string, string> => ({
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
});

/** Merge ax's telemetry env into Claude settings, preserving everything else. */
export const applyClaudeOtelEnv = (
    settings: ClaudeSettings,
    endpoint: string,
): ClaudeSettings & { env: Record<string, string> } => {
    const env = { ...(settings.env ?? {}), ...CC_ENV(endpoint) };
    return { ...settings, env };
};

const CODEX_MARKER = "# ax:otel";
/**
 * Codex's `[otel]` schema differs from Claude's env-based config in three ways
 * (all learned the hard way against a live Codex):
 *   1. `exporter` is a STRUCT-VARIANT enum - a bare string (`"otlp-http"`) is
 *      parsed as a unit variant and fails config load, breaking ALL codex
 *      commands. It must be `exporter = { otlp-http = { ... } }`.
 *   2. The otlp-http exporter POSTs to the endpoint AS-IS (it does NOT append
 *      `/v1/<signal>`), and Codex emits OTLP *logs* (events: conversation_starts,
 *      user_prompt, token usage...), not spans. So the endpoint must carry the
 *      full `/v1/logs` path - that is where ax's receiver takes Codex telemetry.
 *   3. `protocol` is Codex's own value `"json"` (not OTEL env's `"http/json"`).
 */
const codexBlock = (endpoint: string): string => {
    const logsEndpoint = `${endpoint.replace(/\/+$/, "")}/v1/logs`;
    return `${CODEX_MARKER}\n[otel]\nexporter = { otlp-http = { endpoint = "${logsEndpoint}", protocol = "json" } }\n`;
};

// Matches the ax-owned marker + [otel] block until the next [section] header
// (that is NOT [otel] itself) or end-of-string. The `?=\n\[(?!otel])` lookahead
// stops before any subsequent section without consuming it.
const CODEX_BLOCK_RE = (): RegExp =>
    new RegExp(`${CODEX_MARKER}[\\s\\S]*?(?=\\n\\[(?!otel])|$)`, "g");

/** Append/replace the ax-owned [otel] block in codex config.toml. */
export const applyCodexOtelToml = (toml: string, endpoint: string): string => {
    const block = codexBlock(endpoint);
    if (toml.includes(CODEX_MARKER)) {
        // Check if the existing block matches what we'd write (idempotency).
        const existingMatch = toml.match(CODEX_BLOCK_RE());
        if (existingMatch && block.trimEnd() === existingMatch[0].trimEnd()) return toml;
        // Strip prior ax-owned block, then append fresh.
        const stripped = toml.replace(CODEX_BLOCK_RE(), "").trimEnd();
        return (stripped ? `${stripped}\n\n` : "") + block;
    }
    const stripped = toml.trimEnd();
    return (stripped ? `${stripped}\n\n` : "") + block;
};
