import { describe, expect, test } from "bun:test";
import {
    buildCommitLookupQueries,
    buildCommitUpsertStatement,
    buildFileLookupQueries,
    buildFileUpsertStatement,
    buildProducedRelationStatements,
    buildTouchedRelationStatements,
    touchedRelationRecordKey,
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

        // Deterministic edge keys differ across checkouts so sibling worktree evidence is preserved
        const keyA = touchedRelationRecordKey("commit:`repo__abc`", "file:`repo__src_index_ts`", "checkout:`a`");
        const keyB = touchedRelationRecordKey("commit:`repo__abc`", "file:`repo__src_index_ts`", "checkout:`b`");
        expect(keyA).not.toBe(keyB);
        expect(checkoutA.join("\n")).toContain(`touched:\`${keyA}\``);
        expect(checkoutB.join("\n")).toContain(`touched:\`${keyB}\``);
        expect(checkoutA.join("\n")).toContain("repository: repository:`repo`");
        expect(checkoutB.join("\n")).toContain("repository: repository:`repo`");
        expect(checkoutA.join("\n")).toContain("checkout: checkout:`a`");
        expect(checkoutB.join("\n")).toContain("checkout: checkout:`b`");
        expect(checkoutA.join("\n")).not.toContain("checkout:`b`");
        expect(checkoutB.join("\n")).not.toContain("checkout:`a`");
    });

    test("touchedRelationRecordKey is deterministic per commit file checkout", () => {
        expect(touchedRelationRecordKey("commit:`c1`", "file:`f1`", "checkout:`co1`"))
            .toBe(touchedRelationRecordKey("commit:`c1`", "file:`f1`", "checkout:`co1`"));
    });

    test("touched relation statements upsert deterministic relation ids", () => {
        const statements = buildTouchedRelationStatements({
            commitId: "commit:`c1`",
            repositoryId: "repository:`r1`",
            checkoutId: "checkout:`co1`",
            ts: "2026-05-10T00:00:00.000Z",
            files: [{ fileId: "file:`f1`", additions: 1, deletions: 2 }],
        });
        expect(statements.join("\n")).toContain("touched:");  // explicit edge id
        expect(statements.join("\n")).toContain("repository: repository:`r1`");
        expect(statements.join("\n")).toContain("checkout: checkout:`co1`");
    });

    test("produced relation statements include repository checkout and ts", () => {
        const statements = buildProducedRelationStatements({
            sessionIds: ["session:`s1`"],
            commitId: "commit:`c1`",
            repositoryId: "repository:`r1`",
            checkoutId: "checkout:`co1`",
            ts: "2026-05-10T00:00:00.000Z",
        });
        expect(statements.join("\n")).toContain("repository: repository:`r1`");
        expect(statements.join("\n")).toContain("checkout: checkout:`co1`");
        expect(statements.join("\n")).toContain('ts: d"2026-05-10T00:00:00.000Z"');
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
