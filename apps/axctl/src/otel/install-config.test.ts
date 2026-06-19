import { describe, expect, test } from "bun:test";
import { applyClaudeOtelEnv, applyClaudeTraceOtelEnv, applyCodexOtelToml } from "./install-config.ts";

const ENDPOINT = "http://127.0.0.1:1738";

describe("install-config", () => {
    test("adds CC telemetry env to empty settings", () => {
        const next = applyClaudeOtelEnv({}, ENDPOINT);
        expect(next.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
        expect(next.env.OTEL_METRICS_EXPORTER).toBe("otlp");
        expect(next.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
        expect(next.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(ENDPOINT);
    });

    test("adds CC OTLP logs env without sensitive content flags", () => {
        const next = applyClaudeOtelEnv({}, `${ENDPOINT}/`);
        expect(next.env.OTEL_LOGS_EXPORTER).toBe("otlp");
        expect(next.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe("http/json");
        expect(next.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`${ENDPOINT}/v1/logs`);
        expect(next.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(ENDPOINT);
        expect(next.env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
        expect(next.env.OTEL_LOG_TOOL_CONTENT).toBeUndefined();
        expect(next.env.OTEL_LOG_RAW_API_BODIES).toBeUndefined();
    });

    test("is idempotent - re-apply yields equal object", () => {
        const once = applyClaudeOtelEnv({}, ENDPOINT);
        const twice = applyClaudeOtelEnv(once, ENDPOINT);
        expect(twice).toEqual(once);
    });

    test("preserves unrelated existing env", () => {
        const next = applyClaudeOtelEnv({ env: { FOO: "bar" } }, ENDPOINT);
        expect(next.env.FOO).toBe("bar");
    });

    test("adds optional CC trace env only when explicitly applied", () => {
        const logsOnly = applyClaudeOtelEnv({}, ENDPOINT);
        expect(logsOnly.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBeUndefined();
        expect(logsOnly.env.OTEL_TRACES_EXPORTER).toBeUndefined();

        const next = applyClaudeTraceOtelEnv(logsOnly, `${ENDPOINT}/`);
        expect(next.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
        expect(next.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe("1");
        expect(next.env.OTEL_TRACES_EXPORTER).toBe("otlp");
        expect(next.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL).toBe("http/json");
        expect(next.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(`${ENDPOINT}/v1/traces`);
        expect(next.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(ENDPOINT);
        expect(next.env.OTEL_LOG_RAW_API_BODIES).toBeUndefined();
    });

    test("trace opt-in preserves explicit log and metric env overrides", () => {
        const next = applyClaudeTraceOtelEnv({
            env: {
                OTEL_LOGS_EXPORTER: "none",
                OTEL_METRICS_EXPORTER: "none",
                OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.local:4318",
            },
        }, ENDPOINT);

        expect(next.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
        expect(next.env.OTEL_LOGS_EXPORTER).toBe("none");
        expect(next.env.OTEL_METRICS_EXPORTER).toBe("none");
        expect(next.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://collector.local:4318");
        expect(next.env.OTEL_TRACES_EXPORTER).toBe("otlp");
        expect(next.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(`${ENDPOINT}/v1/traces`);
    });

    test("codex toml writes the struct-variant exporter (NOT a bare string)", () => {
        const toml = applyCodexOtelToml("", ENDPOINT);
        expect(toml).toContain("[otel]");
        // The bug this guards: `exporter = "otlp-http"` is a unit variant and
        // fails Codex config load, breaking every codex command. It MUST be a
        // struct variant.
        expect(toml).toContain("exporter = { otlp-http = {");
        expect(toml).not.toContain(`exporter = "otlp-http"`);
        // Codex posts as-is + emits logs → endpoint carries the /v1/logs path.
        expect(toml).toContain(`endpoint = "${ENDPOINT}/v1/logs"`);
        // Codex's protocol value is "json" (not OTEL env's "http/json").
        expect(toml).toContain(`protocol = "json"`);
        expect(toml).not.toContain("http/json");
    });

    test("codex toml is valid TOML and parses to the expected shape", async () => {
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const toml = applyCodexOtelToml(`model = "gpt-5"\n`, ENDPOINT);
        // Bun parses .toml on import; an invalid struct (the old bug) throws here.
        const file = join(tmpdir(), `ax-codex-otel-${process.pid}-${Math.trunc(performance.now())}.toml`);
        await Bun.write(file, toml);
        const cfg = (await import(file)).default as {
            model: string;
            otel: { exporter: { "otlp-http": { endpoint: string; protocol: string } } };
        };
        expect(cfg.model).toBe("gpt-5"); // unrelated content preserved
        expect(cfg.otel.exporter["otlp-http"].endpoint).toBe(`${ENDPOINT}/v1/logs`);
        expect(cfg.otel.exporter["otlp-http"].protocol).toBe("json");
    });

    test("codex toml is idempotent", () => {
        const once = applyCodexOtelToml("", ENDPOINT);
        expect(applyCodexOtelToml(once, ENDPOINT)).toBe(once);
    });

    test("codex toml preserves existing unrelated content", () => {
        const existing = `model = "gpt-5"\n`;
        const next = applyCodexOtelToml(existing, ENDPOINT);
        expect(next).toContain(`model = "gpt-5"`);
        expect(next).toContain("[otel]");
    });
});
