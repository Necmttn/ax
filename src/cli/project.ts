import { Effect } from "effect";
import { buildProjectContext, buildProjectVerification } from "../project/context.ts";
import type { ProjectContext, ProjectVerification, VerificationCheck } from "../project/types.ts";

const PROJECT_HELP = `agentctl project - project-local agent grounding

Usage:
  agentctl project context [--json]
  agentctl project verify [--json]
`;

function wantsJson(args: ReadonlyArray<string>): boolean {
    return args.includes("--json");
}

function printJson(payload: unknown): void {
    console.log(JSON.stringify(payload, null, 2));
}

function formatCheck(check: VerificationCheck): string {
    const command = check.command ? `\n    command: ${check.command}` : "";
    const files = check.relatedFiles.length > 0 ? `\n    files: ${check.relatedFiles.join(", ")}` : "";
    return `  [${check.severity}] ${check.title}\n    ${check.reason}${command}${files}`;
}

function printContext(payload: ProjectContext): void {
    console.log(`Project: ${payload.git.root ?? payload.git.cwd}`);
    console.log(`Branch: ${payload.git.branch ?? "unknown"}  HEAD: ${payload.git.head ?? "unknown"}`);
    console.log(`Dirty: ${payload.git.dirty ? "yes" : "no"}  Changes: ${payload.git.changes.length}`);
    const stack = payload.stack.signals.map((signal) => signal.name).join(", ") || "unknown";
    console.log(`Stack: ${stack}`);
    if (payload.verification.length > 0) {
        console.log("\nVerification:");
        for (const check of payload.verification) console.log(formatCheck(check));
    }
    if (payload.diagnostics.configured) {
        console.log(`\nDiagnostics: ${payload.diagnostics.available ? payload.diagnostics.status : "unavailable"}`);
    }
}

function printVerification(payload: ProjectVerification): void {
    if (payload.checks.length === 0 && payload.diagnostics.issues.length === 0) {
        console.log("No project verification checks matched the current diff.");
        return;
    }
    if (payload.checks.length > 0) {
        console.log("Verification:");
        for (const check of payload.checks) console.log(formatCheck(check));
    }
    if (payload.diagnostics.issues.length > 0) {
        console.log("\nLive diagnostics:");
        for (const issue of payload.diagnostics.issues) {
            const action = issue.suggestedAction ? `\n    action: ${issue.suggestedAction}` : "";
            console.log(`  [${issue.severity}] ${issue.title}\n    ${issue.detail}${action}`);
        }
    }
}

export const cmdProject = (args: string[]): Effect.Effect<void> =>
    Effect.gen(function* () {
        const [subcommand, ...rest] = args;
        if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
            console.log(PROJECT_HELP);
            return;
        }

        if (subcommand === "context") {
            const payload = yield* buildProjectContext();
            if (wantsJson(rest)) printJson(payload);
            else printContext(payload);
            return;
        }

        if (subcommand === "verify") {
            const payload = yield* buildProjectVerification();
            if (wantsJson(rest)) printJson(payload);
            else printVerification(payload);
            return;
        }

        console.error(`agentctl project: unknown subcommand "${subcommand}"`);
        console.error(PROJECT_HELP);
        process.exit(1);
    });
