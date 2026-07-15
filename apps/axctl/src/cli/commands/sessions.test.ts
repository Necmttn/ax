import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { BunServices } from "@effect/platform-bun";
import {
    projectRootForHere,
    sessionTurnsFlag,
} from "./sessions.ts";
import { normalizeSessionViewInput } from "../../dashboard/session-view.ts";

describe("sessions command helpers", () => {
    test("--turns accepts a bare excerpt mode or =full without enabling by default", async () => {
        const parse = async (values?: ReadonlyArray<string>) => {
            const [, parsed] = await Effect.runPromise(
                sessionTurnsFlag.parse({
                    arguments: [],
                    flags: values === undefined ? {} : { turns: values },
                }).pipe(Effect.provide(BunServices.layer)),
            );
            return normalizeSessionViewInput({ turns: parsed }).turns;
        };

        expect(await Promise.all([
            parse(),
            parse(["true"]),
            parse(["full"]),
        ])).toEqual([undefined, "excerpt", "full"]);
    });

    test("sessions show help advertises the optional full-text value", () => {
        const help = Bun.spawnSync(
            ["bun", "apps/axctl/src/cli/index.ts", "sessions", "show", "--help"],
            { stdout: "pipe", stderr: "pipe" },
        );

        expect(help.exitCode).toBe(0);
        expect(help.stdout.toString()).toContain("--turns [=full]");
    });

    test("projectRootForHere uses main checkout root for linked worktrees", () => {
        expect(projectRootForHere({
            repoRoot: "/repo/.claude/worktrees/issue-123",
            mainRepoRoot: "/repo",
        })).toBe("/repo");
    });

    test("projectRootForHere keeps the active checkout for normal repos", () => {
        expect(projectRootForHere({
            repoRoot: "/repo",
            mainRepoRoot: "/repo",
        })).toBe("/repo");
    });

    test("projectRootForHere keeps its own root for an external linked worktree", () => {
        // Worktree NOT nested under the main checkout: rolling up to mainRepoRoot
        // would drop this worktree's own sessions (cwd path-prefix filter).
        expect(projectRootForHere({
            repoRoot: "/tmp/ax-issue-123",
            mainRepoRoot: "/repo",
        })).toBe("/tmp/ax-issue-123");
    });

    test("projectRootForHere ignores a mis-derived (internal) main root", () => {
        // e.g. submodule `--git-common-dir` resolving to `.git/modules/<name>`.
        expect(projectRootForHere({
            repoRoot: "/repo",
            mainRepoRoot: "/repo/.git/modules/sub",
        })).toBe("/repo");
    });
});
