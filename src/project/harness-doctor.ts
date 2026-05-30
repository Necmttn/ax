import type {
    AgentToolingSignal,
    GitState,
    GuidanceRevision,
    GuidanceSource,
    HarnessDoctorFinding,
    HarnessLearningCandidate,
    InterventionObservation,
    InterventionSuggestion,
    ProjectHarnessReport,
    ProjectStack,
} from "./types.ts";

export interface MainBranchGraphEvidence {
    readonly editedOnMain: number;
    readonly commitsFromMain: number;
    readonly latestEditedPath: string | null;
}

export interface HarnessDoctorEvidence {
    readonly generatedAt?: string;
    readonly git: GitState;
    readonly stack: ProjectStack;
    readonly guidanceSources: ReadonlyArray<GuidanceSource>;
    readonly guidanceRevisions: ReadonlyArray<GuidanceRevision>;
    readonly staticTooling: ReadonlyArray<AgentToolingSignal>;
    readonly observedTooling: ReadonlyArray<AgentToolingSignal>;
    readonly mainBranchGraph: MainBranchGraphEvidence;
}

export interface HarnessDoctorReportBuilder {
    readonly build: (evidence: HarnessDoctorEvidence) => ProjectHarnessReport;
}

function finding(
    layer: HarnessDoctorFinding["layer"],
    signals: ReadonlyArray<AgentToolingSignal>,
    title: string,
    recommendation: string,
): HarnessDoctorFinding {
    const evidence = signals.filter((s) => s.layer === layer).map((s) => `${s.name}: ${s.evidence}`);
    return {
        layer,
        status: evidence.length >= 2 ? "strong" : evidence.length === 1 ? "ok" : "weak",
        title,
        evidence,
        recommendation: evidence.length === 0 ? recommendation : null,
    };
}

export function buildHarnessDoctor(tooling: ReadonlyArray<AgentToolingSignal>): ReadonlyArray<HarnessDoctorFinding> {
    return [
        finding("perception", tooling, "Agent perception tools", "Expose rg/fd/fzf or equivalent search commands."),
        finding("representation", tooling, "Agent-readable representation", "Expose jq/bat/delta or structured JSON outputs."),
        finding("verification", tooling, "Fast verification loop", "Add reliable typecheck/test/lint/build scripts."),
        finding("boundary", tooling, "Boundary controls", "Document branch/worktree policy or add scoped guardrails."),
    ];
}

function hasWriteRiskOnMain(git: GitState): boolean {
    if (git.branch !== "main" && git.branch !== "master") return false;
    return git.changes.some((change) => !change.path.endsWith(".md") || change.path === "package.json");
}

export function mainBranchLearning(
    git: GitState,
    sources: ReadonlyArray<GuidanceSource>,
): HarnessLearningCandidate {
    const hasGuidance = sources.some((s) => /AGENTS\.md|CLAUDE\.md|settings\.json|hooks?/.test(s.path));
    const evidence = [
        `current branch: ${git.branch ?? "unknown"}`,
        `dirty files: ${git.changes.length}`,
        hasWriteRiskOnMain(git) ? "current checkout has write-risk changes on main/master" : "no current write-risk changes on main/master",
        hasGuidance ? "guidance source exists for branch policy" : "no branch-policy guidance source detected",
    ];
    return {
        title: "Block main-branch edits in multi-agent projects",
        problem: "Agents can ignore advisory guidance and edit or commit on main during coordinated work.",
        pattern: "Start with advisory guidance, then escalate to workflow automation or a scoped guardrail when violations recur.",
        harnessLayer: "boundary",
        risk: { kind: "branch_safety", level: "high" },
        appliesWhen: ["multi-agent work", "shared repository", "non-trivial edits"],
        avoidWhen: ["explicit hotfix approval", "read-only exploration", "single-user throwaway repo"],
        evidenceSummary: evidence,
        suggestedIntervention: "Recommend branch/worktree confirmation before write-risk actions; escalate to hook only after recurrence or high risk.",
        confidence: hasWriteRiskOnMain(git) ? "medium" : "low",
    };
}

export function interventionForMainBranch(candidate: HarnessLearningCandidate): InterventionSuggestion {
    return {
        title: candidate.title,
        strength: candidate.confidence === "medium" ? "workflow" : "advisory",
        approvalRequired: true,
        expectedEffect: "Reduce write-risk actions on main/master during multi-agent work.",
        reviewCriteria: [
            "sessions started on main for non-trivial work",
            "write/edit/commit/push attempts on main",
            "user overrides and false positives",
            "branch or worktree adoption after recommendation",
        ],
    };
}

export function observationForMainBranch(
    git: GitState,
    graph: MainBranchGraphEvidence = {
        editedOnMain: 0,
        commitsFromMain: 0,
        latestEditedPath: null,
    },
): InterventionObservation {
    const currentRisk = hasWriteRiskOnMain(git);
    const graphRisk = graph.editedOnMain > 0 || graph.commitsFromMain > 0;
    return {
        target: "main-branch guardrail",
        status: currentRisk || graphRisk ? "observed" : "needs_more_evidence",
        metrics: {
            dirtyFiles: git.changes.length,
            writeRiskOnMain: currentRisk ? 1 : 0,
            graphEditedOnMain: graph.editedOnMain,
            graphCommitsFromMain: graph.commitsFromMain,
        },
        before: {
            graphEditedOnMain: graph.editedOnMain,
            graphCommitsFromMain: graph.commitsFromMain,
        },
        after: null,
        notes: [
            ...(currentRisk ? ["Current checkout is on main/master with write-risk changes."] : []),
            ...(graphRisk
                ? [`Graph has main/master write-risk evidence; latest edited path: ${graph.latestEditedPath ?? "unknown"}.`]
                : []),
            ...(!currentRisk && !graphRisk
                ? ["Need more ingested session history to measure recurrence over time."]
                : []),
        ],
    };
}

export function buildHarnessDoctorReport(evidence: HarnessDoctorEvidence): ProjectHarnessReport {
    const agentTooling = [...evidence.staticTooling, ...evidence.observedTooling];
    const candidate = mainBranchLearning(evidence.git, evidence.guidanceSources);
    return {
        kind: "ax.project.harness",
        generatedAt: evidence.generatedAt ?? new Date().toISOString(),
        git: evidence.git,
        guidanceSources: evidence.guidanceSources,
        guidanceRevisions: evidence.guidanceRevisions,
        stacks: evidence.stack.signals,
        agentTooling,
        doctor: buildHarnessDoctor(agentTooling),
        learningCandidates: [candidate],
        interventions: [interventionForMainBranch(candidate)],
        observations: [observationForMainBranch(evidence.git, evidence.mainBranchGraph)],
    };
}

export const defaultHarnessDoctorReportBuilder = {
    build: buildHarnessDoctorReport,
} satisfies HarnessDoctorReportBuilder;
