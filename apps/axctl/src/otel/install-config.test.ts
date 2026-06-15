import { describe, expect, test } from "bun:test";
import { applyClaudeOtelEnv, applyCodexOtelToml } from "./install-config.ts";

const ENDPOINT = "http://127.0.0.1:1738";

describe("install-config", () => {
    test("adds CC telemetry env to empty settings", () => {
        const next = applyClaudeOtelEnv({}, ENDPOINT);
        expect(next.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
        expect(next.env.OTEL_METRICS_EXPORTER).toBe("otlp");
        expect(next.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
        expect(next.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(ENDPOINT);
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

    test("codex toml gains an [otel] block with the endpoint", () => {
        const toml = applyCodexOtelToml("", ENDPOINT);
        expect(toml).toContain("[otel]");
        expect(toml).toContain(ENDPOINT);
        expect(toml).toContain("http/json");
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
