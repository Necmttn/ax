import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { InstructionMatch, PackageInfo, ProjectStack, StackSignal } from "./types.ts";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

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

export const loadPackageInfo = (root: string | null): Effect.Effect<PackageInfo> =>
    Effect.gen(function* () {
        if (!root) {
            return {
                packageJsonPath: null,
                packageManager: null,
                scripts: {},
                dependencies: [],
                devDependencies: [],
            };
        }

        const path = join(root, "package.json");
        if (!existsSync(path)) {
            return {
                packageJsonPath: null,
                packageManager: null,
                scripts: {},
                dependencies: [],
                devDependencies: [],
            };
        }

        const raw = yield* Effect.promise(() => readFile(path, "utf8"));
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return {
            packageJsonPath: path,
            packageManager: typeof parsed.packageManager === "string" ? parsed.packageManager : null,
            scripts: asStringRecord(parsed.scripts),
            dependencies: packageNames(parsed.dependencies),
            devDependencies: packageNames(parsed.devDependencies),
        };
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

function classifyInstruction(line: string): string | null {
    const lower = line.toLowerCase();
    if (lower.includes("effect-solutions") || lower.includes("effect code")) return "effect";
    if (lower.includes("typecheck") || lower.includes("test") || lower.includes("lint")) return "verification";
    if (lower.includes("surrealdb") || lower.includes("schema")) return "database";
    if (lower.includes("commit") || lower.includes("branch") || lower.includes("worktree") || lower.includes("main")) return "git";
    if (lower.includes("always") || lower.includes("never") || lower.includes("must")) return "rule";
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

export const loadInstructionMatches = (root: string | null): Effect.Effect<ReadonlyArray<InstructionMatch>> =>
    Effect.gen(function* () {
        if (!root) return [];
        const all: InstructionMatch[] = [];
        for (const name of INSTRUCTION_FILES) {
            const path = join(root, name);
            if (!existsSync(path)) continue;
            const content = yield* Effect.promise(() => readFile(path, "utf8"));
            all.push(...extractInstructionMatches(path, content));
        }
        return all;
    });

export const loadProjectStack = (root: string | null): Effect.Effect<ProjectStack> =>
    Effect.gen(function* () {
        const pkg = yield* loadPackageInfo(root);
        const instructions = yield* loadInstructionMatches(root);
        return {
            package: pkg,
            signals: packageSignals(pkg),
            instructions,
        };
    });
