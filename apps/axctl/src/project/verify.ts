import type { GitState, ProjectStack, VerificationCheck } from "./types.ts";

interface DeriveInput {
    readonly git: GitState;
    readonly stack: ProjectStack;
}

function changed(git: GitState, predicate: (path: string) => boolean): ReadonlyArray<string> {
    return git.changes.map((change) => change.path).filter(predicate);
}

function packageManagerRunCommand(packageManager: string | null, scriptName: string): string {
    if (packageManager?.startsWith("npm")) return `npm run ${scriptName}`;
    if (packageManager?.startsWith("pnpm")) return `pnpm run ${scriptName}`;
    if (packageManager?.startsWith("yarn")) return `yarn ${scriptName}`;
    return `bun run ${scriptName}`;
}

function scriptCommand(stack: ProjectStack, scriptName: string, fallback: string): string {
    return stack.package.scripts[scriptName] ? packageManagerRunCommand(stack.package.packageManager, scriptName) : fallback;
}

function hasAnyDependency(stack: ProjectStack, names: ReadonlyArray<string>): boolean {
    const deps = new Set([...stack.package.dependencies, ...stack.package.devDependencies]);
    return names.some((name) => deps.has(name));
}

function pushUnique(checks: VerificationCheck[], check: VerificationCheck): void {
    if (checks.some((existing) => existing.id === check.id)) return;
    checks.push(check);
}

export function deriveVerificationChecks(input: DeriveInput): ReadonlyArray<VerificationCheck> {
    const { git, stack } = input;
    const checks: VerificationCheck[] = [];
    const changedFiles = git.changes.map((change) => change.path);

    const tsFiles = changed(git, (path) => path.endsWith(".ts") || path.endsWith(".tsx"));
    if (tsFiles.length > 0) {
        pushUnique(checks, {
            id: "typescript-typecheck",
            severity: "required",
            title: "Run the project typecheck",
            reason: "TypeScript files changed.",
            command: scriptCommand(stack, "typecheck", "bunx tsc --noEmit"),
            relatedFiles: tsFiles,
        });
    }

    const testFiles = changed(git, (path) => path.includes(".test.") || path.includes(".spec.") || path.includes("/__tests__/"));
    if (testFiles.length > 0) {
        pushUnique(checks, {
            id: "tests-run",
            severity: "required",
            title: "Run the relevant tests",
            reason: "Test files changed.",
            command: scriptCommand(stack, "test", "bun test"),
            relatedFiles: testFiles,
        });
    } else if (tsFiles.length > 0 && stack.package.scripts.test) {
        pushUnique(checks, {
            id: "tests-consider",
            severity: "recommended",
            title: "Run tests that cover the edited TypeScript",
            reason: "Source files changed and this package declares a test script.",
            command: scriptCommand(stack, "test", "bun test"),
            relatedFiles: tsFiles,
        });
    }

    const lintable = changed(git, (path) => path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".js") || path.endsWith(".jsx"));
    if (lintable.length > 0 && stack.package.scripts.lint) {
        pushUnique(checks, {
            id: "lint",
            severity: "recommended",
            title: "Run lint",
            reason: "Lintable source files changed and a lint script exists.",
            command: scriptCommand(stack, "lint", "bun run lint"),
            relatedFiles: lintable,
        });
    }

    const packageChanged = changedFiles.includes("package.json");
    const lockChanged = changedFiles.some((path) => ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(path));
    if (packageChanged && !lockChanged) {
        pushUnique(checks, {
            id: "package-lockfile",
            severity: "recommended",
            title: "Check whether the lockfile should change",
            reason: "package.json changed but no known lockfile changed.",
            command: null,
            relatedFiles: ["package.json"],
        });
    }

    const schemaFiles = changed(git, (path) => path.startsWith("schema/") || path.startsWith("migrations/") || path.endsWith(".surql") || path.endsWith(".sql"));
    if (schemaFiles.length > 0) {
        pushUnique(checks, {
            id: "schema-smoke",
            severity: "recommended",
            title: "Run a schema or database smoke check",
            reason: "Schema or migration files changed.",
            command: stack.package.scripts["db:schema"] ? scriptCommand(stack, "db:schema", "bun run db:schema") : null,
            relatedFiles: schemaFiles,
        });
    }

    const effectLikely = hasAnyDependency(stack, ["effect"]) && tsFiles.some((path) => path.includes("effect") || path.includes("layer") || path.includes("service") || path.startsWith("src/"));
    if (effectLikely) {
        pushUnique(checks, {
            id: "effect-guidance",
            severity: "recommended",
            title: "Check Effect guidance before changing Effect code",
            reason: "This project depends on Effect and TypeScript source changed.",
            command: "effect-solutions show basics services-and-layers error-handling",
            relatedFiles: tsFiles,
        });
    }

    if (git.dirty && checks.length === 0) {
        pushUnique(checks, {
            id: "review-diff",
            severity: "info",
            title: "Review the current diff",
            reason: "The working tree has changes but no specific verification heuristic matched.",
            command: "git diff --stat",
            relatedFiles: changedFiles,
        });
    }

    return checks;
}
