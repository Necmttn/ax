import { describe, expect, test } from "bun:test";
import {
    buildCommitLookupQueries,
    buildCommitUpsertStatement,
    buildFileLookupQueries,
    buildFileUpsertStatement,
    buildTouchedRelationStatements,
} from "./git.ts";

describe("git ingest relation statements", () => {
    test("scopes touched idempotency by commit and checkout", () => {
        const common = {
            commitId: "commit:`repo__abc`",
            files: [
                {
                    fileId: "file:`repo__src_index_ts`",
                    additions: 2,
                    deletions: 1,
                },
            ],
            repositoryId: "repository:`repo`",
            ts: "2026-05-09T00:00:00.000Z",
        };

        const checkoutA = buildTouchedRelationStatements({
            ...common,
            checkoutId: "checkout:`a`",
        });
        const checkoutB = buildTouchedRelationStatements({
            ...common,
            checkoutId: "checkout:`b`",
        });

        expect(checkoutA[0]).toBe("DELETE touched WHERE in = commit:`repo__abc` AND checkout = checkout:`a`;");
        expect(checkoutB[0]).toBe("DELETE touched WHERE in = commit:`repo__abc` AND checkout = checkout:`b`;");
        expect(checkoutA.join("\n")).toContain("repository = repository:`repo`, checkout = checkout:`a`");
        expect(checkoutB.join("\n")).toContain("repository = repository:`repo`, checkout = checkout:`b`");
        expect(checkoutA.join("\n")).not.toContain("checkout:`b`");
        expect(checkoutB.join("\n")).not.toContain("checkout:`a`");
    });

    test("looks up commits canonically before legacy checkout path rows", () => {
        expect(
            buildCommitLookupQueries({
                repositoryId: "repository:`repo`",
                stableRepo: "remote__repo",
                checkoutPath: "/tmp/worktree-a",
                sha: "abc123",
            }),
        ).toEqual([
            'SELECT id FROM commit WHERE repository = repository:`repo` AND repo = "remote__repo" AND sha = "abc123" LIMIT 1;',
            'SELECT id FROM commit WHERE repo = "remote__repo" AND sha = "abc123" LIMIT 1;',
            'SELECT id FROM commit WHERE repository = repository:`repo` AND sha = "abc123" LIMIT 1;',
            'SELECT id FROM commit WHERE repo = "/tmp/worktree-a" AND sha = "abc123" LIMIT 1;',
        ]);
    });

    test("looks up files canonically before legacy checkout path rows", () => {
        expect(
            buildFileLookupQueries({
                repositoryId: "repository:`repo`",
                stableRepo: "remote__repo",
                checkoutPath: "/tmp/worktree-a",
                path: "src/index.ts",
            }),
        ).toEqual([
            'SELECT id FROM file WHERE repository = repository:`repo` AND repo = "remote__repo" AND path = "src/index.ts" LIMIT 1;',
            'SELECT id FROM file WHERE repo = "remote__repo" AND path = "src/index.ts" LIMIT 1;',
            'SELECT id FROM file WHERE repository = repository:`repo` AND path = "src/index.ts" LIMIT 1;',
            'SELECT id FROM file WHERE repo = "/tmp/worktree-a" AND path = "src/index.ts" LIMIT 1;',
        ]);
    });

    test("writes commit and file node repo fields with stable repository identity", () => {
        const commitStatement = buildCommitUpsertStatement({
            id: "commit:`repo__abc123`",
            stableRepo: "remote__repo",
            repositoryId: "repository:`repo`",
            sha: "abc123",
            message: "msg",
            author: "Ada",
            ts: "2026-05-09T00:00:00.000Z",
        });
        const fileStatement = buildFileUpsertStatement({
            id: "file:`repo__src_index_ts`",
            stableRepo: "remote__repo",
            repositoryId: "repository:`repo`",
            path: "src/index.ts",
        });

        expect(commitStatement).toContain('repo: "remote__repo"');
        expect(fileStatement).toContain('repo: "remote__repo"');
        expect(commitStatement).not.toContain("/tmp/worktree-a");
        expect(fileStatement).not.toContain("/tmp/worktree-a");
        expect(commitStatement).not.toContain("checkout:");
        expect(fileStatement).not.toContain("checkout:");
    });
});
