export type ProjectCommandName =
    | "typecheck"
    | "test"
    | "lint"
    | "format"
    | "build"
    | "db"
    | "dev"
    | "unknown";

export type VerificationSeverity = "required" | "recommended" | "info";

export interface ProjectFileChange {
    readonly path: string;
    readonly status: string;
    readonly staged: boolean;
    readonly unstaged: boolean;
    readonly untracked: boolean;
    readonly lang: string | null;
}

export interface GitState {
    readonly root: string | null;
    readonly cwd: string;
    readonly branch: string | null;
    readonly head: string | null;
    readonly dirty: boolean;
    readonly changes: ReadonlyArray<ProjectFileChange>;
}

export interface PackageInfo {
    readonly packageJsonPath: string | null;
    readonly packageManager: string | null;
    readonly scripts: Readonly<Record<string, string>>;
    readonly dependencies: ReadonlyArray<string>;
    readonly devDependencies: ReadonlyArray<string>;
}

export interface InstructionMatch {
    readonly file: string;
    readonly line: number;
    readonly text: string;
    readonly reason: string;
}

export interface StackSignal {
    readonly name: string;
    readonly confidence: "high" | "medium" | "low";
    readonly evidence: ReadonlyArray<string>;
}

export interface ProjectStack {
    readonly package: PackageInfo;
    readonly signals: ReadonlyArray<StackSignal>;
    readonly instructions: ReadonlyArray<InstructionMatch>;
}

export interface VerificationCheck {
    readonly id: string;
    readonly severity: VerificationSeverity;
    readonly title: string;
    readonly reason: string;
    readonly command: string | null;
    readonly relatedFiles: ReadonlyArray<string>;
}

export interface DiagnosticConfig {
    readonly healthUrl: string | null;
    readonly statusUrl: string | null;
    readonly errorsUrl: string | null;
    readonly timeoutMs: number;
}

export interface DiagnosticIssue {
    readonly severity: "critical" | "warning" | "info";
    readonly title: string;
    readonly detail: string;
    readonly suggestedAction: string | null;
    readonly traceId: string | null;
    readonly service: string | null;
}

export interface LiveDiagnostics {
    readonly configured: boolean;
    readonly available: boolean;
    readonly source: string | null;
    readonly status: "green" | "yellow" | "red" | "unknown";
    readonly issues: ReadonlyArray<DiagnosticIssue>;
    readonly localUrls: ReadonlyArray<string>;
    readonly checkedAt: string;
    readonly error: string | null;
}

export interface ProjectContext {
    readonly kind: "agentctl.project.context";
    readonly generatedAt: string;
    readonly git: GitState;
    readonly stack: ProjectStack;
    readonly verification: ReadonlyArray<VerificationCheck>;
    readonly diagnostics: LiveDiagnostics;
}

export interface ProjectVerification {
    readonly kind: "agentctl.project.verify";
    readonly generatedAt: string;
    readonly git: GitState;
    readonly checks: ReadonlyArray<VerificationCheck>;
    readonly diagnostics: LiveDiagnostics;
}

export type GuidanceEvidenceStrength =
    | "tracked"
    | "untracked"
    | "plugin-cache"
    | "generated"
    | "unknown";

export interface GuidanceSource {
    readonly path: string;
    readonly kind: "file" | "directory";
    readonly scope: "repository" | "global" | "plugin-cache" | "unknown";
    readonly provider: "claude" | "codex" | "agents" | "shared" | "unknown";
    readonly evidenceStrength: GuidanceEvidenceStrength;
    readonly gitRoot: string | null;
    readonly tracked: boolean;
}

export interface GuidanceRevision {
    readonly sourcePath: string;
    readonly scope: GuidanceSource["scope"];
    readonly contentHash: string;
    readonly evidenceStrength: GuidanceEvidenceStrength;
    readonly observedAt: string;
    readonly commitEvidence: string | null;
    readonly fileEvidence: string | null;
}

export interface AgentToolingSignal {
    readonly name: string;
    readonly layer: "perception" | "representation" | "verification" | "boundary";
    readonly source: "package-script" | "dependency" | "global-command" | "git" | "observed";
    readonly evidence: string;
}

export interface HarnessDoctorFinding {
    readonly layer: AgentToolingSignal["layer"];
    readonly status: "strong" | "ok" | "weak";
    readonly title: string;
    readonly evidence: ReadonlyArray<string>;
    readonly recommendation: string | null;
}

export interface HarnessLearningCandidate {
    readonly title: string;
    readonly problem: string;
    readonly pattern: string;
    readonly harnessLayer: AgentToolingSignal["layer"];
    readonly risk: { readonly kind: string; readonly level: "low" | "medium" | "high" };
    readonly appliesWhen: ReadonlyArray<string>;
    readonly avoidWhen: ReadonlyArray<string>;
    readonly evidenceSummary: ReadonlyArray<string>;
    readonly suggestedIntervention: string;
    readonly confidence: "low" | "medium" | "high";
}

export interface InterventionSuggestion {
    readonly title: string;
    readonly strength: "advisory" | "workflow" | "automation" | "guardrail" | "hard_boundary";
    readonly approvalRequired: boolean;
    readonly expectedEffect: string;
    readonly reviewCriteria: ReadonlyArray<string>;
}

export interface InterventionObservation {
    readonly target: string;
    readonly status: "not_started" | "observed" | "needs_more_evidence";
    readonly before: Readonly<Record<string, number>>;
    readonly after: Readonly<Record<string, number>> | null;
    readonly metrics: Readonly<Record<string, number>>;
    readonly notes: ReadonlyArray<string>;
}

export interface ProjectHarnessReport {
    readonly kind: "agentctl.project.harness";
    readonly generatedAt: string;
    readonly git: GitState;
    readonly guidanceSources: ReadonlyArray<GuidanceSource>;
    readonly guidanceRevisions: ReadonlyArray<GuidanceRevision>;
    readonly stacks: ProjectStack["signals"];
    readonly agentTooling: ReadonlyArray<AgentToolingSignal>;
    readonly doctor: ReadonlyArray<HarnessDoctorFinding>;
    readonly learningCandidates: ReadonlyArray<HarnessLearningCandidate>;
    readonly interventions: ReadonlyArray<InterventionSuggestion>;
    readonly observations: ReadonlyArray<InterventionObservation>;
}
