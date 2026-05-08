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
