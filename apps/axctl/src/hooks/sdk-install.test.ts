import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { SurrealClient } from "@ax/lib/db";
import { HookProviderRegistryDefault } from "./providers/registry.ts";
import {
    planInstall,
    loadHookMeta,
    filterAlreadyInstalled,
    installHookFile,
    SdkHookFileNotFoundError,
    SdkHookImportError,
    SdkHookValidationError,
} from "./sdk-install.ts";
import type { InstallableHookMeta, InstallPlanEntry, InstallResult } from "./sdk-install.ts";

// ---------------------------------------------------------------------------
// planInstall (pure)
// ---------------------------------------------------------------------------

describe("planInstall", () => {
    const guardDef: InstallableHookMeta = {
        name: "g",
        events: ["PreToolUse"],
        matcher: { tools: ["Write", "Edit", "MultiEdit", "apply_patch"] },
    };

    test("2 providers x 1 event -> 2 entries with correct matcher and command", () => {
        const entries = planInstall(guardDef, "/abs/g.ts", ["claude", "codex"]);
        expect(entries).toHaveLength(2);

        for (const entry of entries) {
            expect(entry.input.matcher).toBe("Write|Edit|MultiEdit|apply_patch");
            expect(entry.input.command).toBe("bun /abs/g.ts");
            expect(entry.input.timeout).toBe(10);
        }
        expect(entries[0]!.provider).toBe("claude");
        expect(entries[1]!.provider).toBe("codex");
    });

    test("no matcher -> matcher null", () => {
        const def: InstallableHookMeta = { name: "noop", events: ["PreToolUse"] };
        const entries = planInstall(def, "/abs/noop.ts", ["claude"]);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.input.matcher).toBeNull();
    });

    test("empty tools array -> matcher null", () => {
        const def: InstallableHookMeta = {
            name: "noop",
            events: ["PreToolUse"],
            matcher: { tools: [] },
        };
        const entries = planInstall(def, "/abs/noop.ts", ["claude"]);
        expect(entries[0]!.input.matcher).toBeNull();
    });

    test("2 events x 1 provider -> 2 entries", () => {
        const def: InstallableHookMeta = {
            name: "multi",
            events: ["PreToolUse", "PostToolUse"],
        };
        const entries = planInstall(def, "/abs/multi.ts", ["claude"]);
        expect(entries).toHaveLength(2);
        expect(entries[0]!.input.event).toBe("PreToolUse");
        expect(entries[1]!.input.event).toBe("PostToolUse");
        for (const entry of entries) expect(entry.provider).toBe("claude");
    });

    test("1 event x 2 providers -> correct provider assignment", () => {
        const def: InstallableHookMeta = { name: "g", events: ["PreToolUse"] };
        const entries = planInstall(def, "/x.ts", ["claude", "codex"]);
        expect(entries[0]!.provider).toBe("claude");
        expect(entries[1]!.provider).toBe("codex");
    });

    test("empty providers -> empty array", () => {
        const def: InstallableHookMeta = { name: "g", events: ["PreToolUse"] };
        expect(planInstall(def, "/x.ts", [])).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// loadHookMeta (import + validate)
// ---------------------------------------------------------------------------

const mk = () => mkdtempSync(join(tmpdir(), "ax-sdk-install-"));

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
    Effect.runPromise(eff as Effect.Effect<A, never>);

const runFail = <A, E>(eff: Effect.Effect<A, E>): Promise<E> =>
    Effect.runPromise(Effect.flip(eff) as Effect.Effect<E, never>);

describe("loadHookMeta", () => {
    test("loads meta from a valid hook file with default export", async () => {
        const dir = mk();
        const file = join(dir, "myhook.ts");
        writeFileSync(
            file,
            `export default {
  name: "my-guard",
  events: ["PreToolUse"],
  matcher: { tools: ["Bash", "Write"] },
};\n`,
        );

        const meta = await run(loadHookMeta(file));
        expect(meta.name).toBe("my-guard");
        expect(meta.events).toEqual(["PreToolUse"]);
        expect(meta.matcher?.tools).toEqual(["Bash", "Write"]);
    });

    test("loads meta without matcher", async () => {
        const dir = mk();
        const file = join(dir, "simple.ts");
        writeFileSync(
            file,
            `export default { name: "simple", events: ["PostToolUse"] };\n`,
        );

        const meta = await run(loadHookMeta(file));
        expect(meta.name).toBe("simple");
        expect(meta.events).toEqual(["PostToolUse"]);
        expect(meta.matcher).toBeUndefined();
    });

    test("typed error when file has no default export", async () => {
        const dir = mk();
        const file = join(dir, "nodefault.ts");
        writeFileSync(file, `export const foo = 42;\n`);

        const err = await runFail(loadHookMeta(file));
        expect(err).toBeInstanceOf(SdkHookValidationError);
        expect((err as SdkHookValidationError).reason).toContain("no default export");
        expect((err as SdkHookValidationError).file).toBe(file);
    });

    test("typed error when default export has no name", async () => {
        const dir = mk();
        const file = join(dir, "noname.ts");
        writeFileSync(file, `export default { events: ["PreToolUse"] };\n`);

        const err = await runFail(loadHookMeta(file));
        expect(err).toBeInstanceOf(SdkHookValidationError);
        expect((err as SdkHookValidationError).reason).toContain("name");
    });

    test("typed error when events array is empty", async () => {
        const dir = mk();
        const file = join(dir, "emptyevents.ts");
        writeFileSync(file, `export default { name: "x", events: [] };\n`);

        const err = await runFail(loadHookMeta(file));
        expect(err).toBeInstanceOf(SdkHookValidationError);
        expect((err as SdkHookValidationError).reason).toContain("events");
    });

    test("typed error when file does not exist", async () => {
        const file = join(mk(), "nonexistent.ts");
        const err = await runFail(loadHookMeta(file));
        expect(err).toBeInstanceOf(SdkHookImportError);
        expect((err as SdkHookImportError).file).toBe(file);
    });

    test("typed error when default export is not an object", async () => {
        const dir = mk();
        const file = join(dir, "notobj.ts");
        writeFileSync(file, `export default 42;\n`);

        const err = await runFail(loadHookMeta(file));
        expect(err).toBeInstanceOf(SdkHookValidationError);
        expect((err as SdkHookValidationError).reason).toContain("object");
    });
});

// ---------------------------------------------------------------------------
// filterAlreadyInstalled (pure)
// ---------------------------------------------------------------------------

describe("filterAlreadyInstalled", () => {
    const entry = (provider: string, event: string, command: string): InstallPlanEntry => ({
        provider,
        input: { event, matcher: null, command, timeout: 10 },
    });

    test("skips an entry whose (provider, scope, event, command) already exists", () => {
        const plan = [entry("claude", "PreToolUse", "bun /abs/g.ts")];
        const existing = [
            { provider: "claude", scope: "global", event: "PreToolUse", command: "bun /abs/g.ts" },
        ];
        const out = filterAlreadyInstalled(plan, existing, "global");
        expect(out[0]!.skipped).toBe(true);
    });

    test("matches even when the existing command carries an ax marker", () => {
        const plan = [entry("claude", "PreToolUse", "bun /abs/g.ts")];
        const existing = [
            { provider: "claude", scope: "global", event: "PreToolUse", command: "bun /abs/g.ts # ax:abc12345" },
        ];
        const out = filterAlreadyInstalled(plan, existing, "global");
        expect(out[0]!.skipped).toBe(true);
    });

    test("does not skip when provider, event, scope, or command differ", () => {
        const plan = [entry("claude", "PreToolUse", "bun /abs/g.ts")];
        const cases = [
            { provider: "codex", scope: "global", event: "PreToolUse", command: "bun /abs/g.ts" },
            { provider: "claude", scope: "project", event: "PreToolUse", command: "bun /abs/g.ts" },
            { provider: "claude", scope: "global", event: "PostToolUse", command: "bun /abs/g.ts" },
            { provider: "claude", scope: "global", event: "PreToolUse", command: "bun /abs/other.ts" },
        ];
        for (const existing of cases) {
            const out = filterAlreadyInstalled(plan, [existing], "global");
            expect(out[0]!.skipped).toBe(false);
        }
    });

    test("partial overlap: only the existing combination is skipped", () => {
        const plan = [
            entry("claude", "PreToolUse", "bun /abs/g.ts"),
            entry("codex", "PreToolUse", "bun /abs/g.ts"),
        ];
        const existing = [
            { provider: "claude", scope: "global", event: "PreToolUse", command: "bun /abs/g.ts # ax:deadbeef" },
        ];
        const out = filterAlreadyInstalled(plan, existing, "global");
        expect(out[0]!.skipped).toBe(true);
        expect(out[1]!.skipped).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// installHookFile (real claude codec against tmp config + mock SurrealClient)
// ---------------------------------------------------------------------------

const mockDb = Layer.succeed(SurrealClient, {
    query: <T>() => Effect.sync(() => [[]] as unknown as T),
} as never);

const fullLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, HookProviderRegistryDefault, mockDb);

const runFull = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> =>
    Effect.runPromise(eff as Effect.Effect<A, never>);

describe("installHookFile", () => {
    const writeHookFile = (dir: string): string => {
        const file = join(dir, "guard.ts");
        writeFileSync(
            file,
            `export default { name: "guard", events: ["PreToolUse"], matcher: { tools: ["Write", "Edit"] } };\n`,
        );
        return file;
    };

    test("fails with SdkHookFileNotFoundError (not SdkHookImportError) when the file is missing", async () => {
        const missing = join(mk(), "does-not-exist.ts");
        const err = await runFull(
            installHookFile(missing, ["claude"], "global")
                .pipe(Effect.flip, Effect.provide(fullLayer)) as Effect.Effect<unknown, never, never>,
        );
        expect(err).toBeInstanceOf(SdkHookFileNotFoundError);
        expect(err).not.toBeInstanceOf(SdkHookImportError);
        expect((err as SdkHookFileNotFoundError).file).toBe(missing);
        expect((err as SdkHookFileNotFoundError).reason).toContain("file not found");
    });

    test("fails with SdkHookValidationError when the path is not absolute", async () => {
        const err = await runFull(
            installHookFile("relative/guard.ts", ["claude"], "global")
                .pipe(Effect.flip, Effect.provide(fullLayer)) as Effect.Effect<unknown, never, never>,
        );
        expect(err).toBeInstanceOf(SdkHookValidationError);
        expect((err as SdkHookValidationError).reason).toBe("hook file path must be absolute");
    });

    test("re-running install is idempotent: second run all-skipped, config byte-identical", async () => {
        const root = mk();
        const hookFile = writeHookFile(root);

        const first = await runFull(
            installHookFile(hookFile, ["claude"], "project", { repoRoot: root })
                .pipe(Effect.provide(fullLayer)) as Effect.Effect<ReadonlyArray<InstallResult>, never, never>,
        );
        expect(first).toHaveLength(1);
        expect(first[0]!.skipped).toBe(false);
        const configPath = first[0]!.writtenPath!;
        const bytesAfterFirst = readFileSync(configPath, "utf8");
        // marker embedded by the codec
        expect(bytesAfterFirst).toContain("bun " + hookFile);

        const second = await runFull(
            installHookFile(hookFile, ["claude"], "project", { repoRoot: root })
                .pipe(Effect.provide(fullLayer)) as Effect.Effect<typeof first, never, never>,
        );
        expect(second).toHaveLength(1);
        expect(second[0]!.skipped).toBe(true);
        expect(second[0]!.writtenPath).toBeUndefined();

        const bytesAfterSecond = readFileSync(configPath, "utf8");
        expect(bytesAfterSecond).toBe(bytesAfterFirst);
    });
});
