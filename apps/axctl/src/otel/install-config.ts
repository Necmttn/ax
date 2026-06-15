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
const codexBlock = (endpoint: string): string =>
    `${CODEX_MARKER}\n[otel]\nexporter = "otlp-http"\nendpoint = "${endpoint}"\nprotocol = "http/json"\n`;

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
