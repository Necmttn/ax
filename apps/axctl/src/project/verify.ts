import type { GitState, ProjectStack, VerificationCheck } from "./types.ts";
import { posixPath } from "@ax/lib/shared/path";

interface DeriveInput {
    readonly git: GitState;
    readonly stack: ProjectStack;
}

function changed(git: GitState, predicate: (path: string) => boolean): ReadonlyArray<string> {
    return git.changes.map((change) => change.path.replaceAll("\\", "/")).filter(predicate);
}

function packageManagerRunCommand(packageManager: string | null, scriptName: string, prefix: string | null = null): string | null {
    if (packageManager === "conflict") return null;
    if (packageManager?.startsWith("npm")) return prefix ? `npm --prefix ${prefix} run ${scriptName}` : `npm run ${scriptName}`;
    const at = (command: string) => prefix ? `cd ${prefix} && ${command}` : command;
    if (packageManager?.startsWith("pnpm")) return at(`pnpm run ${scriptName}`);
    if (packageManager?.startsWith("yarn")) return at(`yarn ${scriptName}`);
    return at(`bun run ${scriptName}`);
}

function packageForPath(stack: ProjectStack, changedPath: string): { info: typeof stack.package; prefix: string | null } {
    const root = stack.package.packageJsonPath ? posixPath.dirname(stack.package.packageJsonPath) : null;
    const relative = changedPath.replaceAll("\\", "/");
    const absolutePath = root ? posixPath.resolve(root, relative) : relative;
    const candidates = (stack.packages ?? [stack.package])
        .map((info) => ({ info, dir: info.packageJsonPath ? posixPath.dirname(info.packageJsonPath) : null }))
        .filter((candidate) => {
            const relative = posixPath.relative(candidate.dir!, absolutePath);
            return candidate.dir && relative !== ".." && relative.split("/")[0] !== "..";
        })
        .sort((a, b) => posixPath.relative(a.dir!, absolutePath).length - posixPath.relative(b.dir!, absolutePath).length);
    const info = candidates[0]?.info ?? stack.package;
    if (!info.packageJsonPath || !stack.package.packageJsonPath) return { info, prefix: null };
    const packageRoot = posixPath.dirname(stack.package.packageJsonPath);
    const dir = posixPath.dirname(info.packageJsonPath);
    const prefix = posixPath.relative(packageRoot, dir);
    return { info, prefix: prefix || null };
}

function scriptCommand(stack: ProjectStack, scriptName: string, fallback: string, changedPath: string): string | null {
    const selectedPackage = packageForPath(stack, changedPath);
    const selected = selectedPackage.info;
    const prefix = selectedPackage.prefix;
    const manager = selected.packageManager ?? stack.package.packageManager;
    if (selected.scripts[scriptName]) return packageManagerRunCommand(manager, scriptName, prefix);
    const exec = manager?.startsWith("npm") ? `npm${prefix ? ` --prefix ${prefix}` : ""} exec -- ${fallback.replace(/^bunx\s+/, "")}`
        : manager?.startsWith("pnpm") ? `${prefix ? `cd ${prefix} && ` : ""}pnpm exec ${fallback.replace(/^bunx\s+/, "")}`
        : manager?.startsWith("yarn") ? `${prefix ? `cd ${prefix} && ` : ""}yarn exec ${fallback.replace(/^bunx\s+/, "")}`
        : `${prefix ? `cd ${prefix} && ` : ""}${fallback}`;
    return manager === "conflict" ? null : exec;
}

function groupedFiles(stack: ProjectStack, files: ReadonlyArray<string>): ReadonlyArray<{
    readonly key: string;
    readonly files: ReadonlyArray<string>;
    readonly sample: string;
}> {
    const groups = new Map<string, { info: typeof stack.package; files: string[]; sample: string }>();
    for (const file of files) {
        const selected = packageForPath(stack, file);
        const key = selected.info.packageJsonPath ?? "(root)";
        const group = groups.get(key) ?? { info: selected.info, files: [], sample: file };
        group.files.push(file);
        groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => ({ key, files: group.files, sample: group.sample }));
}

const checkId = (base: string, key: string, stack: ProjectStack): string => {
    const root = stack.package.packageJsonPath ? posixPath.dirname(stack.package.packageJsonPath) : "";
    const suffix = key === (stack.package.packageJsonPath ?? "(root)") ? "" : posixPath.relative(root, posixPath.dirname(key));
    return suffix ? `${base}:${suffix.replaceAll("\\", "/")}` : base;
};

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
    for (const group of groupedFiles(stack, tsFiles)) pushUnique(checks, {
        id: checkId("typescript-typecheck", group.key, stack), severity: "required",
        title: "Run the project typecheck", reason: "TypeScript files changed.",
        command: scriptCommand(stack, "typecheck", "bunx tsc --noEmit", group.sample), relatedFiles: group.files,
    });

    const testFiles = changed(git, (path) => path.includes(".test.") || path.includes(".spec.") || path.includes("/__tests__/"));
    if (testFiles.length > 0) {
        for (const group of groupedFiles(stack, testFiles)) pushUnique(checks, {
            id: checkId("tests-run", group.key, stack), severity: "required",
            title: "Run the relevant tests", reason: "Test files changed.",
            command: scriptCommand(stack, "test", "bun test", group.sample), relatedFiles: group.files,
        });
    } else if (tsFiles.length > 0 && stack.package.scripts.test) {
        pushUnique(checks, {
            id: "tests-consider",
            severity: "recommended",
            title: "Run tests that cover the edited TypeScript",
            reason: "Source files changed and this package declares a test script.",
            command: scriptCommand(stack, "test", "bun test", tsFiles[0]!),
            relatedFiles: tsFiles,
        });
    }

    const lintable = changed(git, (path) => path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".js") || path.endsWith(".jsx"));
    if (lintable.length > 0) {
        for (const group of groupedFiles(stack, lintable)) {
            const packageInfo = packageForPath(stack, group.sample).info;
            if (!packageInfo.scripts.lint) continue;
            pushUnique(checks, {
                id: checkId("lint", group.key, stack), severity: "recommended", title: "Run lint",
                reason: "Lintable source files changed and a lint script exists.",
                command: scriptCommand(stack, "lint", "bun run lint", group.sample), relatedFiles: group.files,
            });
        }
    }

    const packageManifests = changed(git, (path) => path === "package.json" || path.endsWith("/package.json"));
    const lockfiles = new Set(changedFiles.map((path) => path.replaceAll("\\", "/")));
    for (const manifest of packageManifests) {
        const selected = packageForPath(stack, manifest);
        const packagePath = selected.info.packageJsonPath;
        if (!packagePath) continue;
        const root = posixPath.dirname(stack.package.packageJsonPath ?? packagePath);
        const dir = posixPath.dirname(packagePath);
        const prefix = posixPath.relative(root, dir);
        const manager = selected.info.packageManager;
        const lockName = manager?.startsWith("bun") ? "bun.lock"
            : manager?.startsWith("pnpm") ? "pnpm-lock.yaml"
            : manager?.startsWith("yarn") ? "yarn.lock"
            : manager?.startsWith("npm") ? "package-lock.json"
            : null;
        const lockPath = prefix ? `${prefix}/${lockName ?? "lockfile"}` : lockName ?? "lockfile";
        if (!lockfiles.has(lockPath) && !lockfiles.has(lockPath.replaceAll("/", "\\"))) {
            pushUnique(checks, {
                id: checkId("package-lockfile", packagePath, stack),
                severity: "recommended",
                title: manager === "conflict" ? "Resolve the package manager before checking the lockfile" : "Check whether the package-local lockfile should change",
                reason: manager === "conflict" ? "Conflicting package-manager lockfiles were detected." : `${manifest} changed but ${lockPath} did not change.`,
                command: null,
                relatedFiles: [manifest, ...(lockName ? [lockPath] : [])],
            });
        }
    }

    const schemaFiles = changed(git, (path) => path.startsWith("schema/") || path.startsWith("migrations/") || path.endsWith(".surql") || path.endsWith(".sql"));
    if (schemaFiles.length > 0) {
        pushUnique(checks, {
            id: "schema-smoke",
            severity: "recommended",
            title: "Run a schema or database smoke check",
            reason: "Schema or migration files changed.",
            command: stack.package.scripts["db:schema"] ? scriptCommand(stack, "db:schema", "bun run db:schema", schemaFiles[0]!) : null,
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
