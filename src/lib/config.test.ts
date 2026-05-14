import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AgentctlConfig, AgentctlConfigTest, envSnapshot, makeTestConfig } from "./config.ts";

describe("AgentctlConfig", () => {
    test("envSnapshot honors env overrides", () => {
        const snap = envSnapshot({
            AX_DB_URL: "ws://example:9999",
            AX_DB_NS: "ns-x",
            AX_CODEX_CONCURRENCY: "4",
            AX_CLAUDE_CONCURRENCY: "8",
            HOME: "/tmp/home",
        });
        expect(snap.db.url).toBe("ws://example:9999");
        expect(snap.db.ns).toBe("ns-x");
        expect(snap.knobs.codexConcurrency).toBe(4);
        expect(snap.knobs.claudeConcurrency).toBe(8);
        expect(snap.paths.transcriptsDir).toBe("/tmp/home/.claude/projects");
    });

    test("envSnapshot falls back to defaults", () => {
        const snap = envSnapshot({ HOME: "/tmp/home" });
        expect(snap.db.url).toBe("ws://127.0.0.1:8521");
        expect(snap.db.ns).toBe("ax");
        expect(snap.knobs.claudeConcurrency).toBe(4);
        expect(snap.knobs.codexConcurrency).toBe(1);
    });

    test("envSnapshot ignores invalid numeric knobs", () => {
        const snap = envSnapshot({
            AX_CODEX_CONCURRENCY: "nope",
            AX_CODEX_PAYLOAD_MAX_BYTES: "-5",
        });
        expect(snap.knobs.codexConcurrency).toBe(1);
        expect(snap.knobs.codexPayloadMaxBytes).toBe(1200);
    });

    test("AgentctlConfigTest layer provides overridden values", async () => {
        const program = Effect.gen(function* () {
            const cfg = yield* AgentctlConfig;
            return cfg.db.url;
        });
        const url = await Effect.runPromise(
            program.pipe(
                Effect.provide(AgentctlConfigTest({ db: { url: "ws://test:1234" } as never })),
            ),
        );
        expect(url).toBe("ws://test:1234");
    });

    test("makeTestConfig deep-merges overrides", () => {
        const cfg = makeTestConfig({ knobs: { claudeConcurrency: 16 } as never });
        expect(cfg.knobs.claudeConcurrency).toBe(16);
        expect(cfg.knobs.codexConcurrency).toBe(1);
        expect(cfg.db.url).toBe("ws://127.0.0.1:8521");
    });
});
