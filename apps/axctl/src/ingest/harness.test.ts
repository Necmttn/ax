import { describe, expect, test } from "bun:test";
import {
    buildHarnessIngestRows,
    guidanceRevisionKey,
    guidanceSourceKey,
    stackKey,
} from "./harness.ts";
import type { ProjectHarnessReport } from "../project/types.ts";

const report: ProjectHarnessReport = {
    kind: "ax.project.harness",
    generatedAt: "2026-05-11T12:00:00.000Z",
    git: {
        root: "/repo",
        cwd: "/repo",
        branch: "main",
        head: "abc123",
        dirty: true,
        changes: [],
    },
    guidanceSources: [
        {
            path: "/repo/AGENTS.md",
            kind: "file",
            scope: "repository",
            provider: "agents",
            evidenceStrength: "tracked",
            gitRoot: "/repo",
            tracked: true,
        },
    ],
    guidanceRevisions: [
        {
            sourcePath: "/repo/AGENTS.md",
            scope: "repository",
            contentHash: "abcdef1234567890",
            evidenceStrength: "tracked",
            observedAt: "2026-05-11T12:00:00.000Z",
            commitEvidence: "abc123",
            fileEvidence: "/repo/AGENTS.md",
        },
    ],
    stacks: [
        { name: "typescript", confidence: "high", evidence: ["typescript dependency"] },
    ],
    agentTooling: [
        { name: "typecheck", layer: "verification", source: "package-script", evidence: "tsc --noEmit" },
    ],
    doctor: [],
    learningCandidates: [
        {
            title: "Block main-branch edits in multi-agent projects",
            problem: "Agents edited main.",
            pattern: "Escalate guidance to workflow.",
            harnessLayer: "boundary",
            risk: { kind: "branch_safety", level: "high" },
            appliesWhen: ["multi-agent work"],
            avoidWhen: ["hotfix approval"],
            evidenceSummary: ["current branch: main"],
            suggestedIntervention: "Confirm branch before writes.",
            confidence: "medium",
        },
    ],
    interventions: [
        {
            title: "Block main-branch edits in multi-agent projects",
            strength: "workflow",
            approvalRequired: true,
            expectedEffect: "Reduce main branch writes.",
            reviewCriteria: ["write attempts on main"],
        },
    ],
    observations: [
        {
            target: "main-branch guardrail",
            status: "observed",
            before: { graphCommitsFromMain: 3 },
            after: null,
            metrics: { writeRiskOnMain: 1 },
            notes: ["Observed current risk."],
        },
    ],
};

describe("harness ingest row builders", () => {
    test("keys are deterministic and scoped by semantic identity", () => {
        expect(guidanceSourceKey(report.guidanceSources[0])).toBe(guidanceSourceKey(report.guidanceSources[0]));
        expect(guidanceRevisionKey(report.guidanceRevisions[0])).toMatch(/^[0-9a-f]{32}$/);
        expect(stackKey(report.stacks[0])).toMatch(/^[0-9a-f]{32}$/);
    });

    test("builds guidance and stack rows", () => {
        const rows = buildHarnessIngestRows(report);
        expect(rows.guidanceSources[0]).toMatchObject({ evidence_strength: "tracked" });
        expect(rows.guidanceRevisions[0]).toMatchObject({ content_hash: "abcdef1234567890" });
        expect(rows.stacks[0]).toMatchObject({ name: "typescript" });
    });
});
