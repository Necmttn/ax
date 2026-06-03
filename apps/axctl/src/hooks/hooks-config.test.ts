import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { SurrealClient } from "@ax/lib/db";
import { claudeProvider } from "./providers/claude.ts";
import { cursorProvider } from "./providers/cursor.ts";
import { codexProvider } from "./providers/codex.ts";
import { opencodeProvider, joinArgv, wrapArgv } from "./providers/opencode.ts";
import { HookProviderRegistry, HookProviderRegistryDefault, HookProviderRegistryLive, ALL_HOOK_PROVIDERS } from "./providers/registry.ts";
import { deriveHookId, deriveOwner, axMarkerId, embedMarker } from "./providers/ownership.ts";
import {
    readAllHooks,
    addHook,
    removeHook,
    editHook,
    disableHook,
    enableHook,
} from "./config.ts";
import type { HookFileRef } from "./providers/types.ts";

/** Run a no-requirements (pure-ish) provider Effect to a value. Failures throw. */
const runPure = <A, E>(eff: Effect.Effect<A, E>): A => Effect.runSync(eff as Effect.Effect<A, never>);

const ref = (path: string, scope: "global" | "project" | "local", format: "json" | "toml" = "json"): HookFileRef => ({ path, scope, format });

// ---------------------------------------------------------------------------
// ownership / id stability
// ---------------------------------------------------------------------------
describe("ownership", () => {
    test("marker id wins over content hash and is stable", () => {
        const command = "bash run.sh # ax:abc12345";
        expect(axMarkerId(command)).toBe("abc12345");
        const id = deriveHookId({ provider: "claude", scope: "global", file: "/x", event: "PreToolUse", matcher: null, command });
        expect(id).toBe("abc12345");
    });

    test("content hash is deterministic and 8 chars when no marker", () => {
        const input = { provider: "claude", scope: "global" as const, file: "/x", event: "PreToolUse", matcher: "Bash", command: "echo hi" };
        const a = deriveHookId(input);
        const b = deriveHookId(input);
        expect(a).toBe(b);
        expect(a).toHaveLength(8);
    });

    test("owner heuristic", () => {
        expect(deriveOwner("axctl ingest")).toBe("ax");
        expect(deriveOwner("echo x # ax:zz")).toBe("ax");
        expect(deriveOwner("gsd-state save")).toBe("gsd");
        expect(deriveOwner("SUPERSET_HOME_DIR=/x foo")).toBe("superset");
        expect(deriveOwner("echo hello")).toBe("you");
    });

    test("embedMarker is idempotent", () => {
        const once = embedMarker("echo x", "id123456");
        expect(once).toBe("echo x # ax:id123456");
        expect(embedMarker(once, "different")).toBe(once);
    });
});

// ---------------------------------------------------------------------------
// claude provider
// ---------------------------------------------------------------------------
describe("claude provider", () => {
    const r = ref("/Users/x/.claude/settings.json", "global");

    test("parse flattens nested matcher groups", () => {
        const raw = JSON.stringify({
            hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo a", timeout: 5 }] }] },
        });
        const rows = runPure(claudeProvider.parse(r, raw));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.event).toBe("PreToolUse");
        expect(rows[0]!.matcher).toBe("Bash");
        expect(rows[0]!.command).toBe("echo a");
        expect(rows[0]!.timeout).toBe(5);
    });

    test("add -> parse round-trip embeds a marker and the row is ax-owned", () => {
        const next = runPure(claudeProvider.applyAdd(r, "", { event: "PreToolUse", matcher: "Bash", command: "echo hi" }));
        const rows = runPure(claudeProvider.parse(r, next));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.owner).toBe("ax");
        expect(rows[0]!.axId).toBeDefined();
        expect(rows[0]!.command).toContain("# ax:");
    });

    test("edit command preserves the ax marker so the id stays stable", () => {
        // regression: edit used to drop the marker -> id churned -> remove broke.
        const added = runPure(claudeProvider.applyAdd(r, "", { event: "PreToolUse", matcher: "Bash", command: "echo before" }));
        const id = runPure(claudeProvider.parse(r, added))[0]!.id;
        const edited = runPure(claudeProvider.applyEdit(r, added, id, { command: "echo after" }));
        const rows = runPure(claudeProvider.parse(r, edited));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe(id); // unchanged
        expect(rows[0]!.owner).toBe("ax"); // marker carried
        expect(rows[0]!.command).toContain("echo after");
        expect(rows[0]!.command).toContain(`# ax:${id}`);
    });

    test("add merges into existing matcher group", () => {
        let raw = runPure(claudeProvider.applyAdd(r, "", { event: "PreToolUse", matcher: "Bash", command: "first" }));
        raw = runPure(claudeProvider.applyAdd(r, raw, { event: "PreToolUse", matcher: "Bash", command: "second" }));
        const parsed = JSON.parse(raw);
        expect(parsed.hooks.PreToolUse).toHaveLength(1);
        expect(parsed.hooks.PreToolUse[0].hooks).toHaveLength(2);
    });

    test("remove by id deletes the entry and prunes empty groups/events", () => {
        const raw = runPure(claudeProvider.applyAdd(r, "", { event: "PreToolUse", matcher: "Bash", command: "echo hi" }));
        const id = runPure(claudeProvider.parse(r, raw))[0]!.id;
        const next = runPure(claudeProvider.applyRemove(r, raw, id));
        expect(runPure(claudeProvider.parse(r, next))).toHaveLength(0);
        expect(JSON.parse(next).hooks?.PreToolUse).toBeUndefined();
    });

    test("edit patches command", () => {
        const raw = runPure(claudeProvider.applyAdd(r, "", { event: "Stop", command: "old" }));
        const id = runPure(claudeProvider.parse(r, raw))[0]!.id;
        const next = runPure(claudeProvider.applyEdit(r, raw, id, { command: "brand new command" }));
        const rows = runPure(claudeProvider.parse(r, next));
        expect(rows[0]!.command).toContain("brand new command");
        expect(rows[0]!.id).toBe(id); // marker preserved -> id stable
    });

    test("extract -> insert round-trip restores the entry", () => {
        const raw = runPure(claudeProvider.applyAdd(r, "", { event: "PreToolUse", matcher: "Edit", command: "echo z" }));
        const id = runPure(claudeProvider.parse(r, raw))[0]!.id;
        const { entry, text } = runPure(claudeProvider.extractEntry(r, raw, id));
        expect(runPure(claudeProvider.parse(r, text))).toHaveLength(0);
        const restored = runPure(claudeProvider.insertEntry(r, text, entry));
        const rows = runPure(claudeProvider.parse(r, restored));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.matcher).toBe("Edit");
        expect(rows[0]!.command).toContain("echo z");
    });

    test("unknown event rejected by validation", () => {
        const exit = Effect.runSyncExit(claudeProvider.applyAdd(r, "", { event: "Nope", command: "x" }));
        expect(exit._tag).toBe("Failure");
    });

    test("malformed JSON yields HookConfigParseError", () => {
        const exit = Effect.runSyncExit(claudeProvider.parse(r, "{not json"));
        expect(exit._tag).toBe("Failure");
    });

    test("parse handles empty doc", () => {
        expect(runPure(claudeProvider.parse(r, ""))).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// cursor provider (no matcher)
// ---------------------------------------------------------------------------
describe("cursor provider", () => {
    const r = ref("/Users/x/.cursor/hooks.json", "global");

    test("parse reads flat per-event arrays", () => {
        const raw = JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: "echo go" }] } });
        const rows = runPure(cursorProvider.parse(r, raw));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.matcher).toBeNull();
        expect(rows[0]!.event).toBe("beforeShellExecution");
    });

    test("add/remove round-trip and version preserved", () => {
        const raw = runPure(cursorProvider.applyAdd(r, "", { event: "stop", command: "cleanup" }));
        expect(JSON.parse(raw).version).toBe(1);
        const rows = runPure(cursorProvider.parse(r, raw));
        expect(rows).toHaveLength(1);
        const next = runPure(cursorProvider.applyRemove(r, raw, rows[0]!.id));
        expect(runPure(cursorProvider.parse(r, next))).toHaveLength(0);
    });

    test("matcher on add is rejected", () => {
        const exit = Effect.runSyncExit(cursorProvider.applyAdd(r, "", { event: "stop", matcher: "Bash", command: "x" }));
        expect(exit._tag).toBe("Failure");
    });
});

// ---------------------------------------------------------------------------
// codex provider (TOML + JSON)
// ---------------------------------------------------------------------------
describe("codex provider", () => {
    const tref = ref("/Users/x/.codex/config.toml", "global", "toml");
    const jref = ref("/Users/x/.codex/hooks.json", "global", "json");

    test("TOML parse reads [[hooks.Event]] entries", () => {
        const raw = `[[hooks.PreToolUse]]\nmatcher = "Bash"\ncommand = "echo toml"\n`;
        const rows = runPure(codexProvider.parse(tref, raw));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.matcher).toBe("Bash");
        expect(rows[0]!.command).toBe("echo toml");
        expect(rows[0]!.provider).toBe("codex");
    });

    test("TOML add -> parse round-trip", () => {
        const next = runPure(codexProvider.applyAdd(tref, "", { event: "PostToolUse", matcher: "Edit", command: "fmt" }));
        const rows = runPure(codexProvider.parse(tref, next));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.event).toBe("PostToolUse");
        expect(rows[0]!.matcher).toBe("Edit");
        expect(rows[0]!.command).toContain("fmt");
        expect(rows[0]!.axId).toBeDefined();
    });

    test("TOML remove + edit round-trip", () => {
        const raw = runPure(codexProvider.applyAdd(tref, "", { event: "Stop", command: "orig" }));
        const id = runPure(codexProvider.parse(tref, raw))[0]!.id;
        const edited = runPure(codexProvider.applyEdit(tref, raw, id, { command: "edited" }));
        expect(runPure(codexProvider.parse(tref, edited))[0]!.command).toContain("edited");
        expect(runPure(codexProvider.parse(tref, edited))[0]!.id).toBe(id); // marker preserved
        const id2 = runPure(codexProvider.parse(tref, edited))[0]!.id;
        const removed = runPure(codexProvider.applyRemove(tref, edited, id2));
        expect(runPure(codexProvider.parse(tref, removed))).toHaveLength(0);
    });

    test("JSON file uses codex identity AND mutates by that id (regression)", () => {
        const raw = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo j" }] }] } });
        const rows = runPure(codexProvider.parse(jref, raw));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.provider).toBe("codex");
        // the bug: the JSON id was hashed with provider=codex but mutate delegated
        // to claude (id=claude) -> remove/edit silently no-op'd. Assert remove works.
        const removed = runPure(codexProvider.applyRemove(jref, raw, rows[0]!.id));
        expect(runPure(codexProvider.parse(jref, removed))).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// opencode provider (argv + glob)
// ---------------------------------------------------------------------------
describe("opencode provider", () => {
    const r = ref("/Users/x/.config/opencode/opencode.json", "global");

    test("argv wrap/join helpers", () => {
        expect(wrapArgv("echo hi && ls")).toEqual(["sh", "-c", "echo hi && ls"]);
        expect(joinArgv(["sh", "-c", "echo hi"])).toBe("echo hi");
        expect(joinArgv(["bun", "run", "x"])).toBe("bun run x");
    });

    test("file_edited add stores argv under the glob and preserves it on read", () => {
        const raw = runPure(opencodeProvider.applyAdd(r, "", { event: "file_edited", matcher: "**/*.ts", command: "tsc --noEmit" }));
        const parsed = JSON.parse(raw);
        const argv = parsed.experimental.hook.file_edited["**/*.ts"][0].command;
        expect(Array.isArray(argv)).toBe(true);
        expect(argv[0]).toBe("sh");
        const rows = runPure(opencodeProvider.parse(r, raw));
        expect(rows[0]!.matcher).toBe("**/*.ts");
        expect(rows[0]!.argv).toEqual(argv);
        expect(rows[0]!.command).toContain("tsc --noEmit");
    });

    test("file_edited without glob is rejected", () => {
        const exit = Effect.runSyncExit(opencodeProvider.applyAdd(r, "", { event: "file_edited", command: "x" }));
        expect(exit._tag).toBe("Failure");
    });

    test("session_completed add (no matcher) + remove round-trip", () => {
        const raw = runPure(opencodeProvider.applyAdd(r, "", { event: "session_completed", command: "notify" }));
        const rows = runPure(opencodeProvider.parse(r, raw));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.matcher).toBeNull();
        const next = runPure(opencodeProvider.applyRemove(r, raw, rows[0]!.id));
        expect(runPure(opencodeProvider.parse(r, next))).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------
describe("registry", () => {
    test("default registry has the four providers", () => {
        expect(ALL_HOOK_PROVIDERS.map((p) => p.name).sort()).toEqual(["claude", "codex", "cursor", "opencode"]);
    });

    test("select hits and misses", async () => {
        const program = Effect.gen(function* () {
            const reg = yield* HookProviderRegistry;
            const hit = yield* reg.select("claude");
            const missExit = yield* reg.select("nope").pipe(Effect.exit);
            return { hit: hit.name, miss: missExit._tag };
        });
        const out = await Effect.runPromise(program.pipe(Effect.provide(HookProviderRegistryDefault)));
        expect(out.hit).toBe("claude");
        expect(out.miss).toBe("Failure");
    });
});

// ---------------------------------------------------------------------------
// config.ts orchestration (real fs in tmpdir + mock SurrealClient)
// ---------------------------------------------------------------------------
const fsLayers = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const mockDb = (rows: Array<{ command: string; count: number }>) =>
    Layer.succeed(SurrealClient, {
        query: <T>() => Effect.sync(() => [rows.map((r) => ({
            command: r.command,
            hook_name: "h",
            provider_status: "ok",
            effect: "allow",
            count: r.count,
        }))] as unknown as T),
    } as never);

const fullLayer = (dbRows: Array<{ command: string; count: number }> = []) =>
    Layer.mergeAll(fsLayers, HookProviderRegistryDefault, mockDb(dbRows));

describe("config orchestration", () => {
    const mk = () => mkdtempSync(join(tmpdir(), "ax-hooks-"));

    test("readAllHooks reads from a real settings.json and joins evidence", async () => {
        const root = mk();
        const file = join(root, "settings.json");
        const program = Effect.gen(function* () {
            // write via claude provider into the global file path we control via repoRoot=project
            yield* addHook({ provider: "claude", scope: "project", repoRoot: root, input: { event: "PreToolUse", matcher: "Bash", command: "echo fired" } });
            const rows = yield* readAllHooks({ providerFilter: "claude", scopeFilter: "project", repoRoot: root, withEvidence: true });
            return rows;
        });
        // claude project file is <repoRoot>/.claude/settings.json - read the actual command for the evidence row
        const rowsNoEv = await Effect.runPromise(
            addHook({ provider: "claude", scope: "project", repoRoot: root, input: { event: "PreToolUse", matcher: "Bash", command: "echo fired" } })
                .pipe(
                    Effect.flatMap(() => readAllHooks({ providerFilter: "claude", scopeFilter: "project", repoRoot: root })),
                    Effect.provide(fullLayer()),
                ),
        );
        expect(rowsNoEv).toHaveLength(1);
        const cmd = rowsNoEv[0]!.command;
        // now with evidence keyed by that exact command
        const withEv = await Effect.runPromise(
            readAllHooks({ providerFilter: "claude", scopeFilter: "project", repoRoot: root, withEvidence: true })
                .pipe(Effect.provide(fullLayer([{ command: cmd, count: 7 }]))),
        );
        expect(withEv[0]!.fired).toBe(7);
        void file;
        void program;
    });

    test("add then remove leaves the file with no hooks", async () => {
        const root = mk();
        const out = await Effect.runPromise(
            Effect.gen(function* () {
                yield* addHook({ provider: "claude", scope: "project", repoRoot: root, input: { event: "Stop", command: "echo done" } });
                const before = yield* readAllHooks({ providerFilter: "claude", scopeFilter: "project", repoRoot: root });
                yield* removeHook({ provider: "claude", scope: "project", repoRoot: root, id: before[0]!.id });
                const after = yield* readAllHooks({ providerFilter: "claude", scopeFilter: "project", repoRoot: root });
                return { before: before.length, after: after.length };
            }).pipe(Effect.provide(fullLayer())),
        );
        expect(out.before).toBe(1);
        expect(out.after).toBe(0);
    });

    test("edit changes the command on disk and writes a .bak", async () => {
        const root = mk();
        const out = await Effect.runPromise(
            Effect.gen(function* () {
                yield* addHook({ provider: "claude", scope: "project", repoRoot: root, input: { event: "Stop", command: "v1" } });
                const rows = yield* readAllHooks({ providerFilter: "claude", scopeFilter: "project", repoRoot: root });
                const path = yield* editHook({ provider: "claude", scope: "project", repoRoot: root, id: rows[0]!.id, patch: { command: "v2 changed" } });
                const after = yield* readAllHooks({ providerFilter: "claude", scopeFilter: "project", repoRoot: root });
                return { path, cmd: after[0]!.command };
            }).pipe(Effect.provide(fullLayer())),
        );
        expect(out.cmd).toContain("v2 changed");
        expect(existsSync(`${out.path}.bak`)).toBe(true);
    });

    test("disable parks the hook to a sidecar; enable restores it", async () => {
        const root = mk();
        const out = await Effect.runPromise(
            Effect.gen(function* () {
                const path = yield* addHook({ provider: "claude", scope: "project", repoRoot: root, input: { event: "PreToolUse", matcher: "Bash", command: "guard" } });
                const rows = yield* readAllHooks({ providerFilter: "claude", scopeFilter: "project", repoRoot: root });
                yield* disableHook({ provider: "claude", scope: "project", repoRoot: root, id: rows[0]!.id });
                const parked = yield* readAllHooks({ providerFilter: "claude", scopeFilter: "project", repoRoot: root });
                const sidecarExists = existsSync(`${path}.ax-parked.json`);
                yield* enableHook({ provider: "claude", scope: "project", repoRoot: root, id: rows[0]!.id });
                const restored = yield* readAllHooks({ providerFilter: "claude", scopeFilter: "project", repoRoot: root });
                return {
                    path,
                    parkedDisabled: parked.find((h) => h.id === rows[0]!.id)?.enabled,
                    parkedCount: parked.length,
                    sidecarExists,
                    restoredEnabled: restored.find((h) => h.id === rows[0]!.id)?.enabled,
                };
            }).pipe(Effect.provide(fullLayer())),
        );
        // while parked the native file is empty, so the row comes from the sidecar with enabled:false
        expect(out.sidecarExists).toBe(true);
        expect(out.parkedCount).toBe(1);
        expect(out.parkedDisabled).toBe(false);
        expect(out.restoredEnabled).toBe(true);
    });

    test("remove of an unknown id fails with HookNotFoundError", async () => {
        const root = mk();
        const exit = await Effect.runPromise(
            Effect.gen(function* () {
                yield* addHook({ provider: "claude", scope: "project", repoRoot: root, input: { event: "Stop", command: "x" } });
                return yield* removeHook({ provider: "claude", scope: "project", repoRoot: root, id: "deadbeef" }).pipe(Effect.exit);
            }).pipe(Effect.provide(fullLayer())),
        );
        expect(exit._tag).toBe("Failure");
    });

    test("unknown provider fails with HookProviderNotFoundError", async () => {
        const root = mk();
        const exit = await Effect.runPromise(
            addHook({ provider: "vim", scope: "project", repoRoot: root, input: { event: "Stop", command: "x" } })
                .pipe(Effect.exit, Effect.provide(fullLayer())),
        );
        expect(exit._tag).toBe("Failure");
    });
});

// keep an explicit ref to HookProviderRegistryLive so its export is exercised
test("HookProviderRegistryLive builds a custom registry", async () => {
    const layer = HookProviderRegistryLive([claudeProvider]);
    const names = await Effect.runPromise(
        Effect.gen(function* () {
            const reg = yield* HookProviderRegistry;
            return reg.all().map((p) => p.name);
        }).pipe(Effect.provide(layer)),
    );
    expect(names).toEqual(["claude"]);
});
