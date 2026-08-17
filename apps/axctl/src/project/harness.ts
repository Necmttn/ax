import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { Effect, FileSystem, Path, Schema } from "effect";
import type { Clause } from "@ax/lib/duckdb/clause";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheReadService } from "@ax/lib/duckdb/seam";
import { ProcessService } from "@ax/lib/process";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";
import { getGitState } from "./git.ts";
import {
    defaultHarnessDoctorReportBuilder,
    mainBranchLearning,
    type HarnessDoctorReportBuilder,
    type MainBranchGraphEvidence,
} from "./harness-doctor.ts";
import { loadProjectStack } from "./stack.ts";
import { queryLiveDiagnostics } from "./diagnostics.ts";
import type {
    AgentToolingSignal,
    GitState,
    HarnessLearningCandidate,
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

/** How far back the observed-tooling signal looks. */
const OBSERVED_WINDOW_DAYS = 30;

const hashText = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

function isInside(child: string, parent: string): boolean {
    const rel = posixPath.relative(parent, child);
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

const gitRootFor = (
    path: string,
): Effect.Effect<string | null, never, ProcessService | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Original used bare statSync (FOLLOWS symlinks) on an existsSync-confirmed
        // candidate path; throw-on-failure preserved via orDie. fs.stat also follows.
        const info = yield* fs.stat(path).pipe(Effect.orDie);
        const base = info.type === "Directory" ? path : posixPath.dirname(path);
        return yield* runGit(base, ["rev-parse", "--show-toplevel"]);
    });

const isTracked = (path: string, gitRoot: string | null): Effect.Effect<boolean, never, ProcessService> =>
    Effect.gen(function* () {
        if (!gitRoot || !isInside(path, gitRoot)) return false;
        const rel = posixPath.relative(gitRoot, path);
        const out = yield* runGit(gitRoot, ["ls-files", "--", rel]);
        return out !== null && out.length > 0;
    });

const candidateGuidancePaths = (
    root: string | null,
): Effect.Effect<string[], never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths: string[] = [];
        if (root) {
            for (const item of REPO_GUIDANCE) {
                const path = posixPath.join(root, item);
                // existsSync probe → orAbsent(false): a fault means "treat as absent".
                if (yield* fs.exists(path).pipe(orAbsent(false))) paths.push(path);
            }
        }
        const home = homedir();
        for (const item of GLOBAL_GUIDANCE) {
            const path = posixPath.join(home, item);
            if (yield* fs.exists(path).pipe(orAbsent(false))) paths.push(path);
        }
        return [...new Set(paths)];
    });

export const scanGuidanceSources = (
    root: string | null,
): Effect.Effect<ReadonlyArray<GuidanceSource>, never, ProcessService | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const out: GuidanceSource[] = [];
        for (const path of yield* candidateGuidancePaths(root)) {
            // Original used bare statSync (FOLLOWS symlinks) on an existsSync-confirmed
            // path; throw-on-failure preserved via orDie. fs.stat also follows.
            const stat = yield* fs.stat(path).pipe(Effect.orDie);
            const gitRoot = yield* gitRootFor(path);
            const tracked = yield* isTracked(path, gitRoot);
            out.push({
                path,
                kind: stat.type === "Directory" ? "directory" : "file",
                scope: root && isInside(path, root) ? "repository" : path.includes("/plugins/cache/") ? "plugin-cache" : "global",
                provider: providerFor(path),
                evidenceStrength: evidenceStrength(path, tracked),
                gitRoot,
                tracked,
            });
        }
        return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path));
    });

const contentForRevision = (
    path: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Original used bare statSync (FOLLOWS symlinks) on a known-present source
        // path; throw-on-failure preserved via orDie. fs.stat also follows.
        const stat = yield* fs.stat(path).pipe(Effect.orDie);
        // readFile/readdirSync had no recovery (failure → throw/defect) → orDie.
        if (stat.type !== "Directory") return yield* fs.readFileString(path).pipe(Effect.orDie);
        const names = (yield* fs.readDirectory(path).pipe(Effect.orDie)).sort().slice(0, 200);
        return names.join("\n");
    });

export const buildGuidanceRevisions = (
    sources: ReadonlyArray<GuidanceSource>,
): Effect.Effect<ReadonlyArray<GuidanceRevision>, never, ProcessService | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const observedAt = new Date().toISOString();
        const revisions: GuidanceRevision[] = [];
        for (const source of sources) {
            const content = yield* contentForRevision(source.path);
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

const ObservedToolRow = Schema.Struct({
    tool_name: Schema.String,
    calls: NumberFromBigIntColumn,
});

/**
 * The 25 most-used tools of the last 30 days.
 *
 * `command_norm ?? name` is computed in SQL via `coalesce`, because it is what
 * the rows are GROUPED BY: grouping on the pair and collapsing afterwards
 * splits one tool's calls across two rows whenever some of its invocations
 * normalized and others did not, and then ranks the halves separately.
 *
 * `time::now() - 30d` becomes a bound cutoff computed here. DuckDB would spell
 * it `now() - INTERVAL 30 DAY`, but a bound parameter keeps the window testable
 * without a clock, and the seam pins the connection to UTC either way.
 */
export const fetchObservedTooling = (read: CacheReadService): Effect.Effect<
    ReadonlyArray<AgentToolingSignal>,
    CacheReadError
> =>
    Effect.gen(function* () {
        const cutoff = new Date(Date.now() - OBSERVED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        const rows = yield* read.rows(
            ObservedToolRow,
            // The alias is `tool_name`, not `tool`: `tool_call` HAS a column
            // called `tool` (its ref to the tool row), so `GROUP BY tool`
            // binds to that column rather than to the alias, and DuckDB
            // then rejects the statement. Measured, not guessed.
            `SELECT coalesce(command_norm, name) AS tool_name, count(*) AS calls
                      FROM tool_call
                      WHERE ts > ? AND coalesce(command_norm, name) IS NOT NULL
                      GROUP BY tool_name
                      ORDER BY calls DESC, tool_name ASC
                      LIMIT 25`,
            [cutoff],
        );

        return rows
            .filter((row) => row.tool_name.length > 0 && row.calls > 0)
            .map((row) => ({
                name: row.tool_name,
                layer: layerForObservedTool(row.tool_name),
                source: "observed" as const,
                evidence: `${row.calls} observed calls in ${OBSERVED_WINDOW_DAYS}d`,
            }));
    });

const MainBranchCountRow = Schema.Struct({ count: NumberFromBigIntColumn });
const LatestEditRow = Schema.Struct({ path_seen: Schema.NullOr(Schema.String) });

/** The branches this treats as "the shared trunk" for the worktree-guard advice. */
const MAIN_BRANCHES = ["main", "master"];
const MAIN_BRANCH_PLACEHOLDERS = MAIN_BRANCHES.map(() => "?").join(", ");

/**
 * Did work happen directly on the trunk?
 *
 * `edited.checkout` and `produced.checkout` are plain VARCHARs holding the
 * checkout row id, so reaching `checkout.branch` is an ordinary JOIN. Three
 * statements rather than one combined query: each is an indexed aggregate,
 * and the combination happens here, where it is legible.
 */
const onMainCount = (table: "edited" | "produced"): Clause => ({
    sql: `SELECT count(*) AS count FROM ${table} e
          JOIN checkout c ON c.id = e.checkout
          WHERE c.branch IN (${MAIN_BRANCH_PLACEHOLDERS})`,
    params: MAIN_BRANCHES,
});

export const fetchMainBranchGraphEvidence = (read: CacheReadService): Effect.Effect<
    MainBranchGraphEvidence,
    CacheReadError
> =>
    Effect.gen(function* () {
        const editedQuery = onMainCount("edited");
        const edited = (yield* read.rows(MainBranchCountRow, editedQuery.sql, editedQuery.params))[0] ?? null;
        const producedQuery = onMainCount("produced");
        const produced = (yield* read.rows(MainBranchCountRow, producedQuery.sql, producedQuery.params))[0] ?? null;
        const latest = (yield* read.rows(
            LatestEditRow,
            `SELECT e.path_seen AS path_seen FROM edited e
                      JOIN checkout c ON c.id = e.checkout
                      WHERE c.branch IN (${MAIN_BRANCH_PLACEHOLDERS})
                      ORDER BY e.ts DESC LIMIT 1`,
            MAIN_BRANCHES,
        ))[0] ?? null;

        return {
            editedOnMain: edited?.count ?? 0,
            commitsFromMain: produced?.count ?? 0,
            latestEditedPath: latest?.path_seen ?? null,
        };
    });

/**
 * Everything the harness report can say from the FILESYSTEM AND GIT ALONE - no
 * database read of any kind.
 *
 * This exists because the two ingest stages that consume harness output do not
 * in fact need the graph half, and reading it there would mix two DuckDB
 * views that must stay separate: an ingest stage writes through `CacheWrite`
 * (the live database), while `CacheRead` only ever answers from the last
 * PUBLISHED SNAPSHOT - which by construction omits everything the run
 * currently in progress has written. `ingest/harness.ts` writes only the
 * three collections below, and `ingest/derive-proposals.ts` reads only
 * `learningCandidates`, which `mainBranchLearning` derives from git plus the
 * guidance sources.
 *
 * So the split is not a workaround - it is where the seam belongs. The graph
 * half belongs to {@link buildProjectHarnessReport}, which only the READ
 * command calls.
 */
export interface HarnessGrounding {
    readonly git: GitState;
    readonly guidanceSources: ReadonlyArray<GuidanceSource>;
    readonly guidanceRevisions: ReadonlyArray<GuidanceRevision>;
    readonly stacks: ProjectStack["signals"];
    readonly learningCandidates: ReadonlyArray<HarnessLearningCandidate>;
}

export const buildHarnessGrounding = (
    cwd = process.cwd(),
): Effect.Effect<HarnessGrounding, never, ProcessService | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const git = yield* getGitState(cwd);
        const stack = yield* loadProjectStack(git.root);
        yield* queryLiveDiagnostics(git.root);
        const guidanceSources = yield* scanGuidanceSources(git.root);
        const guidanceRevisions = yield* buildGuidanceRevisions(guidanceSources);
        return {
            git,
            guidanceSources,
            guidanceRevisions,
            stacks: stack.signals,
            learningCandidates: [mainBranchLearning(git, guidanceSources)],
        };
    });

/**
 * The full harness report: the grounding above plus the two GRAPH reads, which
 * come from the published cache snapshot.
 *
 * Requires `CacheRead`, and therefore belongs to a READ command - `ax project`
 * through `project/context.ts`. An ingest stage must call
 * {@link buildHarnessGrounding} instead; see its note.
 */
export const buildProjectHarnessReport = (
    read: CacheReadService,
    cwd = process.cwd(),
    builder: HarnessDoctorReportBuilder = defaultHarnessDoctorReportBuilder,
): Effect.Effect<ProjectHarnessReport, CacheReadError, ProcessService | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const git = yield* getGitState(cwd);
        const stack = yield* loadProjectStack(git.root);
        yield* queryLiveDiagnostics(git.root);
        const graphEvidence = yield* fetchMainBranchGraphEvidence(read);
        const guidanceSources = yield* scanGuidanceSources(git.root);
        const guidanceRevisions = yield* buildGuidanceRevisions(guidanceSources);
        const staticTooling = yield* detectAgentTooling(git, stack);
        const observedTooling = yield* fetchObservedTooling(read);
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
