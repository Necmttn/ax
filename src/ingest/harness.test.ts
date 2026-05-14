import { describe, expect, test } from "bun:test";
import {
    agentToolingKey,
    buildHarnessIngestStatements,
    guidanceRevisionKey,
    guidanceSourceKey,
    harnessLearningKey,
    interventionKey,
    interventionObservationKey,
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

describe("harness ingest statement builders", () => {
    test("keys are deterministic and scoped by semantic identity", () => {
        expect(guidanceSourceKey(report.guidanceSources[0])).toBe(guidanceSourceKey(report.guidanceSources[0]));
        expect(guidanceRevisionKey(report.guidanceRevisions[0])).toContain("abcdef1234567890");
        expect(agentToolingKey(report.agentTooling[0])).toContain("verification");
        expect(harnessLearningKey(report.learningCandidates[0])).toContain("boundary");
        expect(interventionKey(report.interventions[0])).toContain("workflow");
        expect(interventionObservationKey(report.observations[0], report.generatedAt)).toBe(
            interventionObservationKey(report.observations[0], report.generatedAt),
        );
    });

    test("writes every harness report section to the matching schema table", () => {
        const sql = buildHarnessIngestStatements(report).join("\n");

        expect(sql).toContain("UPSERT guidance_source:");
        expect(sql).toContain("UPSERT guidance_revision:");
        expect(sql).toContain("UPSERT stack:");
        expect(sql).toContain("UPSERT agent_tooling:");
        expect(sql).toContain("UPSERT harness_learning:");
        expect(sql).toContain("UPSERT intervention:");
        expect(sql).toContain("UPSERT intervention_observation:");
        expect(sql).toContain("evidence_strength: \"tracked\"");
        expect(sql).toContain("content_hash: \"abcdef1234567890\"");
        expect(sql).toContain("metrics_before: \"{\\\"graphCommitsFromMain\\\":3}\"");
        expect(sql).toContain("metrics_after: NONE");
    });
});
