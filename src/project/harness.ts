import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { ProcessService } from "../lib/process.ts";
import type { DbError } from "../lib/errors.ts";
import {
    interventionObservationStatus,
    interventionStrengthForConfidence,
} from "../improve/lifecycle.ts";
import { getGitState } from "./git.ts";
import { loadProjectStack } from "./stack.ts";
import { queryLiveDiagnostics } from "./diagnostics.ts";
import type {
    AgentToolingSignal,
    GitState,
    GuidanceEvidenceStrength,
    GuidanceRevision,
    GuidanceSource,
    HarnessDoctorFinding,
    HarnessLearningCandidate,
    InterventionObservation,
    InterventionSuggestion,
    PackageInfo,
    ProjectHarnessReport,
    ProjectStack,
} from "./types.ts";

const REPO_GUIDANCE = ["AGENTS.md", "CLAUDE.md", ".agents", ".claude", ".codex"] as const;
const GLOBAL_GUIDANCE = [
    ".claude/CLAUDE.md",
    ".claude/settings.json",
    ".claude/commands",
    ".claude/skills",
    ".agents/skills",
    ".codex/AGENTS.md",
    ".codex/config.toml",
    ".dotfiles/agents/.agents",
    ".dotfiles/claude/.claude",
] as const;

interface MainBranchGraphEvidence {
    readonly editedOnMain: number;
    readonly commitsFromMain: number;
    readonly latestEditedPath: string | null;
}

interface ObservedToolCallRow {
    readonly name?: string | null;
    readonly command_norm?: string | null;
    readonly calls?: number | null;
}

const hashText = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

function isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

const runGit = (cwd: string, args: readonly string[]): Effect.Effect<string | null, never, ProcessService> =>
    Effect.gen(function* () {
        const proc = yield* ProcessService;
        const result = yield* proc
            .exec("git", ["-C", cwd, ...args], { timeoutMs: 2000 })
            .pipe(Effect.orElseSucceed(() => null));
        if (!result || result.code !== 0) return null;
        return result.stdout.trim();
    });

const commandExists = (name: string): Effect.Effect<boolean, never, ProcessService> =>
    Effect.gen(function* () {
        const proc = yield* ProcessService;
        return yield* proc.commandExists(name);
    });

function providerFor(path: string): GuidanceSource["provider"] {
    if (path.includes(".claude")) return "claude";
    if (path.includes(".codex")) return "codex";
    if (path.includes(".agents")) return "agents";
    if (path.endsWith("AGENTS.md")) return "agents";
    if (path.endsWith("CLAUDE.md")) return "claude";
    return "unknown";
}

function evidenceStrength(path: string, tracked: boolean): GuidanceEvidenceStrength {
    if (tracked) return "tracked";
    if (path.includes("/plugins/cache/")) return "plugin-cache";
    if (path.includes("/dist/") || path.includes("/node_modules/")) return "generated";
    return "untracked";
}

const gitRootFor = (path: string): Effect.Effect<string | null, never, ProcessService> =>
    runGit(statSync(path).isDirectory() ? path : dirname(path), ["rev-parse", "--show-toplevel"]);

const isTracked = (path: string, gitRoot: string | null): Effect.Effect<boolean, never, ProcessService> =>
    Effect.gen(function* () {
        if (!gitRoot || !isInside(path, gitRoot)) return false;
        const rel = relative(gitRoot, path);
        const out = yield* runGit(gitRoot, ["ls-files", "--", rel]);
        return out !== null && out.length > 0;
    });

function candidateGuidancePaths(root: string | null): string[] {
    const paths: string[] = [];
    if (root) {
        for (const item of REPO_GUIDANCE) {
            const path = join(root, item);
            if (existsSync(path)) paths.push(path);
        }
    }
    const home = homedir();
    for (const item of GLOBAL_GUIDANCE) {
        const path = join(home, item);
        if (existsSync(path)) paths.push(path);
    }
    return [...new Set(paths)];
}

export const scanGuidanceSources = (root: string | null): Effect.Effect<ReadonlyArray<GuidanceSource>, never, ProcessService> =>
    Effect.gen(function* () {
        const out: GuidanceSource[] = [];
        for (const path of candidateGuidancePaths(root)) {
            const stat = statSync(path);
            const gitRoot = yield* gitRootFor(path);
            const tracked = yield* isTracked(path, gitRoot);
            out.push({
                path,
                kind: stat.isDirectory() ? "directory" : "file",
                scope: root && isInside(path, root) ? "repository" : path.includes("/plugins/cache/") ? "plugin-cache" : "global",
                provider: providerFor(path),
                evidenceStrength: evidenceStrength(path, tracked),
                gitRoot,
                tracked,
            });
        }
        return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path));
    });

async function contentForRevision(path: string): Promise<string> {
    const stat = statSync(path);
    if (!stat.isDirectory()) return await readFile(path, "utf8");
    const names = readdirSync(path).sort().slice(0, 200);
    return names.join("\n");
}

export const buildGuidanceRevisions = (
    sources: ReadonlyArray<GuidanceSource>,
): Effect.Effect<ReadonlyArray<GuidanceRevision>, never, ProcessService> =>
    Effect.gen(function* () {
        const observedAt = new Date().toISOString();
        const revisions: GuidanceRevision[] = [];
        for (const source of sources) {
            const content = yield* Effect.promise(() => contentForRevision(source.path));
            const head = source.gitRoot ? yield* runGit(source.gitRoot, ["rev-parse", "--short", "HEAD"]) : null;
            revisions.push({
                sourcePath: source.path,
                scope: source.scope,
                contentHash: hashText(content),
                evidenceStrength: source.evidenceStrength,
                observedAt,
                commitEvidence: source.tracked ? head : null,
                fileEvidence: source.kind === "file" ? source.path : null,
            });
        }
        return revisions;
    });

function packageTooling(pkg: PackageInfo): AgentToolingSignal[] {
    const out: AgentToolingSignal[] = [];
    for (const [name, script] of Object.entries(pkg.scripts)) {
        const layer: AgentToolingSignal["layer"] =
            /test|typecheck|lint|check|build/.test(name) ? "verification" :
            /git|worktree|merge|release|daemon|watcher/.test(name) ? "boundary" :
            "representation";
        out.push({ name, layer, source: "package-script", evidence: script });
    }
    return out;
}

export const detectAgentTooling = (git: GitState, stack: ProjectStack): Effect.Effect<ReadonlyArray<AgentToolingSignal>, never, ProcessService> =>
    Effect.gen(function* () {
        const out = packageTooling(stack.package);
        for (const name of ["rg", "fd", "fzf", "jq", "bat", "delta"]) {
            if (yield* commandExists(name)) {
                out.push({
                    name,
                    layer: ["rg", "fd", "fzf"].includes(name) ? "perception" : "representation",
                    source: "global-command",
                    evidence: `${name} on PATH`,
                });
            }
        }
        if (git.root) {
            out.push({ name: "git", layer: "boundary", source: "git", evidence: `repository root ${git.root}` });
            out.push({ name: "git-worktree", layer: "boundary", source: "git", evidence: "git worktree available" });
        }
        return out;
    });

function layerForObservedTool(name: string): AgentToolingSignal["layer"] {
    if (/^(rg|grep|find|fd|ls|cat|sed|awk)\b/.test(name)) return "perception";
    if (/^(jq|bat|delta|git diff)\b/.test(name)) return "representation";
    if (/\b(test|typecheck|tsc|tsgo|lint|oxc|build|check)\b/.test(name)) return "verification";
    if (/^(git|gh)\b/.test(name)) return "boundary";
    return "representation";
}

const fetchObservedTooling = (): Effect.Effect<ReadonlyArray<AgentToolingSignal>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sql = `
SELECT
    command_norm,
    name,
    count() AS calls
FROM tool_call
WHERE ts > time::now() - 30d
        GROUP BY command_norm, name
ORDER BY calls DESC
LIMIT 25;`;
        const result = yield* db.query<[ObservedToolCallRow[]]>(sql);
        const signals: AgentToolingSignal[] = [];
        for (const row of result?.[0] ?? []) {
            const name = row.command_norm ?? row.name ?? null;
            const calls = Number(row.calls ?? 0);
            if (!name || calls <= 0) continue;
            signals.push({
                    name,
                    layer: layerForObservedTool(name),
                    source: "observed",
                    evidence: `${calls} observed calls in 30d`,
            });
        }
        return signals;
    });

function finding(
    layer: HarnessDoctorFinding["layer"],
    signals: ReadonlyArray<AgentToolingSignal>,
    title: string,
    recommendation: string,
): HarnessDoctorFinding {
    const evidence = signals.filter((s) => s.layer === layer).map((s) => `${s.name}: ${s.evidence}`);
    return {
        layer,
        status: evidence.length >= 2 ? "strong" : evidence.length === 1 ? "ok" : "weak",
        title,
        evidence,
        recommendation: evidence.length === 0 ? recommendation : null,
    };
}

export function buildHarnessDoctor(tooling: ReadonlyArray<AgentToolingSignal>): ReadonlyArray<HarnessDoctorFinding> {
    return [
        finding("perception", tooling, "Agent perception tools", "Expose rg/fd/fzf or equivalent search commands."),
        finding("representation", tooling, "Agent-readable representation", "Expose jq/bat/delta or structured JSON outputs."),
        finding("verification", tooling, "Fast verification loop", "Add reliable typecheck/test/lint/build scripts."),
        finding("boundary", tooling, "Boundary controls", "Document branch/worktree policy or add scoped guardrails."),
    ];
}

function hasWriteRiskOnMain(git: GitState): boolean {
    if (git.branch !== "main" && git.branch !== "master") return false;
    return git.changes.some((change) => !change.path.endsWith(".md") || change.path === "package.json");
}

export function mainBranchLearning(
    git: GitState,
    sources: ReadonlyArray<GuidanceSource>,
): HarnessLearningCandidate {
    const hasGuidance = sources.some((s) => /AGENTS\.md|CLAUDE\.md|settings\.json|hooks?/.test(s.path));
    const evidence = [
        `current branch: ${git.branch ?? "unknown"}`,
        `dirty files: ${git.changes.length}`,
        hasWriteRiskOnMain(git) ? "current checkout has write-risk changes on main/master" : "no current write-risk changes on main/master",
        hasGuidance ? "guidance source exists for branch policy" : "no branch-policy guidance source detected",
    ];
    return {
        title: "Block main-branch edits in multi-agent projects",
        problem: "Agents can ignore advisory guidance and edit or commit on main during coordinated work.",
        pattern: "Start with advisory guidance, then escalate to workflow automation or a scoped guardrail when violations recur.",
        harnessLayer: "boundary",
        risk: { kind: "branch_safety", level: "high" },
        appliesWhen: ["multi-agent work", "shared repository", "non-trivial edits"],
        avoidWhen: ["explicit hotfix approval", "read-only exploration", "single-user throwaway repo"],
        evidenceSummary: evidence,
        suggestedIntervention: "Recommend branch/worktree confirmation before write-risk actions; escalate to hook only after recurrence or high risk.",
        confidence: hasWriteRiskOnMain(git) ? "medium" : "low",
    };
}

export function interventionForMainBranch(candidate: HarnessLearningCandidate): InterventionSuggestion {
    return {
        title: candidate.title,
        strength: interventionStrengthForConfidence(candidate.confidence),
        approvalRequired: true,
        expectedEffect: "Reduce write-risk actions on main/master during multi-agent work.",
        reviewCriteria: [
            "sessions started on main for non-trivial work",
            "write/edit/commit/push attempts on main",
            "user overrides and false positives",
            "branch or worktree adoption after recommendation",
        ],
    };
}

export function observationForMainBranch(
    git: GitState,
    graph: MainBranchGraphEvidence = {
        editedOnMain: 0,
        commitsFromMain: 0,
        latestEditedPath: null,
    },
): InterventionObservation {
    const currentRisk = hasWriteRiskOnMain(git);
    const graphRisk = graph.editedOnMain > 0 || graph.commitsFromMain > 0;
    return {
        target: "main-branch guardrail",
        status: interventionObservationStatus({ currentRisk, graphRisk }),
        metrics: {
            dirtyFiles: git.changes.length,
            writeRiskOnMain: currentRisk ? 1 : 0,
            graphEditedOnMain: graph.editedOnMain,
            graphCommitsFromMain: graph.commitsFromMain,
        },
        before: {
            graphEditedOnMain: graph.editedOnMain,
            graphCommitsFromMain: graph.commitsFromMain,
        },
        after: null,
        notes: [
            ...(currentRisk ? ["Current checkout is on main/master with write-risk changes."] : []),
            ...(graphRisk
                ? [`Graph has main/master write-risk evidence; latest edited path: ${graph.latestEditedPath ?? "unknown"}.`]
                : []),
            ...(!currentRisk && !graphRisk
                ? ["Need more ingested session history to measure recurrence over time."]
                : []),
        ],
    };
}

const fetchMainBranchGraphEvidence = (): Effect.Effect<MainBranchGraphEvidence, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sql = `
RETURN {
    editedOnMain: ((SELECT count() AS count FROM edited WHERE checkout.branch IN ["main", "master"] GROUP ALL)[0].count ?? 0),
    commitsFromMain: ((SELECT count() AS count FROM produced WHERE checkout.branch IN ["main", "master"] GROUP ALL)[0].count ?? 0),
    latestEditedPath: (SELECT path_seen, ts FROM edited WHERE checkout.branch IN ["main", "master"] ORDER BY ts DESC LIMIT 1)[0].path_seen
};`;
        const result = yield* db.query<[MainBranchGraphEvidence]>(sql);
        const row = result?.[0] ?? { editedOnMain: 0, commitsFromMain: 0, latestEditedPath: null };
        return {
            editedOnMain: Number(row.editedOnMain ?? 0),
            commitsFromMain: Number(row.commitsFromMain ?? 0),
            latestEditedPath: typeof row.latestEditedPath === "string" ? row.latestEditedPath : null,
        };
    });

export const buildProjectHarnessReport = (cwd = process.cwd()): Effect.Effect<ProjectHarnessReport, DbError, SurrealClient | ProcessService> =>
    Effect.gen(function* () {
        const git = yield* getGitState(cwd);
        const stack = yield* loadProjectStack(git.root);
        yield* queryLiveDiagnostics(git.root);
        const graphEvidence = yield* fetchMainBranchGraphEvidence();
        const guidanceSources = yield* scanGuidanceSources(git.root);
        const guidanceRevisions = yield* buildGuidanceRevisions(guidanceSources);
        const staticTooling = yield* detectAgentTooling(git, stack);
        const observedTooling = yield* fetchObservedTooling();
        const agentTooling = [...staticTooling, ...observedTooling];
        const candidate = mainBranchLearning(git, guidanceSources);
        return {
            kind: "ax.project.harness",
            generatedAt: new Date().toISOString(),
            git,
            guidanceSources,
            guidanceRevisions,
            stacks: stack.signals,
            agentTooling,
            doctor: buildHarnessDoctor(agentTooling),
            learningCandidates: [candidate],
            interventions: [interventionForMainBranch(candidate)],
            observations: [observationForMainBranch(git, graphEvidence)],
        };
    });
