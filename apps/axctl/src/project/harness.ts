import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { ProcessService } from "@ax/lib/process";
import type { DbError } from "@ax/lib/errors";
import { getGitState } from "./git.ts";
import {
    defaultHarnessDoctorReportBuilder,
    type HarnessDoctorReportBuilder,
    type MainBranchGraphEvidence,
} from "./harness-doctor.ts";
import { loadProjectStack } from "./stack.ts";
import { queryLiveDiagnostics } from "./diagnostics.ts";
import type {
    AgentToolingSignal,
    GitState,
    GuidanceEvidenceStrength,
    GuidanceRevision,
    GuidanceSource,
    PackageInfo,
    ProjectHarnessReport,
    ProjectStack,
} from "./types.ts";

export {
    buildHarnessDoctor,
    buildHarnessDoctorReport,
    interventionForMainBranch,
    mainBranchLearning,
    observationForMainBranch,
} from "./harness-doctor.ts";

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

export const buildProjectHarnessReport = (
    cwd = process.cwd(),
    builder: HarnessDoctorReportBuilder = defaultHarnessDoctorReportBuilder,
): Effect.Effect<ProjectHarnessReport, DbError, SurrealClient | ProcessService> =>
    Effect.gen(function* () {
        const git = yield* getGitState(cwd);
        const stack = yield* loadProjectStack(git.root);
        yield* queryLiveDiagnostics(git.root);
        const graphEvidence = yield* fetchMainBranchGraphEvidence();
        const guidanceSources = yield* scanGuidanceSources(git.root);
        const guidanceRevisions = yield* buildGuidanceRevisions(guidanceSources);
        const staticTooling = yield* detectAgentTooling(git, stack);
        const observedTooling = yield* fetchObservedTooling();
        return builder.build({
            git,
            stack,
            guidanceSources,
            guidanceRevisions,
            staticTooling,
            observedTooling,
            mainBranchGraph: graphEvidence,
        });
    });
