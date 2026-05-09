import { describe, expect, test } from "bun:test";
import { buildTouchedRelationStatements } from "./git.ts";

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
});
