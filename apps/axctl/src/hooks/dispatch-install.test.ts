import { describe, expect, test } from "bun:test";
import {
    planDispatcherInstall,
    legacyGuardCommands,
    planLegacyRemoval,
    type ConfiguredHookRow,
} from "./dispatch-install.ts";

const DIR = "/home/u/.ax/hooks";
const DISPATCH = `${DIR}/dispatch.ts`;

describe("planDispatcherInstall", () => {
    test("fans the dispatcher across providers, all pointing at the dispatch entry", () => {
        const plan = planDispatcherInstall(DISPATCH, ["claude", "codex"]);
        expect(plan.length).toBeGreaterThan(0);
        for (const e of plan) expect(e.input.command).toBe(`bun ${DISPATCH}`);
        expect(new Set(plan.map((e) => e.provider))).toEqual(new Set(["claude", "codex"]));
    });

    test("PreToolUse carries a tool matcher; SessionStart has none", () => {
        const plan = planDispatcherInstall(DISPATCH, ["claude"]);
        const pre = plan.find((e) => e.input.event === "PreToolUse");
        const session = plan.find((e) => e.input.event === "SessionStart");
        expect(pre?.input.matcher ?? "").toContain("Edit");
        expect(session?.input.matcher ?? null).toBeNull();
    });
});

describe("legacyGuardCommands", () => {
    test("covers .ts and .js for every guard in the dir", () => {
        const cmds = legacyGuardCommands(DIR);
        expect(cmds.has(`bun ${DIR}/enforce-worktree.ts`)).toBe(true);
        expect(cmds.has(`bun ${DIR}/enforce-worktree.js`)).toBe(true);
        expect(cmds.has(`bun ${DIR}/route-dispatch.js`)).toBe(true);
        // not the dispatcher itself
        expect(cmds.has(`bun ${DIR}/dispatch.ts`)).toBe(false);
    });
});

const row = (over: Partial<ConfiguredHookRow>): ConfiguredHookRow => ({
    provider: "claude",
    scope: "global",
    event: "PreToolUse",
    command: `bun ${DIR}/enforce-worktree.ts`,
    id: "h1",
    axId: "abc123",
    ...over,
});

describe("planLegacyRemoval", () => {
    test("removes ax-owned legacy per-guard entries", () => {
        const out = planLegacyRemoval([row({})], DIR, ["claude"], "global");
        expect(out.map((h) => h.id)).toEqual(["h1"]);
    });

    test("with a marker on the stored command", () => {
        const out = planLegacyRemoval(
            [row({ command: `bun ${DIR}/route-dispatch.js # ax:zzz`, id: "h2" })],
            DIR,
            ["claude"],
            "global",
        );
        expect(out.map((h) => h.id)).toEqual(["h2"]);
    });

    test("never removes a NON-ax (user-authored) hook, even on a colliding command", () => {
        const out = planLegacyRemoval(
            [row({ axId: undefined })],
            DIR,
            ["claude"],
            "global",
        );
        expect(out).toEqual([]);
    });

    test("never removes the command being installed (keepCommand)", () => {
        const keep = `bun ${DIR}/dispatch.ts`;
        const out = planLegacyRemoval(
            [row({ command: keep, id: "d1" })],
            DIR,
            ["claude"],
            "global",
            keep,
        );
        expect(out).toEqual([]);
    });

    test("dispatch->shim switch removes the old dispatcher entry", () => {
        const out = planLegacyRemoval(
            [row({ command: `bun ${DIR}/dispatch.ts`, id: "d1" })],
            DIR,
            ["claude"],
            "global",
            `bun ${DIR}/dispatch-shim.ts`, // installing the shim now
        );
        expect(out.map((h) => h.id)).toEqual(["d1"]);
    });

    test("shim->dispatch switch removes the old shim entry", () => {
        const out = planLegacyRemoval(
            [row({ command: `bun ${DIR}/dispatch-shim.js # ax:s1`, id: "s1" })],
            DIR,
            ["claude"],
            "global",
            `bun ${DIR}/dispatch.js`, // installing the dispatcher now
        );
        expect(out.map((h) => h.id)).toEqual(["s1"]);
    });

    test("skips other providers and other scopes", () => {
        const rows = [
            row({ provider: "cursor", id: "x" }),
            row({ scope: "project", id: "y" }),
        ];
        const out = planLegacyRemoval(rows, DIR, ["claude"], "global");
        expect(out).toEqual([]);
    });

    test("skips legacy entries from a DIFFERENT workspace dir", () => {
        const out = planLegacyRemoval(
            [row({ command: `bun /other/dir/enforce-worktree.ts` })],
            DIR,
            ["claude"],
            "global",
        );
        expect(out).toEqual([]);
    });
});
