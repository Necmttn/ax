import { describe, expect, test } from "bun:test";
import { buildHarnessDoctorReport } from "./harness-doctor.ts";
import type {
    AgentToolingSignal,
    GitState,
    GuidanceRevision,
    GuidanceSource,
    ProjectStack,
} from "./types.ts";

const gitOnMainWithRisk: GitState = {
    root: "/repo",
    cwd: "/repo",
    branch: "main",
    head: "abc123",
    dirty: true,
    changes: [
        {
            path: "src/app.ts",
            status: "M",
            staged: false,
            unstaged: true,
            untracked: false,
            lang: "typescript",
        },
    ],
};

const stack: ProjectStack = {
    package: {
        packageJsonPath: "/repo/package.json",
        packageManager: "bun",
        scripts: {},
        dependencies: [],
        devDependencies: [],
    },
    signals: [{ name: "TypeScript", confidence: "high", evidence: ["tsconfig.json"] }],
    instructions: [],
};

const guidanceSources: ReadonlyArray<GuidanceSource> = [
    {
        path: "/repo/AGENTS.md",
        kind: "file",
        scope: "repository",
        provider: "agents",
        evidenceStrength: "tracked",
        gitRoot: "/repo",
        tracked: true,
    },
];

const guidanceRevisions: ReadonlyArray<GuidanceRevision> = [
    {
        sourcePath: "/repo/AGENTS.md",
        scope: "repository",
        contentHash: "abcdef0123456789",
        evidenceStrength: "tracked",
        observedAt: "2026-05-30T00:00:00.000Z",
        commitEvidence: "abc123",
        fileEvidence: "/repo/AGENTS.md",
    },
];

const staticTooling: ReadonlyArray<AgentToolingSignal> = [
    { name: "typecheck", layer: "verification", source: "package-script", evidence: "tsc --noEmit" },
    { name: "git", layer: "boundary", source: "git", evidence: "repository root /repo" },
];

const observedTooling: ReadonlyArray<AgentToolingSignal> = [
    { name: "rg", layer: "perception", source: "observed", evidence: "12 observed calls in 30d" },
    { name: "test", layer: "verification", source: "observed", evidence: "4 observed calls in 30d" },
];

describe("buildHarnessDoctorReport", () => {
    test("builds the harness report from fake collected evidence", () => {
        const report = buildHarnessDoctorReport({
            generatedAt: "2026-05-30T01:02:03.000Z",
            git: gitOnMainWithRisk,
            stack,
            guidanceSources,
            guidanceRevisions,
            staticTooling,
            observedTooling,
            mainBranchGraph: {
                editedOnMain: 2,
                commitsFromMain: 1,
                latestEditedPath: "src/app.ts",
            },
        });

        expect(report.kind).toBe("ax.project.harness");
        expect(report.generatedAt).toBe("2026-05-30T01:02:03.000Z");
        expect(report.git).toBe(gitOnMainWithRisk);
        expect(report.guidanceSources).toBe(guidanceSources);
        expect(report.guidanceRevisions).toBe(guidanceRevisions);
        expect(report.stacks).toBe(stack.signals);
        expect(report.agentTooling).toEqual([...staticTooling, ...observedTooling]);
        expect(report.doctor.find((finding) => finding.layer === "verification")).toMatchObject({
            status: "strong",
            recommendation: null,
        });
        expect(report.learningCandidates).toHaveLength(1);
        expect(report.learningCandidates[0]?.confidence).toBe("medium");
        expect(report.interventions[0]).toMatchObject({
            title: "Block main-branch edits in multi-agent projects",
            strength: "workflow",
        });
        expect(report.observations[0]).toMatchObject({
            status: "observed",
            metrics: {
                dirtyFiles: 1,
                writeRiskOnMain: 1,
                graphEditedOnMain: 2,
                graphCommitsFromMain: 1,
            },
        });
    });

    test("uses current time only when generatedAt is not injected", () => {
        const before = Date.now();
        const report = buildHarnessDoctorReport({
            git: { ...gitOnMainWithRisk, branch: "feature/harness", dirty: false, changes: [] },
            stack,
            guidanceSources: [],
            guidanceRevisions: [],
            staticTooling: [],
            observedTooling: [],
            mainBranchGraph: {
                editedOnMain: 0,
                commitsFromMain: 0,
                latestEditedPath: null,
            },
        });
        const after = Date.now();

        const generatedAt = Date.parse(report.generatedAt);
        expect(generatedAt).toBeGreaterThanOrEqual(before);
        expect(generatedAt).toBeLessThanOrEqual(after);
        expect(report.learningCandidates[0]?.confidence).toBe("low");
        expect(report.observations[0]?.status).toBe("needs_more_evidence");
    });
});
