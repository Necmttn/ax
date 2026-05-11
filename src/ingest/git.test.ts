import { describe, expect, test } from "bun:test";
import {
    buildCommitLookupQueries,
    buildCommitUpsertStatement,
    buildFileLookupQueries,
    buildFileUpsertStatement,
    buildProducedRelationStatements,
    buildSessionCheckoutWhere,
    buildSessionCheckoutUpdateStatement,
    buildSessionRepoWhere,
    buildTouchedRelationStatements,
    producedRelationRecordKey,
    touchedRelationRecordKey,
    deriveRepositoryDisplayName,
    nestedCheckoutPaths,
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
        expect(checkoutA.join("\n")).toContain("repository = repository:`repo`");
        expect(checkoutB.join("\n")).toContain("repository = repository:`repo`");
        expect(checkoutA.join("\n")).toContain("checkout = checkout:`a`");
        expect(checkoutB.join("\n")).toContain("checkout = checkout:`b`");
        expect(checkoutA.join("\n")).not.toContain("checkout:`b`");
        expect(checkoutB.join("\n")).not.toContain("checkout:`a`");
    });

    test("touchedRelationRecordKey is deterministic per commit file checkout", () => {
        expect(touchedRelationRecordKey("commit:`c1`", "file:`f1`", "checkout:`co1`"))
            .toBe(touchedRelationRecordKey("commit:`c1`", "file:`f1`", "checkout:`co1`"));
    });

    test("touchedRelationRecordKey normalizes record-literal formatting", () => {
        expect(touchedRelationRecordKey("commit:c1", "file:f1", "checkout:co1"))
            .toBe(touchedRelationRecordKey("commit:`c1`", "file:`f1`", "checkout:`co1`"));
    });

    test("producedRelationRecordKey normalizes record-literal formatting", () => {
        expect(producedRelationRecordKey("session:s1", "commit:c1"))
            .toBe(producedRelationRecordKey("session:`s1`", "commit:`c1`"));
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
        expect(statements.join("\n")).toContain("RELATE commit:`c1`->touched:");
        expect(statements.join("\n")).not.toContain("UPSERT touched:");
        expect(statements.join("\n")).toContain("repository = repository:`r1`");
        expect(statements.join("\n")).toContain("checkout = checkout:`co1`");
    });

    test("produced relation statements include repository checkout and ts", () => {
        const statements = buildProducedRelationStatements({
            sessionIds: ["session:`s1`"],
            commitId: "commit:`c1`",
            repositoryId: "repository:`r1`",
            checkoutId: "checkout:`co1`",
            ts: "2026-05-10T00:00:00.000Z",
        });
        expect(statements.join("\n")).toContain("RELATE session:`s1`->produced:");
        expect(statements.join("\n")).not.toContain("UPSERT produced:");
        expect(statements.join("\n")).toContain("repository = repository:`r1`");
        expect(statements.join("\n")).toContain("checkout = checkout:`co1`");
        expect(statements.join("\n")).toContain('ts = d"2026-05-10T00:00:00.000Z"');
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

    test("links sessions to checkout with exact path boundary", () => {
        const where = buildSessionRepoWhere("/tmp/worktree-a");
        const statement = buildSessionCheckoutUpdateStatement(
            "/tmp/worktree-a",
            "repository:`repo`",
            "checkout:`checkout-a`",
        );

        expect(where).toBe(
            '(cwd = "/tmp/worktree-a" OR string::starts_with(cwd ?? "", "/tmp/worktree-a/"))',
        );
        expect(statement).toBe(
            'UPDATE session SET repository = repository:`repo`, checkout = checkout:`checkout-a` WHERE (cwd = "/tmp/worktree-a" OR string::starts_with(cwd ?? "", "/tmp/worktree-a/")) RETURN NONE;',
        );
        expect(statement).not.toContain("/tmp/worktree-ab");
    });

    test("excludes nested checkout roots from parent checkout session linking", () => {
        expect(
            nestedCheckoutPaths("/repo", [
                "/repo",
                "/repo/.worktrees/feature-a",
                "/repo/.worktrees/feature-a/packages/app",
                "/repo2/.worktrees/feature-b",
            ]),
        ).toEqual([
            "/repo/.worktrees/feature-a/packages/app",
            "/repo/.worktrees/feature-a",
        ]);

        const where = buildSessionCheckoutWhere("/repo", ["/repo/.worktrees/feature-a"]);
        const statement = buildSessionCheckoutUpdateStatement(
            "/repo",
            "repository:`repo`",
            "checkout:`main`",
            ["/repo/.worktrees/feature-a"],
        );

        expect(where).toBe(
            '((cwd = "/repo" OR string::starts_with(cwd ?? "", "/repo/")) AND NOT ((cwd = "/repo/.worktrees/feature-a" OR string::starts_with(cwd ?? "", "/repo/.worktrees/feature-a/"))))',
        );
        expect(statement).toContain("checkout = checkout:`main`");
        expect(statement).toContain("AND NOT");
        expect(statement).toContain("/repo/.worktrees/feature-a/");
    });

    test("derives repository display name from remote before checkout path", () => {
        expect(
            deriveRepositoryDisplayName(
                "github.com/noktadev/quera",
                "/Users/necmttn/Projects/quera/.claude/worktrees/fix-kg",
            ),
        ).toBe("quera");
        expect(deriveRepositoryDisplayName(null, "/tmp/worktree-a")).toBe("worktree-a");
    });
});
