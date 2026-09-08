import type { GitState, ProjectStack, VerificationCheck } from "./types.ts";
import { posixPath } from "@ax/lib/shared/path";
import { projectRelativePath } from "./package-path.ts";

interface DeriveInput {
    readonly git: GitState;
    readonly stack: ProjectStack;
}

function changed(git: GitState, predicate: (path: string) => boolean): ReadonlyArray<string> {
    return git.changes.map((change) => projectRelativePath(change.path))
        .filter((path): path is string => path !== null && predicate(path));
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
function packageManager(value: string | null): PackageManager | null {
    const name = value?.split("@")[0];
    return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : null;
}

/** These commands target POSIX shells. Quote repository-controlled names as one argument. */
function shellPath(value: string): string {
    const argument = value.startsWith("-") ? `./${value}` : value;
    return /^[a-zA-Z0-9_./-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`;
}

interface SelectedPackage {
    readonly info: ProjectStack["package"];
    readonly prefix: string | null;
}

function packageForPath(stack: ProjectStack, changedPath: string, root: string): SelectedPackage {
    const absolutePath = posixPath.resolve(root, changedPath);
    const candidates = [...(stack.packages ?? []), stack.package]
        .flatMap((info) => {
            if (!info.packageJsonPath) return [];
            const dir = posixPath.resolve(info.packageJsonPath.replaceAll("\\", "/"), "..");
            const prefix = posixPath.relative(root, dir);
            if (prefix === ".." || prefix.startsWith("../")) return [];
            const relative = posixPath.relative(dir, absolutePath);
            return relative === ".." || relative.startsWith("../") ? [] : [{ info, dir, prefix: prefix || null }];
        })
        .sort((a, b) => b.dir.length - a.dir.length);
    return candidates[0] ?? { info: stack.package, prefix: null };
}

function scriptCommand(stack: ProjectStack, scriptName: string, selected: SelectedPackage): string | null {
    const { info, prefix } = selected;
    const manager = packageManager(info.packageManager ?? stack.package.packageManager);
    if (!manager) return null;
    const at = (command: string) => prefix ? `cd ${shellPath(prefix)} && ${command}` : command;
    if (info.scripts[scriptName]) {
        if (manager === "npm") return `npm${prefix ? ` --prefix ${shellPath(prefix)}` : ""} run ${scriptName}`;
        return at(`${manager}${manager === "yarn" ? "" : " run"} ${scriptName}`);
    }
    // Execute only a declared local compiler. Package-manager exec commands can
    // fetch a different package from the registry when the tool is not installed.
    if (scriptName === "typecheck") {
        const ownsCompiler = (pkg: ProjectStack["package"]) => [...pkg.dependencies, ...pkg.devDependencies].includes("typescript");
        const local = "./node_modules/.bin/tsc --noEmit";
        const compiler = posixPath.join(posixPath.relative(prefix ?? ".", "."), "node_modules/.bin/tsc");
        const hoisted = `${shellPath(compiler.startsWith(".") ? compiler : `./${compiler}`)} --noEmit`;
        if (ownsCompiler(info)) {
            return at(prefix ? `if [ -x ./node_modules/.bin/tsc ]; then ${local}; else ${hoisted}; fi` : local);
        }
        if (ownsCompiler(stack.package)) return at(hoisted);
    }
    return scriptName === "test" && manager === "bun" ? at("bun test") : null;
}

function groupedFiles(stack: ProjectStack, files: ReadonlyArray<string>, root: string): ReadonlyArray<{
    readonly selected: SelectedPackage;
    readonly files: ReadonlyArray<string>;
}> {
    const groups = new Map<string, { selected: SelectedPackage; files: string[] }>();
    for (const file of files) {
        const selected = packageForPath(stack, file, root);
        const key = selected.info.packageJsonPath ?? "(root)";
        const group = groups.get(key) ?? { selected, files: [] };
        group.files.push(file);
        groups.set(key, group);
    }
    return [...groups.values()];
}

const checkId = (base: string, selected: SelectedPackage): string =>
    selected.prefix ? `${base}:${selected.prefix}` : base;

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
    const root = posixPath.resolve((git.root ?? git.cwd).replaceAll("\\", "/"));
    const changedFiles = changed(git, () => true);

    const tsFiles = changed(git, (path) => path.endsWith(".ts") || path.endsWith(".tsx"));
    for (const group of groupedFiles(stack, tsFiles, root)) pushUnique(checks, {
        id: checkId("typescript-typecheck", group.selected), severity: "required",
        title: "Run the project typecheck", reason: "TypeScript files changed.",
        command: scriptCommand(stack, "typecheck", group.selected), relatedFiles: group.files,
    });

    const testFiles = changed(git, (path) => path.includes(".test.") || path.includes(".spec.") || path.includes("/__tests__/"));
    const testGroups = groupedFiles(stack, testFiles, root);
    for (const group of testGroups) pushUnique(checks, {
        id: checkId("tests-run", group.selected), severity: "required",
        title: "Run the relevant tests", reason: "Test files changed.",
        command: scriptCommand(stack, "test", group.selected), relatedFiles: group.files,
    });
    for (const group of groupedFiles(stack, tsFiles, root)) {
        if (!group.selected.info.scripts.test || testGroups.some(test => test.selected.info === group.selected.info)) continue;
        pushUnique(checks, {
            id: checkId("tests-consider", group.selected), severity: "recommended",
            title: "Run tests that cover the edited TypeScript",
            reason: "Source files changed and this package declares a test script.",
            command: scriptCommand(stack, "test", group.selected), relatedFiles: group.files,
        });
    }

    const lintable = changed(git, (path) => path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".js") || path.endsWith(".jsx"));
    if (lintable.length > 0) {
        for (const group of groupedFiles(stack, lintable, root)) {
            const packageInfo = group.selected.info;
            if (!packageInfo.scripts.lint) continue;
            pushUnique(checks, {
                id: checkId("lint", group.selected), severity: "recommended", title: "Run lint",
                reason: "Lintable source files changed and a lint script exists.",
                command: scriptCommand(stack, "lint", group.selected), relatedFiles: group.files,
            });
        }
    }

    const packageManifests = changed(git, (path) => path === "package.json" || path.endsWith("/package.json"));
    const lockfiles = new Set(changedFiles.map((path) => path.replaceAll("\\", "/")));
    for (const manifest of packageManifests) {
        const selected = packageForPath(stack, manifest, root);
        const packagePath = selected.info.packageJsonPath;
        if (!packagePath) continue;
        const prefix = selected.prefix;
        const manager = selected.info.packageManager;
        const lockName = manager?.startsWith("bun") ? "bun.lock"
            : manager?.startsWith("pnpm") ? "pnpm-lock.yaml"
            : manager?.startsWith("yarn") ? "yarn.lock"
            : manager?.startsWith("npm") ? "package-lock.json"
            : null;
        const lockPath = prefix ? `${prefix}/${lockName ?? "lockfile"}` : lockName ?? "lockfile";
        if (!lockfiles.has(lockPath) && !(manager?.startsWith("bun") && lockfiles.has(`${prefix ? `${prefix}/` : ""}bun.lockb`))) {
            pushUnique(checks, {
                id: checkId("package-lockfile", selected),
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
            command: stack.package.scripts["db:schema"] ? scriptCommand(stack, "db:schema", packageForPath(stack, schemaFiles[0]!, root)) : null,
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
