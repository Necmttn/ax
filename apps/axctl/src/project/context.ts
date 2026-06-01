import { Effect } from "effect";
import { queryLiveDiagnostics } from "./diagnostics.ts";
import { getGitState } from "./git.ts";
import { loadProjectStack } from "./stack.ts";
import { deriveVerificationChecks } from "./verify.ts";
import { buildProjectHarnessReport } from "./harness.ts";
import { SurrealClient } from "@ax/lib/db";
import { ProcessService } from "@ax/lib/process";
import type { DbError } from "@ax/lib/errors";
import type { ProjectContext, ProjectHarnessReport, ProjectVerification } from "./types.ts";

interface ProjectGrounding {
    readonly generatedAt: string;
    readonly git: ProjectContext["git"];
    readonly stack: ProjectContext["stack"];
    readonly checks: ProjectContext["verification"];
    readonly diagnostics: ProjectContext["diagnostics"];
}

const buildProjectGrounding = (cwd = process.cwd()): Effect.Effect<ProjectGrounding, never, ProcessService> =>
    Effect.gen(function* () {
        const git = yield* getGitState(cwd);
        const stack = yield* loadProjectStack(git.root);
        const checks = deriveVerificationChecks({ git, stack });
        const diagnostics = yield* queryLiveDiagnostics(git.root);
        return {
            generatedAt: new Date().toISOString(),
            git,
            stack,
            checks,
            diagnostics,
        };
    });

export const buildProjectContext = (cwd = process.cwd()): Effect.Effect<ProjectContext, never, ProcessService> =>
    Effect.gen(function* () {
        const grounding = yield* buildProjectGrounding(cwd);
        return {
            kind: "ax.project.context",
            generatedAt: grounding.generatedAt,
            git: grounding.git,
            stack: grounding.stack,
            verification: grounding.checks,
            diagnostics: grounding.diagnostics,
        };
    });

export const buildProjectVerification = (cwd = process.cwd()): Effect.Effect<ProjectVerification, never, ProcessService> =>
    Effect.gen(function* () {
        const grounding = yield* buildProjectGrounding(cwd);
        return {
            kind: "ax.project.verify",
            generatedAt: grounding.generatedAt,
            git: grounding.git,
            checks: grounding.checks,
            diagnostics: grounding.diagnostics,
        };
    });

export const buildProjectHarness = (
    cwd = process.cwd(),
): Effect.Effect<ProjectHarnessReport, DbError, SurrealClient | ProcessService> =>
    buildProjectHarnessReport(cwd);
