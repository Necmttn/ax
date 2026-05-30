import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

export type ArtifactRootKind =
    | "planning"
    | "claude_monitoring"
    | "claude_workflows"
    | "superpowers_plans"
    | "skill_root";

export type ArtifactKind =
    | "planning_markdown"
    | "planning_data"
    | "claude_monitoring_markdown"
    | "claude_workflow_script"
    | "superpowers_plan"
    | "skill";

export type ArtifactSkipReason =
    | "missing_root"
    | "ignored_dir"
    | "nested_git_repo"
    | "symlink"
    | "unsupported_extension"
    | "too_large"
    | "binary"
    | "read_error";

export type ArtifactRoot = {
    readonly kind: ArtifactRootKind;
    readonly path: string;
};

export type ArtifactCandidate = {
    readonly path: string;
    readonly relativePath: string;
    readonly rootKind: ArtifactRootKind;
    readonly artifactKind: ArtifactKind;
    readonly bytes: number;
};

export type ArtifactSkip = {
    readonly path: string;
    readonly relativePath: string | null;
    readonly rootKind: ArtifactRootKind | null;
    readonly reason: ArtifactSkipReason;
    readonly bytes?: number;
};

export type ArtifactDiscoveryOptions = {
    readonly workspaceRoot: string;
    readonly skillRoots?: readonly string[];
    readonly maxFileBytes?: number;
};

export type ArtifactDiscoveryDryRun = {
    readonly roots: readonly ArtifactRoot[];
    readonly candidates: readonly ArtifactCandidate[];
    readonly skipped: readonly ArtifactSkip[];
    readonly counts: {
        readonly roots: number;
        readonly found: number;
        readonly skipped: number;
        readonly byKind: Readonly<Record<ArtifactKind, number>>;
        readonly bySkipReason: Readonly<Record<ArtifactSkipReason, number>>;
    };
};

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const TEXT_SAMPLE_BYTES = 4096;
const IGNORED_DIR_NAMES = new Set([".git", "node_modules"]);
const PLANNING_EXTENSIONS = new Set([".md", ".markdown", ".yaml", ".yml", ".json"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const WORKFLOW_SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".ts"]);

export function artifactRootsForOptions(options: ArtifactDiscoveryOptions): ArtifactRoot[] {
    const workspaceRoot = resolve(options.workspaceRoot);
    const roots: ArtifactRoot[] = [
        { kind: "planning", path: join(workspaceRoot, ".planning") },
        { kind: "claude_monitoring", path: join(workspaceRoot, ".claude", "monitoring") },
        { kind: "claude_workflows", path: join(workspaceRoot, ".claude", "workflows") },
        { kind: "superpowers_plans", path: join(workspaceRoot, "docs", "superpowers", "plans") },
    ];

    for (const skillRoot of options.skillRoots ?? []) {
        roots.push({ kind: "skill_root", path: resolve(skillRoot) });
    }

    return dedupeRoots(roots);
}

export function classifyArtifactPath(
    path: string,
    rootKind: ArtifactRootKind,
): ArtifactKind | null {
    const name = basename(path);
    const ext = extensionOf(path);

    switch (rootKind) {
        case "planning":
            if (!PLANNING_EXTENSIONS.has(ext)) return null;
            return ext === ".md" || ext === ".markdown" ? "planning_markdown" : "planning_data";
        case "claude_monitoring":
            return MARKDOWN_EXTENSIONS.has(ext) ? "claude_monitoring_markdown" : null;
        case "claude_workflows":
            return WORKFLOW_SCRIPT_EXTENSIONS.has(ext) ? "claude_workflow_script" : null;
        case "superpowers_plans":
            return MARKDOWN_EXTENSIONS.has(ext) ? "superpowers_plan" : null;
        case "skill_root":
            return name === "SKILL.md" ? "skill" : null;
    }
}

export async function discoverArtifactsDryRun(
    options: ArtifactDiscoveryOptions,
): Promise<ArtifactDiscoveryDryRun> {
    const roots = artifactRootsForOptions(options);
    const candidates: ArtifactCandidate[] = [];
    const skipped: ArtifactSkip[] = [];
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

    for (const root of roots) {
        let rootStat;
        try {
            rootStat = await stat(root.path);
        } catch {
            skipped.push(skip(root, root.path, "missing_root"));
            continue;
        }
        if (!rootStat.isDirectory()) {
            skipped.push(skip(root, root.path, "missing_root"));
            continue;
        }

        await walkArtifactRoot({
            root,
            currentPath: root.path,
            rootPath: root.path,
            maxFileBytes,
            candidates,
            skipped,
        });
    }

    return {
        roots,
        candidates: candidates.sort(compareByPath),
        skipped: skipped.sort(compareByPath),
        counts: buildCounts(candidates, skipped, roots),
    };
}

type WalkState = {
    readonly root: ArtifactRoot;
    readonly currentPath: string;
    readonly rootPath: string;
    readonly maxFileBytes: number;
    readonly candidates: ArtifactCandidate[];
    readonly skipped: ArtifactSkip[];
};

async function walkArtifactRoot(state: WalkState): Promise<void> {
    let entries;
    try {
        entries = await readdir(state.currentPath, { withFileTypes: true });
    } catch {
        state.skipped.push(skip(state.root, state.currentPath, "read_error"));
        return;
    }

    for (const entry of entries) {
        const fullPath = join(state.currentPath, entry.name);

        if (entry.isSymbolicLink()) {
            state.skipped.push(skip(state.root, fullPath, "symlink"));
            continue;
        }

        if (entry.isDirectory()) {
            if (shouldIgnoreDirectory(fullPath, entry.name)) {
                state.skipped.push(skip(state.root, fullPath, "ignored_dir"));
                continue;
            }
            if (await isNestedGitRepo(fullPath, state.rootPath)) {
                state.skipped.push(skip(state.root, fullPath, "nested_git_repo"));
                continue;
            }
            await walkArtifactRoot({ ...state, currentPath: fullPath });
            continue;
        }

        if (!entry.isFile()) continue;

        const artifactKind = classifyArtifactPath(fullPath, state.root.kind);
        if (!artifactKind) {
            state.skipped.push(skip(state.root, fullPath, "unsupported_extension"));
            continue;
        }

        let fileStat;
        try {
            fileStat = await lstat(fullPath);
        } catch {
            state.skipped.push(skip(state.root, fullPath, "read_error"));
            continue;
        }

        if (fileStat.size > state.maxFileBytes) {
            state.skipped.push(skip(state.root, fullPath, "too_large", fileStat.size));
            continue;
        }

        if (await looksBinary(fullPath)) {
            state.skipped.push(skip(state.root, fullPath, "binary", fileStat.size));
            continue;
        }

        state.candidates.push({
            path: fullPath,
            relativePath: relativeSlash(state.root.path, fullPath),
            rootKind: state.root.kind,
            artifactKind,
            bytes: fileStat.size,
        });
    }
}

function shouldIgnoreDirectory(path: string, name: string): boolean {
    if (IGNORED_DIR_NAMES.has(name)) return true;
    return path.split(sep).includes(".claude") && name === "worktrees";
}

async function isNestedGitRepo(path: string, rootPath: string): Promise<boolean> {
    if (resolve(path) === resolve(rootPath)) return false;
    try {
        const gitStat = await lstat(join(path, ".git"));
        return gitStat.isDirectory() || gitStat.isFile();
    } catch {
        return false;
    }
}

async function looksBinary(path: string): Promise<boolean> {
    let sample;
    try {
        sample = await readFile(path);
    } catch {
        return false;
    }
    const capped = sample.subarray(0, TEXT_SAMPLE_BYTES);
    return capped.includes(0);
}

function extensionOf(path: string): string {
    const name = basename(path);
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function skip(
    root: ArtifactRoot | null,
    path: string,
    reason: ArtifactSkipReason,
    bytes?: number,
): ArtifactSkip {
    return {
        path,
        relativePath: root ? relativeSlash(root.path, path) : null,
        rootKind: root?.kind ?? null,
        reason,
        ...(bytes === undefined ? {} : { bytes }),
    };
}

function buildCounts(
    candidates: readonly ArtifactCandidate[],
    skipped: readonly ArtifactSkip[],
    roots: readonly ArtifactRoot[],
): ArtifactDiscoveryDryRun["counts"] {
    const byKind = emptyKindCounts();
    for (const candidate of candidates) byKind[candidate.artifactKind]++;

    const bySkipReason = emptySkipCounts();
    for (const item of skipped) bySkipReason[item.reason]++;

    return {
        roots: roots.length,
        found: candidates.length,
        skipped: skipped.length,
        byKind,
        bySkipReason,
    };
}

function emptyKindCounts(): Record<ArtifactKind, number> {
    return {
        planning_markdown: 0,
        planning_data: 0,
        claude_monitoring_markdown: 0,
        claude_workflow_script: 0,
        superpowers_plan: 0,
        skill: 0,
    };
}

function emptySkipCounts(): Record<ArtifactSkipReason, number> {
    return {
        missing_root: 0,
        ignored_dir: 0,
        nested_git_repo: 0,
        symlink: 0,
        unsupported_extension: 0,
        too_large: 0,
        binary: 0,
        read_error: 0,
    };
}

function dedupeRoots(roots: readonly ArtifactRoot[]): ArtifactRoot[] {
    const seen = new Set<string>();
    const out: ArtifactRoot[] = [];
    for (const root of roots) {
        const key = `${root.kind}:${resolve(root.path)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...root, path: resolve(root.path) });
    }
    return out;
}

function compareByPath(a: { readonly path: string }, b: { readonly path: string }): number {
    return a.path.localeCompare(b.path);
}

function relativeSlash(from: string, to: string): string {
    const rel = relative(from, to);
    return rel === "" ? "." : rel.split(sep).join("/");
}
