import { Effect } from "effect";
import { queryLiveDiagnostics } from "./diagnostics.ts";
import { getGitState } from "./git.ts";
import { loadProjectStack } from "./stack.ts";
import { deriveVerificationChecks } from "./verify.ts";
import type { ProjectContext, ProjectVerification } from "./types.ts";

export const buildProjectContext = (cwd = process.cwd()): Effect.Effect<ProjectContext> =>
    Effect.gen(function* () {
        const git = yield* getGitState(cwd);
        const stack = yield* loadProjectStack(git.root);
        const verification = deriveVerificationChecks({ git, stack });
        const diagnostics = yield* queryLiveDiagnostics(git.root);
        return {
            kind: "agentctl.project.context",
            generatedAt: new Date().toISOString(),
            git,
            stack,
            verification,
            diagnostics,
        };
    });

export const buildProjectVerification = (cwd = process.cwd()): Effect.Effect<ProjectVerification> =>
    Effect.gen(function* () {
        const git = yield* getGitState(cwd);
        const stack = yield* loadProjectStack(git.root);
        const checks = deriveVerificationChecks({ git, stack });
        const diagnostics = yield* queryLiveDiagnostics(git.root);
        return {
            kind: "agentctl.project.verify",
            generatedAt: new Date().toISOString(),
            git,
            checks,
            diagnostics,
        };
    });
