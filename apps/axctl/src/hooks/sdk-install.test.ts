import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { planInstall, loadHookMeta, SdkHookImportError, SdkHookValidationError } from "./sdk-install.ts";
import type { InstallableHookMeta } from "./sdk-install.ts";

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
