# Project Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `agentctl project context --json` and `agentctl project verify --json` so Claude Code, Codex, and self-improve jobs can ask what the current repo expects before and after edits.

**Architecture:** Add a small `src/project/` module that gathers repo state from git, package files, instruction files, verification heuristics, and optional live diagnostics. Keep the first milestone read-only and JSON-first; do not add schema tables, OTEL persistence, MCP, or project memory writes in this pass.

**Tech Stack:** Bun, TypeScript strict mode, Effect v4 beta, current manual CLI dispatcher, `bun:test` for pure unit tests, existing `bun run typecheck`.

---

## Scope Check

This plan implements the first useful loop only:

- `agentctl project context --json`
- `agentctl project verify --json`
- pure changed-file verification heuristics
- optional HTTP diagnostics adapter boundary

It explicitly does not implement command-history ingestion, persistent project memory, recall/entity resolution, OTEL storage, MCP, or self-improve graph ingestion. Those should be separate plans after this command shape proves useful.

## File Structure

- Create `src/project/types.ts`: shared JSON-compatible project context, verification, git, stack, instruction, and diagnostics types.
- Create `src/project/git.ts`: git root discovery, branch/status parsing, and file language classification.
- Create `src/project/stack.ts`: package manager/script detection and instruction-file rule extraction.
- Create `src/project/verify.ts`: deterministic changed-file heuristics for checks agents should run.
- Create `src/project/diagnostics.ts`: optional HTTP diagnostics adapter that reads `.agentctl/config.json`.
- Create `src/project/context.ts`: orchestration functions that combine git, stack, instructions, verification checks, and diagnostics into one payload.
- Create `src/cli/project.ts`: project subcommand rendering and argument handling.
- Modify `src/cli/index.ts`: route `agentctl project ...` to the new command and update help text.
- Test `src/project/verify.test.ts`: pure verification heuristics.
- Test `src/project/stack.test.ts`: stack and instruction extraction.
- Test `src/project/diagnostics.test.ts`: diagnostics config parsing and response normalization.

Keep every module narrowly focused. The CLI should not contain git parsing or heuristics; it should only call `buildProjectContext`, `buildProjectVerification`, and render JSON/text.

## Task 1: Add Shared Project Types

**Files:**
- Create: `src/project/types.ts`
- Test: none for this task; later tasks compile against these types.

- [ ] **Step 1: Create the project type module**

Create `src/project/types.ts` with this complete content:

```typescript
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
```

- [ ] **Step 2: Run the typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS. If it fails, fix only syntax/import issues introduced by `src/project/types.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/project/types.ts
git commit -m "feat(project): add grounding types"
```

## Task 2: Implement Git State Collection

**Files:**
- Create: `src/project/git.ts`
- Test: none in this task; `verify.test.ts` covers the consumed shape.

- [ ] **Step 1: Create git scanner**

Create `src/project/git.ts` with this complete content:

```typescript
import { dirname, extname } from "node:path";
import { stat } from "node:fs/promises";
import { Effect } from "effect";
import type { GitState, ProjectFileChange } from "./types.ts";

interface RunResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
}

const exists = (path: string): Promise<boolean> =>
    stat(path)
        .then(() => true)
        .catch(() => false);

export async function findGitRoot(cwd: string): Promise<string | null> {
    let cur = cwd;
    for (let i = 0; i < 16; i += 1) {
        if (await exists(`${cur}/.git`)) return cur;
        const parent = dirname(cur);
        if (parent === cur) return null;
        cur = parent;
    }
    return null;
}

const runGit = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<RunResult> =>
    Effect.promise(async () => {
        const proc = Bun.spawn(["git", "-C", cwd, ...args], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        await proc.exited;
        return { stdout, stderr, code: proc.exitCode ?? 0 };
    });

export function detectLang(path: string): string | null {
    const ext = extname(path).toLowerCase();
    switch (ext) {
        case ".ts":
            return "typescript";
        case ".tsx":
            return "typescript-react";
        case ".js":
            return "javascript";
        case ".jsx":
            return "javascript-react";
        case ".json":
            return "json";
        case ".md":
        case ".mdx":
            return "markdown";
        case ".surql":
            return "surrealql";
        case ".sql":
            return "sql";
        case ".yaml":
        case ".yml":
            return "yaml";
        case ".toml":
            return "toml";
        default:
            return null;
    }
}

function parseStatusLine(line: string): ProjectFileChange | null {
    if (line.length < 4) return null;
    const stagedStatus = line[0] ?? " ";
    const unstagedStatus = line[1] ?? " ";
    const rawPath = line.slice(3);
    const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
    const untracked = stagedStatus === "?" && unstagedStatus === "?";
    return {
        path,
        status: `${stagedStatus}${unstagedStatus}`.trim() || "modified",
        staged: stagedStatus !== " " && stagedStatus !== "?",
        unstaged: unstagedStatus !== " " && unstagedStatus !== "?",
        untracked,
        lang: detectLang(path),
    };
}

function parseBranch(line: string): string | null {
    if (!line.startsWith("## ")) return null;
    const withoutPrefix = line.slice(3);
    return withoutPrefix.split("...")[0]?.trim() || null;
}

export const getGitState = (cwd = process.cwd()): Effect.Effect<GitState> =>
    Effect.gen(function* () {
        const root = yield* Effect.promise(() => findGitRoot(cwd));
        if (!root) {
            return {
                root: null,
                cwd,
                branch: null,
                head: null,
                dirty: false,
                changes: [],
            };
        }

        const [status, head] = yield* Effect.all([
            runGit(root, ["status", "--porcelain=v1", "-b"]),
            runGit(root, ["rev-parse", "--short", "HEAD"]),
        ]);

        const lines = status.stdout.split("\n").filter((line) => line.length > 0);
        const branch = lines.length > 0 ? parseBranch(lines[0]!) : null;
        const changes = lines.slice(1).map(parseStatusLine).filter((row): row is ProjectFileChange => row !== null);

        return {
            root,
            cwd,
            branch,
            head: head.code === 0 ? head.stdout.trim() || null : null,
            dirty: changes.length > 0,
            changes,
        };
    });
```

- [ ] **Step 2: Run the typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Smoke-test the scanner from Bun**

Run:

```bash
bun -e 'import { Effect } from "effect"; import { getGitState } from "./src/project/git.ts"; console.log(JSON.stringify(await Effect.runPromise(getGitState()), null, 2))'
```

Expected: JSON with `root` equal to the `agentctl` repo path and `changes` containing the current docs changes.

- [ ] **Step 4: Commit**

```bash
git add src/project/git.ts
git commit -m "feat(project): collect git state"
```

## Task 3: Implement Stack And Instruction Detection

**Files:**
- Create: `src/project/stack.ts`
- Test: `src/project/stack.test.ts`

- [ ] **Step 1: Write failing tests for package and instruction extraction**

Create `src/project/stack.test.ts` with this complete content:

```typescript
import { describe, expect, test } from "bun:test";
import { extractInstructionMatches, packageSignals } from "./stack.ts";

describe("packageSignals", () => {
    test("detects Bun, TypeScript, Effect, and SurrealDB", () => {
        const signals = packageSignals({
            packageJsonPath: "/repo/package.json",
            packageManager: "bun@1.3.8",
            scripts: { typecheck: "tsc --noEmit", test: "bun test" },
            dependencies: ["effect", "surrealdb"],
            devDependencies: ["typescript"],
        });

        expect(signals.map((signal) => signal.name)).toEqual([
            "bun",
            "typescript",
            "effect",
            "surrealdb",
        ]);
    });
});

describe("extractInstructionMatches", () => {
    test("keeps only agent-relevant rules", () => {
        const matches = extractInstructionMatches(
            "CLAUDE.md",
            [
                "# Project",
                "Always run bun typecheck after TypeScript edits.",
                "Use effect-solutions before writing Effect code.",
                "This marketing paragraph is not a rule.",
                "Never commit directly to main.",
            ].join("\n"),
        );

        expect(matches).toEqual([
            {
                file: "CLAUDE.md",
                line: 2,
                text: "Always run bun typecheck after TypeScript edits.",
                reason: "verification",
            },
            {
                file: "CLAUDE.md",
                line: 3,
                text: "Use effect-solutions before writing Effect code.",
                reason: "effect",
            },
            {
                file: "CLAUDE.md",
                line: 5,
                text: "Never commit directly to main.",
                reason: "git",
            },
        ]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test src/project/stack.test.ts
```

Expected: FAIL because `src/project/stack.ts` does not exist.

- [ ] **Step 3: Implement stack detection**

Create `src/project/stack.ts` with this complete content:

```typescript
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
```

- [ ] **Step 4: Run the tests**

Run:

```bash
bun test src/project/stack.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/project/stack.ts src/project/stack.test.ts
git commit -m "feat(project): detect stack and instructions"
```

## Task 4: Implement Verification Heuristics

**Files:**
- Create: `src/project/verify.ts`
- Test: `src/project/verify.test.ts`

- [ ] **Step 1: Write failing tests for changed-file checks**

Create `src/project/verify.test.ts` with this complete content:

```typescript
import { describe, expect, test } from "bun:test";
import { deriveVerificationChecks } from "./verify.ts";
import type { GitState, ProjectStack } from "./types.ts";

const baseGit: GitState = {
    root: "/repo",
    cwd: "/repo",
    branch: "feature",
    head: "abc1234",
    dirty: true,
    changes: [],
};

const baseStack: ProjectStack = {
    package: {
        packageJsonPath: "/repo/package.json",
        packageManager: "bun@1.3.8",
        scripts: {
            typecheck: "tsc --noEmit",
            test: "bun test",
            lint: "oxlint .",
        },
        dependencies: ["effect"],
        devDependencies: ["typescript"],
    },
    signals: [],
    instructions: [],
};

describe("deriveVerificationChecks", () => {
    test("requires typecheck for TypeScript edits", () => {
        const checks = deriveVerificationChecks({
            git: {
                ...baseGit,
                changes: [
                    {
                        path: "src/cli/index.ts",
                        status: "M",
                        staged: false,
                        unstaged: true,
                        untracked: false,
                        lang: "typescript",
                    },
                ],
            },
            stack: baseStack,
        });

        expect(checks[0]).toMatchObject({
            id: "typescript-typecheck",
            severity: "required",
            command: "bun run typecheck",
        });
    });

    test("flags package changes without lockfile changes", () => {
        const checks = deriveVerificationChecks({
            git: {
                ...baseGit,
                changes: [
                    {
                        path: "package.json",
                        status: "M",
                        staged: false,
                        unstaged: true,
                        untracked: false,
                        lang: "json",
                    },
                ],
            },
            stack: baseStack,
        });

        expect(checks.map((check) => check.id)).toContain("package-lockfile");
    });

    test("adds Effect guidance when Effect source changed", () => {
        const checks = deriveVerificationChecks({
            git: {
                ...baseGit,
                changes: [
                    {
                        path: "src/lib/layers.ts",
                        status: "M",
                        staged: false,
                        unstaged: true,
                        untracked: false,
                        lang: "typescript",
                    },
                ],
            },
            stack: baseStack,
        });

        expect(checks.map((check) => check.id)).toContain("effect-guidance");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test src/project/verify.test.ts
```

Expected: FAIL because `src/project/verify.ts` does not exist.

- [ ] **Step 3: Implement verification checks**

Create `src/project/verify.ts` with this complete content:

```typescript
import type { GitState, ProjectStack, VerificationCheck } from "./types.ts";

interface DeriveInput {
    readonly git: GitState;
    readonly stack: ProjectStack;
}

function changed(git: GitState, predicate: (path: string) => boolean): ReadonlyArray<string> {
    return git.changes.map((change) => change.path).filter(predicate);
}

function scriptCommand(stack: ProjectStack, scriptName: string, fallback: string): string {
    return stack.package.scripts[scriptName] ? `bun run ${scriptName}` : fallback;
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
            command: "bun run test",
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
            command: "bun run lint",
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
            command: stack.package.scripts["db:schema"] ? "bun run db:schema" : null,
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
```

- [ ] **Step 4: Run verification tests**

Run:

```bash
bun test src/project/verify.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the project typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/project/verify.ts src/project/verify.test.ts
git commit -m "feat(project): derive verification checks"
```

## Task 5: Add Diagnostics Adapter Boundary

**Files:**
- Create: `src/project/diagnostics.ts`
- Test: `src/project/diagnostics.test.ts`

- [ ] **Step 1: Write failing tests for config parsing and normalization**

Create `src/project/diagnostics.test.ts` with this complete content:

```typescript
import { describe, expect, test } from "bun:test";
import { normalizeDiagnosticIssue, parseDiagnosticConfig } from "./diagnostics.ts";

describe("parseDiagnosticConfig", () => {
    test("reads URLs from .agentctl config JSON", () => {
        const parsed = parseDiagnosticConfig(
            JSON.stringify({
                diagnostics: {
                    healthUrl: "http://localhost:4319/internal/health",
                    statusUrl: "http://localhost:4319/internal/status",
                    errorsUrl: "http://localhost:4319/internal/errors",
                    timeoutMs: 750,
                },
            }),
        );

        expect(parsed).toEqual({
            healthUrl: "http://localhost:4319/internal/health",
            statusUrl: "http://localhost:4319/internal/status",
            errorsUrl: "http://localhost:4319/internal/errors",
            timeoutMs: 750,
        });
    });
});

describe("normalizeDiagnosticIssue", () => {
    test("normalizes Quera-devkit-style issue objects", () => {
        expect(
            normalizeDiagnosticIssue({
                severity: "critical",
                title: "backend crashed",
                detail: "exit 1",
                suggestedAction: "check stderr",
                traceId: "abc",
                service: "backend",
            }),
        ).toEqual({
            severity: "critical",
            title: "backend crashed",
            detail: "exit 1",
            suggestedAction: "check stderr",
            traceId: "abc",
            service: "backend",
        });
    });
});
```

- [ ] **Step 2: Run the diagnostics test to verify it fails**

Run:

```bash
bun test src/project/diagnostics.test.ts
```

Expected: FAIL because `src/project/diagnostics.ts` does not exist.

- [ ] **Step 3: Implement diagnostics adapter**

Create `src/project/diagnostics.ts` with this complete content:

```typescript
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { DiagnosticConfig, DiagnosticIssue, LiveDiagnostics } from "./types.ts";

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrDefault(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseDiagnosticConfig(raw: string): DiagnosticConfig {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const diagnostics = parsed.diagnostics && typeof parsed.diagnostics === "object" ? (parsed.diagnostics as Record<string, unknown>) : {};
    return {
        healthUrl: stringOrNull(diagnostics.healthUrl),
        statusUrl: stringOrNull(diagnostics.statusUrl),
        errorsUrl: stringOrNull(diagnostics.errorsUrl),
        timeoutMs: numberOrDefault(diagnostics.timeoutMs, 1000),
    };
}

export const loadDiagnosticConfig = (root: string | null): Effect.Effect<DiagnosticConfig | null> =>
    Effect.gen(function* () {
        if (!root) return null;
        const path = join(root, ".agentctl", "config.json");
        if (!existsSync(path)) return null;
        const raw = yield* Effect.promise(() => readFile(path, "utf8"));
        return parseDiagnosticConfig(raw);
    });

function severity(value: unknown): DiagnosticIssue["severity"] {
    return value === "critical" || value === "warning" || value === "info" ? value : "info";
}

export function normalizeDiagnosticIssue(value: unknown): DiagnosticIssue {
    const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
        severity: severity(row.severity),
        title: typeof row.title === "string" ? row.title : "Diagnostic issue",
        detail: typeof row.detail === "string" ? row.detail : "",
        suggestedAction: stringOrNull(row.suggestedAction),
        traceId: stringOrNull(row.traceId),
        service: stringOrNull(row.service),
    };
}

function statusFromPayload(value: unknown): LiveDiagnostics["status"] {
    if (!value || typeof value !== "object") return "unknown";
    const row = value as Record<string, unknown>;
    const status = row.status;
    if (status === "green" || status === "yellow" || status === "red") return status;
    return "unknown";
}

function issuesFromPayload(value: unknown): ReadonlyArray<DiagnosticIssue> {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const issues = Array.isArray(row.issues) ? row.issues : [];
    return issues.map(normalizeDiagnosticIssue);
}

function localUrlsFromPayload(value: unknown): ReadonlyArray<string> {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const urls = row.localUrls;
    return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string") : [];
}

const emptyDiagnostics = (configured: boolean, error: string | null): LiveDiagnostics => ({
    configured,
    available: false,
    source: null,
    status: "unknown",
    issues: [],
    localUrls: [],
    checkedAt: new Date().toISOString(),
    error,
});

export const queryLiveDiagnostics = (root: string | null): Effect.Effect<LiveDiagnostics> =>
    Effect.gen(function* () {
        const config = yield* loadDiagnosticConfig(root);
        if (!config || !config.healthUrl) return emptyDiagnostics(false, null);

        const result = yield* Effect.tryPromise({
            try: async () => {
                const response = await fetch(config.healthUrl!, {
                    signal: AbortSignal.timeout(config.timeoutMs),
                });
                if (!response.ok) throw new Error(`diagnostics returned HTTP ${response.status}`);
                return (await response.json()) as unknown;
            },
            catch: (error) => error,
        }).pipe(Effect.either);

        if (result._tag === "Left") {
            return emptyDiagnostics(true, String(result.left));
        }

        const payload = result.right;
        return {
            configured: true,
            available: true,
            source: config.healthUrl,
            status: statusFromPayload(payload),
            issues: issuesFromPayload(payload),
            localUrls: localUrlsFromPayload(payload),
            checkedAt: new Date().toISOString(),
            error: null,
        };
    });
```

- [ ] **Step 4: Run diagnostics tests**

Run:

```bash
bun test src/project/diagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/project/diagnostics.ts src/project/diagnostics.test.ts
git commit -m "feat(project): add diagnostics adapter"
```

## Task 6: Build Project Context And Verification Payloads

**Files:**
- Create: `src/project/context.ts`

- [ ] **Step 1: Create context orchestration module**

Create `src/project/context.ts` with this complete content:

```typescript
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
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Smoke-test context construction**

Run:

```bash
bun -e 'import { Effect } from "effect"; import { buildProjectContext } from "./src/project/context.ts"; console.log(JSON.stringify(await Effect.runPromise(buildProjectContext()), null, 2))'
```

Expected: JSON with `kind: "agentctl.project.context"`, git state, package stack, verification checks, and diagnostics with `configured: false` unless `.agentctl/config.json` exists.

- [ ] **Step 4: Commit**

```bash
git add src/project/context.ts
git commit -m "feat(project): build grounding payloads"
```

## Task 7: Add CLI Routing For `agentctl project`

**Files:**
- Create: `src/cli/project.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Create CLI handler**

Create `src/cli/project.ts` with this complete content:

```typescript
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
```

- [ ] **Step 2: Update root help text**

In `src/cli/index.ts`, update the `HELP` constant so the usage block includes these lines:

```text
  agentctl project context [--json]
  agentctl project verify [--json]
```

Place them after `agentctl recovery [--limit=N]`.

- [ ] **Step 3: Import the project command**

In `src/cli/index.ts`, add this import near the other CLI imports:

```typescript
import { cmdProject } from "./project.ts";
```

- [ ] **Step 4: Route the project command**

In `src/cli/index.ts`, add this case to the `dispatch` switch before the `default` case:

```typescript
        case "project":
            return cmdProject(rest);
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Smoke-test JSON commands**

Run:

```bash
bun src/cli/index.ts project context --json
```

Expected: JSON object with `kind` equal to `agentctl.project.context`.

Run:

```bash
bun src/cli/index.ts project verify --json
```

Expected: JSON object with `kind` equal to `agentctl.project.verify`.

- [ ] **Step 7: Commit**

```bash
git add src/cli/index.ts src/cli/project.ts
git commit -m "feat(project): add context and verify commands"
```

## Task 8: Document The First Project Grounding Loop

**Files:**
- Modify: `README.md`
- Modify: `docs/agentctl-feature-research.md`

- [ ] **Step 1: Add README usage**

In `README.md`, add this block after the existing `Use` command list:

````markdown
### Project Grounding

```bash
agentctl project context --json   # repo stack, instructions, git state, checks
agentctl project verify --json    # diff-aware verification + live diagnostics
```

These commands are designed for Claude Code, Codex, and self-improve jobs. They
are read-only. If `.agentctl/config.json` declares a diagnostics endpoint,
`project verify` also includes live service health and diagnostic issues.
````

- [ ] **Step 2: Add diagnostics config example**

In `README.md`, add this example below the project grounding block:

````markdown
Optional live diagnostics:

```json
{
  "diagnostics": {
    "healthUrl": "http://localhost:4319/internal/health",
    "timeoutMs": 1000
  }
}
```
````

- [ ] **Step 3: Mark the research note decision**

In `docs/agentctl-feature-research.md`, under `Candidate Feature Set`, add this sentence below the `agentctl project verify` heading:

```markdown
First implementation target: static diff-aware checks plus an optional HTTP diagnostics adapter; OTEL persistence remains a later phase.
```

- [ ] **Step 4: Run markdown grep for accidental placeholders**

Run:

```bash
rg "T[B]D|T[O]DO|i[m]plement later|f[i]ll in details" README.md docs/agentctl-feature-research.md docs/superpowers/plans/2026-05-09-project-grounding.md
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/agentctl-feature-research.md
git commit -m "docs: document project grounding commands"
```

## Task 9: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run all project tests added by this plan**

Run:

```bash
bun test src/project/stack.test.ts src/project/verify.test.ts src/project/diagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run CLI smoke tests**

Run:

```bash
bun src/cli/index.ts project context --json > /tmp/agentctl-context.json
bun src/cli/index.ts project verify --json > /tmp/agentctl-verify.json
```

Expected: both commands exit 0.

Run:

```bash
bun -e 'const c=await Bun.file("/tmp/agentctl-context.json").json(); const v=await Bun.file("/tmp/agentctl-verify.json").json(); if (c.kind!=="agentctl.project.context") throw new Error("bad context kind"); if (v.kind!=="agentctl.project.verify") throw new Error("bad verify kind"); console.log("ok")'
```

Expected:

```text
ok
```

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --stat HEAD
```

Expected: only the planned `src/project/*`, `src/cli/*`, `README.md`, and research-note files are changed.

- [ ] **Step 5: Commit any final fixes**

If verification required small fixes, commit them:

```bash
git add src/project src/cli README.md docs/agentctl-feature-research.md
git commit -m "fix(project): polish grounding commands"
```

Skip this commit when there are no final fixes.

## Self-Review

- Spec coverage: the plan covers `project context --json`, `project verify --json`, static git/package/instruction grounding, changed-file verification, optional live diagnostics, README usage, and validation.
- Out of scope by design: command-history ingestion, project memory persistence, recall/entity resolution, OTEL storage, MCP, TUI, and self-improve graph ingestion.
- Placeholder scan: this plan avoids deferred implementation markers and includes exact commands, files, and code for each new module.
- Type consistency: `ProjectContext`, `ProjectVerification`, `GitState`, `ProjectStack`, `VerificationCheck`, and `LiveDiagnostics` are defined once in `src/project/types.ts` and consumed by later tasks.
