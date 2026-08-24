import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AX_ATTRIBUTION_MD } from "@ax/lib/shared/attribution";
import { scoreSpar, type SparBrief, type SparScore } from "../dojo/spar.ts";
import { GitHubEnvTest } from "./github-env.ts";
import {
    buildCommunityStudy,
    openStudyContribution,
    studyFilePath,
    type CommunityStudy,
} from "./study-contribution.ts";
import { REGISTRY_REPO } from "./pattern-contribution.ts";

const baseline = { costUsd: 1.2, turns: 18, wallMs: 600_000, repairLines: 40, episodes: 3, landed: true };
const variant = { costUsd: 0.8, turns: 14, wallMs: 480_000, repairLines: 30, episodes: 2, landed: true };
const brief: SparBrief = {
    id: "ab12cd34-2026-06-13",
    createdAt: "2026-06-13T10:00:00.000Z",
    prompt: "secret task text",
    parentSha: "ab12cd34",
    baselineSession: "secret-session",
    worktree: ".claude/worktrees/secret-path",
    baseline,
    baselineIsSubagent: false,
    delta: "secret intervention text",
};
const score: SparScore = { ...scoreSpar(baseline, variant), id: brief.id, variantSession: "secret-variant" };

describe("buildCommunityStudy", () => {
    test("builds a closed, content-stripped study", () => {
        const study = buildCommunityStudy({ brief, score, briefBytes: "brief bytes", scoreBytes: "score bytes" });
        expect(study.protocol).toEqual({ id: "verification-churn", version: 1 });
        expect(study.evidence_class).toBe("self_reported");
        expect(study.outcome).toBe("improved");
        expect(study.metrics.cost_usd.delta).toBeCloseTo(-0.4);
        const json = JSON.stringify(study);
        expect(json).not.toContain(brief.prompt);
        expect(json).not.toContain(brief.delta);
        expect(json).not.toContain(brief.baselineSession);
        expect(json).not.toContain(score.variantSession);
        expect(json).not.toContain(brief.worktree);
    });

    test("rejects a score for a different spar", () => {
        expect(() => buildCommunityStudy({ brief, score: { ...score, id: "other" }, briefBytes: "brief", scoreBytes: "score" }))
            .toThrow(/does not match/);
    });
});

describe("openStudyContribution", () => {
    test("opens one reviewed PR for one study file", async () => {
        const study: CommunityStudy = buildCommunityStudy({ brief, score, briefBytes: "brief bytes", scoreBytes: "score bytes" });
        const path = studyFilePath(study);
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
                [`POST /repos/${fork}/git/refs`]: { ref: "ok" },
                [`POST /repos/${REGISTRY_REPO}/pulls`]: { html_url: "https://github.com/Necmttn/ax/pull/1000" },
            },
        });

        const result = await Effect.runPromise(openStudyContribution({ study }).pipe(Effect.provide(t.layer)));
        expect(result.path).toBe(path);
        expect(t.calls.map((call) => `${call.method} ${call.path}`)[0]).toBe(`GET /repos/${REGISTRY_REPO}/contents/${path}`);
        expect(t.calls.find((call) => call.path === `/repos/${REGISTRY_REPO}/pulls`)?.body).toMatchObject({
            base: "main",
            body: expect.stringContaining(AX_ATTRIBUTION_MD),
        });
    });
});
