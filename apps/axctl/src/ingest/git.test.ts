import { describe, expect, test } from "bun:test";
import { Effect, Layer, PlatformError } from "effect";
import { BunPath } from "@effect/platform-bun";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import {
    buildSessionCheckoutWhere,
    buildSessionRepoWhere,
    deriveRepositoryDisplayName,
    nestedCheckoutPaths,
    isGitRepo,
    readRepoListFile,
    REPO_LIST_FILE,
} from "./git.ts";

describe("git path derivation", () => {
    test("derives repository display name from remote before checkout path", () => {
        expect(deriveRepositoryDisplayName("github.com/Necmttn/ax", "/tmp/other")).toBe("ax");
        expect(deriveRepositoryDisplayName(null, "/Users/me/Projects/local-repo")).toBe("local-repo");
    });

    test("finds nested checkout roots under the parent checkout", () => {
        expect(nestedCheckoutPaths("/repo", ["/repo", "/repo/.claude/worktrees/a", "/other"]))
            .toEqual(["/repo/.claude/worktrees/a"]);
    });

    test("binds repository and checkout paths as parameters", () => {
        const repo = buildSessionRepoWhere("/repo/it's-main");
        expect(repo.sql).not.toContain("/repo");
        expect(repo.params).toEqual(["/repo/it's-main", "/repo/it's-main/%"]);

        const checkout = buildSessionCheckoutWhere("/repo", ["/repo/worktree"]);
        expect(checkout.sql).not.toContain("/repo");
        expect(checkout.params).toEqual(["/repo", "/repo/%", "/repo/worktree", "/repo/worktree/%"]);
    });
});

describe("git discovery best-effort tolerance", () => {
    const permissionDenied = (method: string, path: string) =>
        PlatformError.systemError({
            _tag: "PermissionDenied", module: "FileSystem", method, pathOrDescriptor: path,
        });

    test("readRepoListFile recovers a permission error to an empty list", async () => {
        const out = await Effect.runPromise(
            readRepoListFile().pipe(Effect.provide(layerTestFileSystem(
                {}, { errors: { [REPO_LIST_FILE]: permissionDenied("readFileString", REPO_LIST_FILE) } },
            ))),
        );
        expect(out).toEqual([]);
    });

    test("isGitRepo recovers a permission error to false", async () => {
        const probePath = "/locked-repo/.git";
        const out = await Effect.runPromise(
            isGitRepo("/locked-repo").pipe(
                Effect.provide(Layer.merge(
                    layerTestFileSystem({}, { errors: { [probePath]: permissionDenied("exists", probePath) } }),
                    BunPath.layer,
                )),
            ),
        );
        expect(out).toBe(false);
    });
});
