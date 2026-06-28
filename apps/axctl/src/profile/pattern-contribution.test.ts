import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AX_ATTRIBUTION_MD } from "@ax/lib/shared/attribution";
import { GitHubEnvTest } from "./github-env.ts";
import { openPatternContribution, patternFilePath, REGISTRY_REPO } from "./pattern-contribution.ts";
import type { TastePattern } from "./schema.ts";

const pattern: TastePattern = {
    category: "workflow",
    name: "small-review-loops",
    summary: "Review the diff in small increments before expanding scope.",
    evidence: { sessions: 4, confidence: 0.8, last_reinforced: "2026-06-20", trend: "stable" },
};

const run = <A, E>(eff: Effect.Effect<A, E, never>) => Effect.runPromise(eff);

describe("patternFilePath", () => {
    test("maps a taste pattern to the community/patterns category path", () => {
        expect(patternFilePath(pattern)).toBe("community/patterns/workflow/small-review-loops.json");
    });
});

describe("openPatternContribution", () => {
    test("opens a fork PR with a single community pattern file based on upstream main", async () => {
        const login = "Necmttn";
        const fork = `${login}/ax`;
        const t = GitHubEnvTest({
            login,
            responses: {
                [`POST /repos/${REGISTRY_REPO}/forks`]: { full_name: fork },
                [`GET /repos/${REGISTRY_REPO}/git/ref/heads/main`]: { object: { sha: "base" } },
                [`GET /repos/${REGISTRY_REPO}/git/commits/base`]: { tree: { sha: "tree0" } },
                [`POST /repos/${fork}/git/blobs`]: { sha: "blob1" },
                [`POST /repos/${fork}/git/trees`]: { sha: "tree1" },
                [`POST /repos/${fork}/git/commits`]: { sha: "commit1" },
                [`POST /repos/${fork}/git/refs`]: { ref: "refs/heads/ax-pattern-workflow-small-review-loops" },
                [`POST /repos/${REGISTRY_REPO}/pulls`]: { html_url: "https://github.com/Necmttn/ax/pull/999" },
            },
        });

        const result = await run(openPatternContribution({ pattern }).pipe(Effect.provide(t.layer)));

        expect(result).toEqual({
            status: "pr-opened",
            prUrl: "https://github.com/Necmttn/ax/pull/999",
            path: "community/patterns/workflow/small-review-loops.json",
        });
        const paths = t.calls.map((c) => `${c.method} ${c.path}`);
        expect(paths).toEqual([
            `GET /repos/${REGISTRY_REPO}/contents/community/patterns/workflow/small-review-loops.json`,
            `POST /repos/${REGISTRY_REPO}/forks`,
            `GET /repos/${REGISTRY_REPO}/git/ref/heads/main`,
            `GET /repos/${REGISTRY_REPO}/git/commits/base`,
            `POST /repos/${fork}/git/blobs`,
            `POST /repos/${fork}/git/trees`,
            `POST /repos/${fork}/git/commits`,
            `POST /repos/${fork}/git/refs`,
            `POST /repos/${REGISTRY_REPO}/pulls`,
        ]);
        expect(t.calls.find((c) => c.path === `/repos/${fork}/git/trees`)?.body).toEqual({
            base_tree: "tree0",
            tree: [{
                path: "community/patterns/workflow/small-review-loops.json",
                mode: "100644",
                type: "blob",
                sha: "blob1",
            }],
        });
        expect(t.calls.find((c) => c.path === `/repos/${fork}/git/commits`)?.body).toMatchObject({
            parents: ["base"],
        });
        expect(t.calls.find((c) => c.path === `/repos/${REGISTRY_REPO}/pulls`)?.body).toMatchObject({
            head: "Necmttn:ax-pattern-workflow-small-review-loops",
            base: "main",
            body: expect.stringContaining(AX_ATTRIBUTION_MD),
        });
    });

    test("fails before forking when the community pattern filename already exists", async () => {
        const t = GitHubEnvTest({
            login: "necmttn",
            responses: {
                [`GET /repos/${REGISTRY_REPO}/contents/community/patterns/workflow/small-review-loops.json`]: {
                    sha: "existing",
                },
            },
        });

        const outcome = await run(
            openPatternContribution({ pattern }).pipe(
                Effect.map(() => "ok" as const),
                Effect.catchTag("PatternContributionError", (e) => Effect.succeed(e.message)),
                Effect.provide(t.layer),
            ),
        );

        expect(outcome).toContain("already exists");
        expect(t.calls).toHaveLength(1);
    });
});
