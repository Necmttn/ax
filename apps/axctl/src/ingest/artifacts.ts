import { Effect, FileSystem, Option, Path } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";

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
    const workspaceRoot = posixPath.resolve(options.workspaceRoot);
    const roots: ArtifactRoot[] = [
        { kind: "planning", path: posixPath.join(workspaceRoot, ".planning") },
        { kind: "claude_monitoring", path: posixPath.join(workspaceRoot, ".claude", "monitoring") },
        { kind: "claude_workflows", path: posixPath.join(workspaceRoot, ".claude", "workflows") },
        { kind: "superpowers_plans", path: posixPath.join(workspaceRoot, "docs", "superpowers", "plans") },
    ];

    for (const skillRoot of options.skillRoots ?? []) {
        roots.push({ kind: "skill_root", path: posixPath.resolve(skillRoot) });
    }

    return dedupeRoots(roots);
}

export function classifyArtifactPath(
    path: string,
    rootKind: ArtifactRootKind,
): ArtifactKind | null {
    const name = posixPath.basename(path);
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

/**
 * lstat-equivalent (does NOT follow symlinks) entry classification. Effect's
 * `FileSystem` has no `lstat` and `fs.stat` follows symlinks, so we detect a
 * symlink first: `readLink` SUCCEEDS iff the path is a symlink, fails otherwise.
 * When it is not a symlink, `fs.stat` reports the real type (a real file/dir is
 * unaffected by symlink-following). This reproduces the old `Dirent`-based
 * `isSymbolicLink()/isDirectory()/isFile()` partition exactly.
 */
type EntryType = "SymbolicLink" | "Directory" | "File" | "Other" | "Missing";

const classifyEntry = (
    fullPath: string,
): Effect.Effect<EntryType, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const isSymlink = yield* fs.readLink(fullPath).pipe(
            Effect.map(() => true),
            orAbsent(false),
        );
        if (isSymlink) return "SymbolicLink";
        const info = yield* fs.stat(fullPath).pipe(Effect.asSome, orAbsent(Option.none()));
        if (Option.isNone(info)) return "Missing";
        const type = info.value.type;
        if (type === "Directory") return "Directory";
        if (type === "File") return "File";
        return "Other";
    });

export const discoverArtifactsDryRun = (
    options: ArtifactDiscoveryOptions,
): Effect.Effect<ArtifactDiscoveryDryRun, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const roots = artifactRootsForOptions(options);
        const candidates: ArtifactCandidate[] = [];
        const skipped: ArtifactSkip[] = [];
        const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

        for (const root of roots) {
            // OLD: `stat(root.path)` in try/catch → "missing_root" on any fault;
            // also "missing_root" when it is not a directory. The root itself is
            // never a symlink we want to follow specially, so a plain stat is
            // faithful here.
            const entryType = yield* classifyEntry(root.path);
            if (entryType !== "Directory") {
                skipped.push(skip(root, root.path, "missing_root"));
                continue;
            }

            yield* walkArtifactRoot({
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
    });

type WalkState = {
    readonly root: ArtifactRoot;
    readonly currentPath: string;
    readonly rootPath: string;
    readonly maxFileBytes: number;
    readonly candidates: ArtifactCandidate[];
    readonly skipped: ArtifactSkip[];
};

const walkArtifactRoot = (
    state: WalkState,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // OLD: `readdir(withFileTypes)` in try/catch → "read_error" on any fault.
        // `readDirectory` returns names only; we re-derive symlink/dir/file via
        // `classifyEntry` (lstat-equivalent) per entry. A NotFound dir read
        // recovers to a sentinel so we can still push the "read_error" skip.
        const entries = yield* fs.readDirectory(state.currentPath).pipe(
            Effect.map((names) => names as readonly string[] | null),
            orAbsent(null as readonly string[] | null),
        );
        if (entries === null) {
            state.skipped.push(skip(state.root, state.currentPath, "read_error"));
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(state.currentPath, entry);
            const entryType = yield* classifyEntry(fullPath);

            if (entryType === "SymbolicLink") {
                state.skipped.push(skip(state.root, fullPath, "symlink"));
                continue;
            }

            if (entryType === "Directory") {
                if (shouldIgnoreDirectory(fullPath, entry)) {
                    state.skipped.push(skip(state.root, fullPath, "ignored_dir"));
                    continue;
                }
                if (yield* isNestedGitRepo(fullPath, state.rootPath)) {
                    state.skipped.push(skip(state.root, fullPath, "nested_git_repo"));
                    continue;
                }
                yield* walkArtifactRoot({ ...state, currentPath: fullPath });
                continue;
            }

            if (entryType !== "File") continue;

            const artifactKind = classifyArtifactPath(fullPath, state.root.kind);
            if (!artifactKind) {
                state.skipped.push(skip(state.root, fullPath, "unsupported_extension"));
                continue;
            }

            // OLD: `lstat(fullPath)` in try/catch → "read_error". The entry is a
            // confirmed non-symlink regular file at this point, so a following
            // `fs.stat` matches the old lstat result for size.
            const size = yield* fs.stat(fullPath).pipe(
                Effect.map((info) => Number(info.size)),
                orAbsent(undefined as number | undefined),
            );
            if (size === undefined) {
                state.skipped.push(skip(state.root, fullPath, "read_error"));
                continue;
            }

            if (size > state.maxFileBytes) {
                state.skipped.push(skip(state.root, fullPath, "too_large", size));
                continue;
            }

            if (yield* looksBinary(fullPath)) {
                state.skipped.push(skip(state.root, fullPath, "binary", size));
                continue;
            }

            state.candidates.push({
                path: fullPath,
                relativePath: relativeSlash(state.root.path, fullPath),
                rootKind: state.root.kind,
                artifactKind,
                bytes: size,
            });
        }
    });

function shouldIgnoreDirectory(path: string, name: string): boolean {
    if (IGNORED_DIR_NAMES.has(name)) return true;
    return path.split(posixPath.sep).includes(".claude") && name === "worktrees";
}

/**
 * Probe for a nested git repo: does `<path>/.git` exist as a real directory
 * (normal repo) or a real file (worktree/submodule gitfile)?
 *
 * OLD: `lstat(join(path, ".git"))` then `.isDirectory() || .isFile()`. `lstat`
 * does NOT follow symlinks, so a `.git` that is itself a symlink reported as a
 * symlink (neither dir nor file) ⇒ returned `false`. We preserve that exactly:
 * `classifyEntry` reports a `.git` symlink as "SymbolicLink", which is neither
 * "Directory" nor "File" ⇒ false.
 */
const isNestedGitRepo = (
    dirPath: string,
    rootPath: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        if (posixPath.resolve(dirPath) === posixPath.resolve(rootPath)) return false;
        const path = yield* Path.Path;
        const gitPath = path.join(dirPath, ".git");
        const entryType = yield* classifyEntry(gitPath);
        return entryType === "Directory" || entryType === "File";
    });

const looksBinary = (
    path: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // OLD: `readFile(path)` in try/catch → false on any fault; then check the
        // first TEXT_SAMPLE_BYTES for a NUL byte. orAbsent(null) recovers any
        // read fault to "not binary".
        const sample = yield* fs.readFile(path).pipe(orAbsent(null as Uint8Array | null));
        if (sample === null) return false;
        const capped = sample.subarray(0, TEXT_SAMPLE_BYTES);
        return capped.includes(0);
    });

function extensionOf(path: string): string {
    const name = posixPath.basename(path);
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
        const key = `${root.kind}:${posixPath.resolve(root.path)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...root, path: posixPath.resolve(root.path) });
    }
    return out;
}

function compareByPath(a: { readonly path: string }, b: { readonly path: string }): number {
    return a.path.localeCompare(b.path);
}

function relativeSlash(from: string, to: string): string {
    const rel = posixPath.relative(from, to);
    return rel === "" ? "." : rel.split(posixPath.sep).join("/");
}
