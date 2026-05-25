import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ProcessServiceTest } from "../lib/process.ts";
import { getGitState } from "./git.ts";

const STATUS_OUTPUT = ["## main", "M  src/a.ts", " M src/b.ts", "?? new.md", ""].join("\0");

describe("getGitState", () => {
    test("returns parsed branch and changes with mocked git", async () => {
        const root = await mkdtemp(join(tmpdir(), "ax-git-"));
        try {
            await mkdir(join(root, ".git"));

            const layer = ProcessServiceTest({
                route: (cmd, args) => {
                    if (cmd !== "git") return new Error(`unexpected cmd ${cmd}`);
                    if (args.includes("status")) {
                        return { stdout: STATUS_OUTPUT, stderr: "", code: 0 };
                    }
                    if (args.includes("rev-parse")) {
                        return { stdout: "abc1234\n", stderr: "", code: 0 };
                    }
                    return new Error(`unexpected git ${args.join(" ")}`);
                },
            });

            const state = await Effect.runPromise(getGitState(root).pipe(Effect.provide(layer)));

            expect(state.root).toBe(root);
            expect(state.branch).toBe("main");
            expect(state.head).toBe("abc1234");
            expect(state.dirty).toBe(true);
            expect(state.changes.map((c) => c.path)).toContain("src/a.ts");
            expect(state.changes.find((c) => c.path === "new.md")?.untracked).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("returns empty state when not in a git repo", async () => {
        const root = await mkdtemp(join(tmpdir(), "ax-git-nogit-"));
        try {
            const layer = ProcessServiceTest({ route: () => new Error("should not run") });
            const state = await Effect.runPromise(getGitState(root).pipe(Effect.provide(layer)));
            expect(state.root).toBeNull();
            expect(state.dirty).toBe(false);
            expect(state.changes).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
