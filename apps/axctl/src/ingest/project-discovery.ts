/**
 * Discover project repo roots from `~/.claude/projects/` so per-project
 * `.claude/skills/` and `.claude/commands/` can join the catalog.
 *
 * Claude Code stores transcripts at `~/.claude/projects/<slug>/*.jsonl` where
 * the slug is the cwd with `/` replaced by `-` (e.g. `/Users/me/Projects/ax`
 * -> `-Users-me-Projects-ax`). The slug is ambiguous when a path segment
 * contains a literal hyphen (e.g. `expo-tailwind-app`) - naive
 * `'-'` -> `'/'` decoding picks the wrong path. We start naive, then fall
 * back to peeking the first JSONL line's `cwd` field for the authoritative
 * answer.
 */
import { homedir } from "node:os";
import { Effect, FileSystem, Path } from "effect";
import { posixPath } from "@ax/lib/shared/path";
import { orAbsent } from "@ax/lib/shared/fs-error";

export interface ProjectRoot {
    /** Namespace used when re-naming a project skill / command. The repo's
     *  directory basename (`ax`, `myapp`, `expo-tailwind-app`, ...). */
    readonly name: string;
    /** Absolute path of the repo on disk. */
    readonly path: string;
}

const PROJECTS_DIR = posixPath.join(homedir(), ".claude", "projects");

// OLD: stat(path) in try/catch → false on ANY error. A non-existent or
// unreadable path is simply "not a usable dir", so recover ANY PlatformError
// to false - orAbsent.
const isDir = (
    candidate: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.stat(candidate).pipe(
            Effect.map((st) => st.type === "Directory"),
            orAbsent(false),
        );
    });

const naiveDecode = (slug: string): string | null => {
    if (!slug.startsWith("-")) return null;
    return slug.replace(/-/g, "/");
};

/** Read the first ~16KB of any JSONL in the slug dir and pluck `cwd`. */
const peekFirstCwd = (
    slugDir: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // OLD: readdir(slugDir) in try/catch → null. An unreadable slug dir
        // yields no peekable cwd, so recover ANY PlatformError to [] then bail.
        const entries = yield* fs
            .readDirectory(slugDir)
            .pipe(orAbsent([] as string[]));
        const jsonl = entries.find((entry) => entry.endsWith(".jsonl"));
        if (!jsonl) return null;
        // OLD: Bun.file(...).slice(0, 16KB).text() in try/catch → null. This is
        // a PARTIAL read (cwd lives in the first session-meta line) with no
        // FileSystem equivalent, so it stays a Bun read; any fault → null,
        // matching the old tolerate-all catch.
        return yield* Effect.promise(async () => {
            try {
                const head = await Bun.file(path.join(slugDir, jsonl))
                    .slice(0, 16384)
                    .text();
                const m = head.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/);
                if (!m) return null;
                return m[1] ?? null;
            } catch {
                return null;
            }
        });
    });

export const discoverProjectRoots = (): Effect.Effect<
    ProjectRoot[],
    never,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // OLD: readdir(PROJECTS_DIR) in try/catch → []. A missing projects dir
        // just means no projects, so recover ANY PlatformError to [] - orAbsent.
        const slugs = yield* fs
            .readDirectory(PROJECTS_DIR)
            .pipe(orAbsent([] as string[]));

        const roots: ProjectRoot[] = [];
        const seen = new Set<string>();

        for (const slug of slugs) {
            const slugDir = path.join(PROJECTS_DIR, slug);
            let resolved = naiveDecode(slug);
            if (!resolved || !(yield* isDir(resolved))) {
                const peeked = yield* peekFirstCwd(slugDir);
                resolved = peeked && (yield* isDir(peeked)) ? peeked : null;
            }
            if (!resolved || seen.has(resolved)) continue;
            seen.add(resolved);
            roots.push({ name: path.basename(resolved), path: resolved });
        }
        return roots;
    });
