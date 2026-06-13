import { describe, expect, test } from "bun:test";
import { parseSparBrief, renderSparBrief, renderSparReport, scoreSpar } from "./spar.ts";
import type { SparBrief, SparMetrics } from "./spar.ts";

const baseMetrics = (o: Partial<SparMetrics> = {}): SparMetrics => ({
    costUsd: 1.20,
    turns: 18,
    wallMs: 600_000,
    repairLines: 40,
    episodes: 3,
    landed: true,
    ...o,
});

const brief: SparBrief = {
    id: "ab12cd34-2026-06-13",
    createdAt: "2026-06-13T10:00:00.000Z",
    prompt: "Add the foo endpoint",
    parentSha: "ab12cd34",
    baselineSession: "session:base",
    worktree: ".claude/worktrees/dojo-spar-ab12cd34-2026-06-13",
    baseline: baseMetrics(),
    delta: "skill: tdd ON",
};

describe("scoreSpar", () => {
    test("win: cheaper + still landed + repair not worse", () => {
        const s = scoreSpar(brief.baseline, baseMetrics({ costUsd: 0.80, repairLines: 30 }));
        expect(s.verdict).toBe("win");
        expect(s.deltas.costUsd).toBeCloseTo(-0.40, 5);
        expect(s.deltas.repairLines).toBe(-10);
    });
    test("regression: lost landed", () => {
        expect(scoreSpar(brief.baseline, baseMetrics({ landed: false })).verdict).toBe("regression");
    });
    test("regression: clearly costlier", () => {
        expect(scoreSpar(brief.baseline, baseMetrics({ costUsd: 2.0 })).verdict).toBe("regression");
    });
    test("mixed: cheaper but more repair", () => {
        expect(scoreSpar(brief.baseline, baseMetrics({ costUsd: 0.9, repairLines: 80 })).verdict).toBe("mixed");
    });
});

describe("renderSparBrief / parseSparBrief roundtrip", () => {
    test("brief renders frontmatter + JSON baseline block and parses back", () => {
        const md = renderSparBrief(brief);
        expect(md).toContain("# Spar: ab12cd34-2026-06-13");
        expect(md).toContain("git worktree add");
        expect(md).toContain(brief.prompt);
        const parsed = parseSparBrief(md);
        expect(parsed?.id).toBe(brief.id);
        expect(parsed?.baseline.costUsd).toBe(1.20);
        expect(parsed?.parentSha).toBe("ab12cd34");
    });
    test("non-brief content -> null", () => {
        expect(parseSparBrief("nope")).toBeNull();
    });
});

describe("renderSparReport", () => {
    test("receipt table with baseline|variant|delta + verdict", () => {
        const score = scoreSpar(brief.baseline, baseMetrics({ costUsd: 0.80 }));
        const md = renderSparReport(score, brief);
        expect(md).toContain("# Spar report: ab12cd34-2026-06-13");
        expect(md).toContain("skill: tdd ON");
        expect(md).toContain("cost");
        expect(md).toContain("WIN");
    });
});
