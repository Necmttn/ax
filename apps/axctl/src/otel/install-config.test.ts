import { describe, expect, test } from "bun:test";
import { applyClaudeOtelEnv, applyClaudeTraceOtelEnv, applyCodexOtelToml, detectClaudeOtelReplacements } from "./install-config.ts";

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

    // Codex rewrites config.toml itself (project trust, hooks.state, marketplaces)
    // and when it does it drops comments and normalizes our inline exporter into
    // an `[otel.exporter.otlp-http]` table. Our marker is gone, so a naive
    // "marker missing → append" appends a SECOND definition of otel.exporter and
    // codex dies at boot with `duplicate key`, breaking every codex command.
    const NORMALIZED = [
        `model = "gpt-5"`,
        ``,
        `[otel.exporter.otlp-http]`,
        `endpoint = "${ENDPOINT}/v1/logs"`,
        `protocol = "json"`,
        ``,
        `[tui]`,
        `notifications = true`,
        ``,
    ].join("\n");

    // Bun's TOML parser rejects a redefined key the same way codex's loader does
    // ("Cannot redefine key 'exporter'"), so parsing IS the duplicate-key assertion.
    const parseToml = (toml: string): Record<string, unknown> =>
        Bun.TOML.parse(toml) as Record<string, unknown>;

    test("codex toml leaves a codex-normalized exporter table alone (no duplicate key)", () => {
        const next = applyCodexOtelToml(NORMALIZED, ENDPOINT);
        expect(next).toBe(NORMALIZED); // already correct - nothing to do
        parseToml(next); // throws on duplicate key
    });

    test("codex toml retargets a normalized exporter table in place", () => {
        const stale = NORMALIZED.replace(`${ENDPOINT}/v1/logs`, "http://127.0.0.1:9999/v1/logs");
        const next = applyCodexOtelToml(stale, ENDPOINT);
        const cfg = parseToml(next) as {
            otel: { exporter: { "otlp-http": { endpoint: string; protocol: string } } };
            tui: { notifications: boolean };
        };
        expect(cfg.otel.exporter["otlp-http"].endpoint).toBe(`${ENDPOINT}/v1/logs`);
        expect(cfg.otel.exporter["otlp-http"].protocol).toBe("json");
        expect(cfg.tui.notifications).toBe(true); // later sections survive
        expect(next).not.toContain("9999");
        // Exactly one definition of the exporter, however it is spelled.
        expect(next.match(/\[otel\.exporter|exporter = \{/g)?.length).toBe(1);
    });

    test("codex toml adds the exporter to an existing [otel] table without clobbering its keys", () => {
        const existing = `[otel]\nlog_user_prompt = true\nenvironment = "dev"\n`;
        const next = applyCodexOtelToml(existing, ENDPOINT);
        const cfg = parseToml(next) as {
            otel: {
                log_user_prompt: boolean;
                environment: string;
                exporter: { "otlp-http": { endpoint: string } };
            };
        };
        expect(cfg.otel.log_user_prompt).toBe(true); // user's own otel keys kept
        expect(cfg.otel.environment).toBe("dev");
        expect(cfg.otel.exporter["otlp-http"].endpoint).toBe(`${ENDPOINT}/v1/logs`);
    });

    test("codex toml repairs a config already broken by the duplicate", () => {
        // What a machine hit by the old bug looks like: codex's normalized table
        // AND an appended ax block. Codex cannot start until one of them goes.
        const broken = `${NORMALIZED}\n# ax:otel\n[otel]\nexporter = { otlp-http = { endpoint = "${ENDPOINT}/v1/logs", protocol = "json" } }\n`;
        expect(() => parseToml(broken)).toThrow(); // precondition: genuinely broken
        const next = applyCodexOtelToml(broken, ENDPOINT);
        const cfg = parseToml(next) as {
            otel: { exporter: { "otlp-http": { endpoint: string } } };
            tui: { notifications: boolean };
        };
        expect(cfg.otel.exporter["otlp-http"].endpoint).toBe(`${ENDPOINT}/v1/logs`);
        expect(cfg.tui.notifications).toBe(true);
        expect(next).not.toContain("# ax:otel"); // the appended block is what goes
    });

    test("codex toml applied twice over a codex rewrite stays valid", () => {
        // Full round trip of the real failure: we write, codex normalizes and
        // strips the comment, we run install again.
        const ours = applyCodexOtelToml(`model = "gpt-5"\n`, ENDPOINT);
        expect(ours).toContain("# ax:otel");
        const afterCodexRewrite = NORMALIZED; // what codex leaves behind
        const again = applyCodexOtelToml(afterCodexRewrite, ENDPOINT);
        parseToml(again);
        expect(again.match(/\[otel\.exporter|exporter = \{/g)?.length).toBe(1);
    });

    // #1014: ax install used to overwrite a user's OTLP endpoint silently.
    // detectClaudeOtelReplacements is what makes the takeover visible.
    describe("detectClaudeOtelReplacements (#1014)", () => {
        test("reports a foreign logs endpoint + its protocol", () => {
            const reps = detectClaudeOtelReplacements({
                env: {
                    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://otlp.datadoghq.com/v1/logs",
                    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
                },
            }, ENDPOINT);
            const byKey = Object.fromEntries(reps.map((r) => [r.key, r]));
            expect(byKey.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.previous).toBe("https://otlp.datadoghq.com/v1/logs");
            expect(byKey.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.next).toBe(`${ENDPOINT}/v1/logs`);
            expect(byKey.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL.previous).toBe("http/protobuf");
        });

        test("reports the generic endpoint too when it is foreign", () => {
            const reps = detectClaudeOtelReplacements({
                env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.corp.internal:4318" },
            }, ENDPOINT);
            expect(reps.map((r) => r.key)).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
        });

        test("empty when nothing was configured before", () => {
            expect(detectClaudeOtelReplacements({}, ENDPOINT)).toEqual([]);
            expect(detectClaudeOtelReplacements({ env: {} }, ENDPOINT)).toEqual([]);
        });

        test("empty when the prior value is already ax (idempotent re-install)", () => {
            const already = applyClaudeOtelEnv({}, ENDPOINT);
            expect(detectClaudeOtelReplacements(already, ENDPOINT)).toEqual([]);
        });

        test("localhost and 127.0.0.1 on any port are treated as ax, not foreign", () => {
            expect(detectClaudeOtelReplacements({
                env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://localhost:4318/v1/logs" },
            }, ENDPOINT)).toEqual([]);
            expect(detectClaudeOtelReplacements({
                env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9999" },
            }, ENDPOINT)).toEqual([]);
        });

        test("a lone protocol difference on a loopback endpoint is not a takeover", () => {
            // No foreign ENDPOINT key → nothing to report, even if a protocol differs.
            expect(detectClaudeOtelReplacements({
                env: {
                    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1738",
                    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
                },
            }, ENDPOINT)).toEqual([]);
        });

        test("ignores blank/whitespace prior values", () => {
            expect(detectClaudeOtelReplacements({
                env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "   " },
            }, ENDPOINT)).toEqual([]);
        });
    });
});
