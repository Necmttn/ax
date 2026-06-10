import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Redacted } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { AxConfig, AxConfigTest, envSnapshot, makeTestConfig } from "./config.ts";

const run = <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem>) =>
    Effect.runPromise(eff.pipe(Effect.provide(BunFileSystem.layer)));

describe("AxConfig", () => {
    test("envSnapshot honors env overrides", async () => {
        const snap = await run(envSnapshot({
            AX_DB_URL: "ws://example:9999",
            AX_DB_NS: "ns-x",
            AX_CODEX_CONCURRENCY: "4",
            AX_CLAUDE_CONCURRENCY: "8",
            HOME: "/tmp/home",
        }));
        expect(snap.db.url).toBe("ws://example:9999");
        expect(snap.db.ns).toBe("ns-x");
        expect(snap.knobs.codexConcurrency).toBe(4);
        expect(snap.knobs.claudeConcurrency).toBe(8);
        expect(snap.paths.transcriptsDir).toBe("/tmp/home/.claude/projects");
        expect(snap.paths.piDir).toBe("/tmp/home/.pi/agent/sessions");
        expect(snap.paths.opencodeDir).toBe("/tmp/home/.local/share/opencode");
        expect(snap.paths.cursorUserDir).toBe("/tmp/home/Library/Application Support/Cursor/User");
    });

    test("envSnapshot honors local agent provider path overrides", async () => {
        const snap = await run(envSnapshot({
            HOME: "/tmp/home",
            AX_PI_DIR: "/tmp/pi-sessions",
            AX_OPENCODE_DIR: "/tmp/opencode",
            AX_CURSOR_USER_DIR: "/tmp/cursor-user",
        }));
        expect(snap.paths.piDir).toBe("/tmp/pi-sessions");
        expect(snap.paths.opencodeDir).toBe("/tmp/opencode");
        expect(snap.paths.cursorUserDir).toBe("/tmp/cursor-user");
    });

    test("envSnapshot falls back to defaults", async () => {
        const snap = await run(envSnapshot({ HOME: "/tmp/home" }));
        expect(snap.db.url).toBe("ws://127.0.0.1:8521");
        expect(snap.db.ns).toBe("ax");
        expect(snap.knobs.claudeConcurrency).toBe(4);
        expect(snap.knobs.codexConcurrency).toBe(1);
        expect(snap.paths.piDir).toBe("/tmp/home/.pi/agent/sessions");
        expect(snap.paths.opencodeDir).toBe("/tmp/home/.local/share/opencode");
        expect(snap.paths.cursorUserDir).toBe("/tmp/home/Library/Application Support/Cursor/User");
    });

    test("envSnapshot ignores invalid numeric knobs", async () => {
        const snap = await run(envSnapshot({
            AX_CODEX_CONCURRENCY: "nope",
            AX_CODEX_PAYLOAD_MAX_BYTES: "-5",
        }));
        expect(snap.knobs.codexConcurrency).toBe(1);
        expect(snap.knobs.codexPayloadMaxBytes).toBe(1200);
    });

    test("envSnapshot parses csv dirs: trims entries, drops empties, missing -> []", async () => {
        const snap = await run(envSnapshot({
            HOME: "/tmp/home",
            AX_SKILLS_DIRS: " /a , /b ,, /c ",
        }));
        expect(snap.paths.skillDirs).toEqual(["/a", "/b", "/c"]);
        expect(snap.paths.commandDirs).toEqual([]);
    });

    test("db.pass is redacted: never leaks via toString, unwraps via Redacted.value", async () => {
        const snap = await run(envSnapshot({ HOME: "/tmp/home", AX_DB_PASS: "s3cret" }));
        expect(String(snap.db.pass)).not.toContain("s3cret");
        expect(`${snap.db.pass}`).not.toContain("s3cret");
        expect(Redacted.value(snap.db.pass)).toBe("s3cret");

        const dflt = await run(envSnapshot({ HOME: "/tmp/home" }));
        expect(Redacted.value(dflt.db.pass)).toBe("root");
    });

    test("AxConfigTest layer provides overridden values", async () => {
        const program = Effect.gen(function* () {
            const cfg = yield* AxConfig;
            return cfg.db.url;
        });
        const url = await Effect.runPromise(
            program.pipe(
                // AxConfigTest now needs FileSystem to build its base snapshot;
                // provide both in one merged Layer (single `Effect.provide`).
                Effect.provide(
                    AxConfigTest({ db: { url: "ws://test:1234" } as never }).pipe(
                        Layer.provide(BunFileSystem.layer),
                    ),
                ),
            ),
        );
        expect(url).toBe("ws://test:1234");
    });

    test("makeTestConfig deep-merges overrides", async () => {
        const cfg = await run(makeTestConfig({ knobs: { claudeConcurrency: 16 } as never }));
        expect(cfg.knobs.claudeConcurrency).toBe(16);
        expect(cfg.knobs.codexConcurrency).toBe(1);
        expect(cfg.db.url).toBe("ws://127.0.0.1:8521");
    });
});
