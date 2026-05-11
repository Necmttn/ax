import { describe, expect, test } from "bun:test";
import { classifyCommitMessage, deriveClosureRows } from "./closure.ts";

describe("closure derivation", () => {
    test("classifies conventional commit messages", () => {
        expect(classifyCommitMessage("feat: add evidence graph")).toBe("feature");
        expect(classifyCommitMessage("fix: dedupe touched edges")).toBe("fix");
        expect(classifyCommitMessage("docs: update readme")).toBe("docs");
        expect(classifyCommitMessage("refactor: simplify ingest")).toBe("refactor");
        expect(classifyCommitMessage("test: cover closure")).toBe("test");
        expect(classifyCommitMessage("chore: release")).toBe("chore");
        expect(classifyCommitMessage("chore: add release config")).toBe("chore");
        expect(classifyCommitMessage("Revert \"feat: add shell\"")).toBe("chore");
    });

    test("links later fixes to feature commits by overlapping files", () => {
        const rows = deriveClosureRows({
            commits: [
                {
                    id: "commit:`feat1`",
                    message: "feat: add ingest pipeline",
                    repository: "repository:`repo1`",
                    ts: "2026-05-01T00:00:00.000Z",
                },
                {
                    id: "commit:`fix1`",
                    message: "fix: stabilize ingest pipeline",
                    repository: "repository:`repo1`",
                    ts: "2026-05-03T00:00:00.000Z",
                },
            ],
            touched: [
                { in: "commit:`feat1`", path: "src/ingest/codex.ts" },
                { in: "commit:`fix1`", path: "src/ingest/codex.ts" },
            ],
            sessionHealth: [
                { session: "session:`s1`", tool_errors: 7, context_pressure: "medium" },
                { session: "session:`s2`", user_corrections: 1, context_pressure: "low" },
                { session: "session:`s3`", tool_errors: 0, context_pressure: "high" },
            ],
        });

        expect(rows.fixChains).toContainEqual(expect.objectContaining({
            featureKey: "feat1",
            fixKey: "fix1",
            overlapFiles: ["src/ingest/codex.ts"],
        }));
        expect(rows.skillCandidates.map((candidate) => candidate.name)).toContain("Ingest pipeline regression checklist");
        expect(rows.skillCandidates.map((candidate) => candidate.name)).toContain("Session closure quality guardrail");
    });
});
