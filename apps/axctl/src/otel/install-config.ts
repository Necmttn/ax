interface ClaudeSettings { env?: Record<string, string>; [k: string]: unknown }

const trimEndpoint = (endpoint: string): string => endpoint.replace(/\/+$/, "");

const CC_ENV = (endpoint: string): Record<string, string> => {
    const base = trimEndpoint(endpoint);
    return {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: base,
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${base}/v1/logs`,
    };
};

const CC_TRACE_ENV = (endpoint: string): Record<string, string> => {
    const base = trimEndpoint(endpoint);
    return {
        CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/v1/traces`,
    };
};

/** Merge ax's telemetry env into Claude settings, preserving everything else. */
export const applyClaudeOtelEnv = (
    settings: ClaudeSettings,
    endpoint: string,
): ClaudeSettings & { env: Record<string, string> } => {
    const env = { ...(settings.env ?? {}), ...CC_ENV(endpoint) };
    return { ...settings, env };
};

/**
 * One OTLP env key ax overwrote whose PRIOR value pointed at a foreign
 * (non-ax) collector.
 */
export interface OtelEnvReplacement {
    readonly key: string;
    readonly previous: string;
    readonly next: string;
}

// The destination + protocol env keys `CC_ENV` writes. Switch keys
// (CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_*_EXPORTER) carry no target, so
// overwriting them is never a "takeover" worth reporting.
const OWNED_ENDPOINT_KEYS = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
] as const;
const OWNED_PROTOCOL_KEYS = [
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
] as const;

// ax's receiver is always a loopback host; a prior value on loopback is a
// stale ax install, not a user's collector - never report it as foreign.
const AX_LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

const isForeignEndpoint = (value: string | undefined, next: string): boolean =>
    typeof value === "string" &&
    value.trim() !== "" &&
    value !== next &&
    !AX_LOOPBACK_RE.test(value.trim());

/**
 * Detect the pre-existing FOREIGN OTLP destinations that {@link applyClaudeOtelEnv}
 * would silently overwrite (#1014). `applyClaudeOtelEnv` still redirects the
 * harness at ax's receiver - the caller uses this report to PRESERVE the old
 * value and TELL the user, instead of a silent takeover.
 *
 * Only fires when at least one ENDPOINT key points somewhere non-ax: a lone
 * protocol flip on a loopback endpoint is a no-op re-install, not a takeover.
 * Idempotent - re-running install on an ax-configured machine reports nothing.
 */
export const detectClaudeOtelReplacements = (
    settings: ClaudeSettings,
    endpoint: string,
): OtelEnvReplacement[] => {
    const prev = settings.env ?? {};
    const next = CC_ENV(endpoint);
    const foreignEndpoints = OWNED_ENDPOINT_KEYS.filter((k) => isForeignEndpoint(prev[k], next[k]));
    if (foreignEndpoints.length === 0) return [];
    const foreignProtocols = OWNED_PROTOCOL_KEYS.filter((k) => {
        const v = prev[k];
        return typeof v === "string" && v.trim() !== "" && v !== next[k];
    });
    return [...foreignEndpoints, ...foreignProtocols].map((k) => ({
        key: k,
        previous: prev[k] as string,
        next: next[k],
    }));
};

/** Add Claude trace export env. This is intentionally separate and opt-in. */
export const applyClaudeTraceOtelEnv = (
    settings: ClaudeSettings,
    endpoint: string,
): ClaudeSettings & { env: Record<string, string> } => {
    const env = {
        ...(settings.env ?? {}),
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        ...CC_TRACE_ENV(endpoint),
    };
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
const logsEndpoint = (endpoint: string): string => `${endpoint.replace(/\/+$/, "")}/v1/logs`;
const exporterKeyLine = (endpoint: string): string =>
    `exporter = { otlp-http = { endpoint = "${logsEndpoint(endpoint)}", protocol = "json" } }`;
const codexBlock = (endpoint: string): string =>
    `${CODEX_MARKER}\n[otel]\n${exporterKeyLine(endpoint)}\n`;

// Matches the ax-owned marker + [otel] block until the next [section] header
// (that is NOT [otel] itself) or end-of-string. The `?=\n\[(?!otel])` lookahead
// stops before any subsequent section without consuming it.
const CODEX_BLOCK_RE = (): RegExp =>
    new RegExp(`${CODEX_MARKER}[\\s\\S]*?(?=\\n\\[(?!otel])|$)`, "g");

const SECTION_HEADER = /^\s*\[\[?([^\][]+)\]\]?\s*$/;

interface Header { name: string; line: number }

const headersOf = (lines: readonly string[]): Header[] => {
    const out: Header[] = [];
    lines.forEach((line, i) => {
        const name = line.match(SECTION_HEADER)?.[1]?.trim();
        if (name) out.push({ name, line: i });
    });
    return out;
};

/**
 * Write ax's OTLP exporter into codex config.toml WITHOUT ever defining
 * `otel.exporter` twice.
 *
 * Why this is not a simple append: codex rewrites config.toml itself (project
 * trust entries, hooks.state, marketplaces) and when it does it drops comments
 * - our `# ax:otel` marker included - and re-serializes our inline exporter as
 * an `[otel.exporter.otlp-http]` table. A marker-only check then sees "no ax
 * block" and appends a second definition, TOML rejects the duplicate key, and
 * codex dies at startup before the TUI boots, taking every codex command and
 * every fleet pane with it. So detect the exporter by SHAPE, not by marker, and
 * update whatever is already there in place.
 */
export const applyCodexOtelToml = (toml: string, endpoint: string): string => {
    const lines = toml.split("\n");
    const headers = headersOf(lines);
    const ownerOf = (line: number): string | undefined =>
        headers.reduce<string | undefined>((own, h) => (h.line < line ? h.name : own), undefined);

    // Shape A: an inline `exporter = { ... }` key - ours, or a root-level
    // `otel.exporter = { ... }` dotted key. Rewrite the one line, keeping any
    // sibling keys (and the marker comment, if it survived) untouched.
    const inline = lines.findIndex((line, i) =>
        /^\s*otel\s*\.\s*exporter\s*=/.test(line) ||
        (/^\s*exporter\s*=/.test(line) && ownerOf(i) === "otel"));
    const normalizedTable = headers.some((h) => h.name.startsWith("otel.exporter"));

    // Both shapes present: a config already broken by the old append-on-missing-
    // marker bug, which codex refuses to load at all. Drop the ax-owned block and
    // fall through to updating the table codex itself wrote.
    if (inline >= 0 && normalizedTable && toml.includes(CODEX_MARKER)) {
        return applyCodexOtelToml(toml.replace(CODEX_BLOCK_RE(), "").trimEnd() + "\n", endpoint);
    }

    if (inline >= 0) {
        const dotted = /^\s*otel\s*\./.test(lines[inline] ?? "");
        const next = dotted ? `otel.${exporterKeyLine(endpoint)}` : exporterKeyLine(endpoint);
        if (lines[inline] === next) return toml;
        lines[inline] = next;
        return lines.join("\n");
    }

    // Shape B: codex's normalized `[otel.exporter.<kind>]` table.
    const tableIdx = headers.findIndex((h) => h.name === "otel.exporter" || h.name.startsWith("otel.exporter."));
    const table = headers[tableIdx];
    if (table) {
        // A deliberately different exporter kind (otlp-grpc, none). Retargeting
        // it would be wrong and appending would duplicate - leave it alone.
        if (table.name !== "otel.exporter.otlp-http") return toml;
        const end = headers[tableIdx + 1]?.line ?? lines.length;
        const want = { endpoint: `endpoint = "${logsEndpoint(endpoint)}"`, protocol: `protocol = "json"` };
        const seen = { endpoint: false, protocol: false };
        let changed = false;
        for (let i = table.line + 1; i < end; i++) {
            const key = (["endpoint", "protocol"] as const).find((k) =>
                new RegExp(`^\\s*${k}\\s*=`).test(lines[i] ?? ""));
            if (!key) continue;
            seen[key] = true;
            if (lines[i] === want[key]) continue;
            lines[i] = want[key];
            changed = true;
        }
        const missing = (["endpoint", "protocol"] as const).filter((k) => !seen[k]).map((k) => want[k]);
        if (missing.length > 0) {
            lines.splice(table.line + 1, 0, ...missing);
            changed = true;
        }
        return changed ? lines.join("\n") : toml;
    }

    // An `[otel]` table with other keys (log_user_prompt, environment, ...) but
    // no exporter: add the key to it rather than opening a second [otel].
    const otelTable = headers.find((h) => h.name === "otel");
    if (otelTable) {
        lines.splice(otelTable.line + 1, 0, exporterKeyLine(endpoint));
        return lines.join("\n");
    }

    // No otel config at all - append the ax-owned block (dropping any stale
    // marker whose body we could not recognise).
    const stripped = (toml.includes(CODEX_MARKER) ? toml.replace(CODEX_BLOCK_RE(), "") : toml).trimEnd();
    return (stripped ? `${stripped}\n\n` : "") + codexBlock(endpoint);
};
