import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { SurrealClient } from "@ax/lib/db";
import { installDispatcher } from "./dispatch-install.ts";
import { HookProviderRegistryDefault } from "./providers/registry.ts";

// readAllHooks(withEvidence:false) returns before it ever touches SurrealClient,
// so the dispatcher install path needs no DB - a never-invoked stub satisfies
// the requirement type.
const stubDb = Layer.succeed(SurrealClient, {} as never);

const layers = Layer.mergeAll(
    HookProviderRegistryDefault,
    BunFileSystem.layer,
    BunPath.layer,
    stubDb,
);

const run = <A, E>(eff: Effect.Effect<A, E, any>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layers)) as Effect.Effect<A, never>);

describe("installDispatcher (integration, project scope, no DB)", () => {
    test("registers the dispatcher, migrates the legacy ax guard, keeps the user hook", async () => {
        const repo = mkdtempSync(join(tmpdir(), "ax-disp-"));
        const hooksDir = `${repo}/.ax/hooks`;
        const dispatchPath = `${hooksDir}/dispatch.ts`;
        mkdirSync(join(repo, ".claude"), { recursive: true });

        // Seed: one legacy ax-owned guard entry + one user-authored hook.
        const settings = {
            hooks: {
                PreToolUse: [
                    {
                        matcher: "Write|Edit|MultiEdit|apply_patch",
                        hooks: [
                            {
                                type: "command",
                                command: `bun ${hooksDir}/enforce-worktree-write.ts # ax:legacy01`,
                            },
                        ],
                    },
                    {
                        matcher: "Bash",
                        hooks: [{ type: "command", command: "echo user-owned-hook" }],
                    },
                ],
            },
        };
        const settingsPath = join(repo, ".claude", "settings.json");
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

        const result = await run(
            installDispatcher(dispatchPath, hooksDir, ["claude"], "project", { repoRoot: repo }),
        );

        // The legacy ax guard was migrated; the user hook was not.
        expect(result.removed.map((r) => r.command)).toContain(
            `bun ${hooksDir}/enforce-worktree-write.ts # ax:legacy01`,
        );

        const after = readFileSync(settingsPath, "utf8");
        // Dispatcher is now the command for the guarded events.
        expect(after).toContain(`bun ${dispatchPath}`);
        // Legacy per-guard command is gone.
        expect(after).not.toContain("enforce-worktree-write.ts");
        // User-authored hook survives.
        expect(after).toContain("echo user-owned-hook");

        // A dispatcher entry exists for PreToolUse (tool matcher) and SessionStart.
        const installedEvents = result.entries
            .filter((e) => !e.skipped)
            .map((e) => e.input.event);
        expect(installedEvents).toContain("PreToolUse");
        expect(installedEvents).toContain("SessionStart");
    });

    test("re-running is idempotent (entries skipped, nothing left to migrate)", async () => {
        const repo = mkdtempSync(join(tmpdir(), "ax-disp2-"));
        const hooksDir = `${repo}/.ax/hooks`;
        const dispatchPath = `${hooksDir}/dispatch.ts`;
        mkdirSync(join(repo, ".claude"), { recursive: true });
        writeFileSync(join(repo, ".claude", "settings.json"), "{}");

        const first = await run(
            installDispatcher(dispatchPath, hooksDir, ["claude"], "project", { repoRoot: repo }),
        );
        expect(first.entries.some((e) => !e.skipped)).toBe(true);

        const second = await run(
            installDispatcher(dispatchPath, hooksDir, ["claude"], "project", { repoRoot: repo }),
        );
        // Everything already present -> all skipped, nothing to remove.
        expect(second.entries.every((e) => e.skipped)).toBe(true);
        expect(second.removed).toEqual([]);
    });
});
