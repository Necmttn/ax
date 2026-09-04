import { Effect, FileSystem, Path } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
import type { InstructionMatch, PackageInfo, ProjectStack, StackSignal } from "./types.ts";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

function emptyPackageInfo(): PackageInfo {
    return {
        packageJsonPath: null,
        packageManager: null,
        scripts: {},
        dependencies: [],
        devDependencies: [],
    };
}

function asStringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (typeof val === "string") out[key] = val;
    }
    return out;
}

function packageNames(value: unknown): ReadonlyArray<string> {
    if (!value || typeof value !== "object") return [];
    return Object.keys(value as Record<string, unknown>).sort();
}

export const loadPackageInfo = (root: string | null): Effect.Effect<PackageInfo, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        if (!root) return emptyPackageInfo();

        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const pkgPath = path.join(root, "package.json");
        // existsSync probe → orAbsent(false): a fault means "treat as absent".
        if (!(yield* fs.exists(pkgPath).pipe(orAbsent(false)))) return emptyPackageInfo();

        const parsed = yield* Effect.tryPromise({
            try: () => Bun.file(pkgPath).json() as Promise<unknown>,
            catch: () => "PackageJsonReadError" as const,
        }).pipe(Effect.orElseSucceed(() => null));

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyPackageInfo();
        const record = parsed as Record<string, unknown>;
        let packageManager = typeof record.packageManager === "string" ? record.packageManager : null;
        if (!packageManager) {
            const locks = [
                ["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"],
                ["yarn.lock", "yarn"], ["package-lock.json", "npm"],
            ] as const;
            const found = [] as string[];
            for (const [lock, manager] of locks) {
                if (yield* fs.exists(path.join(root, lock)).pipe(orAbsent(false))) found.push(manager);
            }
            const managers = [...new Set(found)];
            packageManager = managers.length === 1 ? managers[0]! : managers.length > 1 ? "conflict" : null;
        }
        return {
            packageJsonPath: pkgPath,
            packageManager,
            scripts: asStringRecord(record.scripts),
            dependencies: packageNames(record.dependencies),
            devDependencies: packageNames(record.devDependencies),
        };
    });

export const loadPackageInfos = (
    root: string | null,
    changedPaths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<PackageInfo>, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        if (!root) return [];
        const path = yield* Path.Path;
        const dirs = new Set([root]);
        for (const changedPath of changedPaths) {
            const relativePath = changedPath.replaceAll("\\", "/");
            const absolutePath = path.resolve(root, relativePath);
            const relativeToRoot = path.relative(root, absolutePath);
            if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) continue;
            let dir = path.dirname(absolutePath);
            while (dir !== root) {
                dirs.add(dir);
                dir = path.dirname(dir);
            }
        }
        const infos = yield* Effect.all([...dirs].map((dir) => loadPackageInfo(dir)), { concurrency: "unbounded" });
        return infos.filter((info) => info.packageJsonPath !== null);
    });

export function packageSignals(pkg: PackageInfo): ReadonlyArray<StackSignal> {
    const deps = new Set([...pkg.dependencies, ...pkg.devDependencies]);
    const signals: StackSignal[] = [];

    if (pkg.packageManager?.startsWith("bun") || Object.values(pkg.scripts).some((script) => script.includes("bun"))) {
        signals.push({
            name: "bun",
            confidence: pkg.packageManager?.startsWith("bun") ? "high" : "medium",
            evidence: [pkg.packageManager ?? "package scripts reference bun"],
        });
    }
    if (deps.has("typescript") || Object.values(pkg.scripts).some((script) => script.includes("tsc") || script.includes("tsgo"))) {
        signals.push({
            name: "typescript",
            confidence: "high",
            evidence: ["typescript dependency or typecheck script"],
        });
    }
    if (deps.has("effect")) {
        signals.push({
            name: "effect",
            confidence: "high",
            evidence: ["effect dependency"],
        });
    }
    if (deps.has("surrealdb")) {
        signals.push({
            name: "surrealdb",
            confidence: "high",
            evidence: ["surrealdb dependency"],
        });
    }
    if (deps.has("react") || deps.has("react-dom")) {
        signals.push({
            name: "react",
            confidence: "high",
            evidence: ["react dependency"],
        });
    }

    return signals;
}

function hasToken(line: string, tokens: ReadonlyArray<string>): boolean {
    return tokens.some((token) => new RegExp(`\\b${token}\\b`, "i").test(line));
}

function classifyInstruction(line: string): InstructionMatch["reason"] | null {
    const lower = line.toLowerCase();
    if (lower.includes("effect-solutions") || lower.includes("effect code")) return "effect";
    if (hasToken(line, ["typecheck", "test", "tests", "testing", "lint", "lints", "linting"])) return "verification";
    if (hasToken(line, ["surrealdb", "schema"])) return "database";
    if (hasToken(line, ["commit", "commits", "branch", "branches", "worktree", "worktrees", "main"])) return "git";
    if (hasToken(line, ["always", "never", "must"])) return "rule";
    return null;
}

export function extractInstructionMatches(file: string, content: string): ReadonlyArray<InstructionMatch> {
    const matches: InstructionMatch[] = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
        const text = lines[i]!.trim();
        if (!text || text.startsWith("#")) continue;
        const reason = classifyInstruction(text);
        if (!reason) continue;
        matches.push({ file, line: i + 1, text, reason });
    }
    return matches.slice(0, 40);
}

export const loadInstructionMatches = (
    root: string | null,
): Effect.Effect<ReadonlyArray<InstructionMatch>, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        if (!root) return [];
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const all: InstructionMatch[] = [];
        for (const name of INSTRUCTION_FILES) {
            const filePath = path.join(root, name);
            // existsSync probe → orAbsent(false): a fault means "treat as absent".
            if (!(yield* fs.exists(filePath).pipe(orAbsent(false)))) continue;
            // Original read used Effect.promise (failure → defect); preserve via orDie.
            const content = yield* fs.readFileString(filePath).pipe(Effect.orDie);
            all.push(...extractInstructionMatches(filePath, content));
        }
        return all;
    });

export const loadProjectStack = (
    root: string | null,
    changedPaths: ReadonlyArray<string> = [],
): Effect.Effect<ProjectStack, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const pkg = yield* loadPackageInfo(root);
        const packages = yield* loadPackageInfos(root, changedPaths);
        const instructions = yield* loadInstructionMatches(root);
        return {
            package: pkg,
            packages,
            signals: packageSignals(pkg),
            instructions,
        };
    });
