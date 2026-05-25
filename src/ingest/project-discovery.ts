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
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export interface ProjectRoot {
    /** Namespace used when re-naming a project skill / command. The repo's
     *  directory basename (`ax`, `myapp`, `expo-tailwind-app`, ...). */
    readonly name: string;
    /** Absolute path of the repo on disk. */
    readonly path: string;
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

const isDir = async (path: string): Promise<boolean> => {
    try {
        const st = await stat(path);
        return st.isDirectory();
    } catch {
        return false;
    }
};

const naiveDecode = (slug: string): string | null => {
    if (!slug.startsWith("-")) return null;
    return slug.replace(/-/g, "/");
};

/** Read the first ~16KB of any JSONL in the slug dir and pluck `cwd`. */
const peekFirstCwd = async (slugDir: string): Promise<string | null> => {
    let entries: string[];
    try {
        entries = await readdir(slugDir);
    } catch {
        return null;
    }
    const jsonl = entries.find((entry) => entry.endsWith(".jsonl"));
    if (!jsonl) return null;
    try {
        // Slice the file to 16KB so we don't drag in megabytes of turns just
        // to read the cwd, which lives in the first session-meta line.
        const head = await Bun.file(join(slugDir, jsonl)).slice(0, 16384).text();
        const m = head.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (!m) return null;
        return m[1] ?? null;
    } catch {
        return null;
    }
};

export async function discoverProjectRoots(): Promise<ProjectRoot[]> {
    let slugs: string[];
    try {
        slugs = await readdir(PROJECTS_DIR);
    } catch {
        return [];
    }

    const roots: ProjectRoot[] = [];
    const seen = new Set<string>();

    for (const slug of slugs) {
        const slugDir = join(PROJECTS_DIR, slug);
        let path = naiveDecode(slug);
        if (!path || !(await isDir(path))) {
            const peeked = await peekFirstCwd(slugDir);
            path = peeked && (await isDir(peeked)) ? peeked : null;
        }
        if (!path || seen.has(path)) continue;
        seen.add(path);
        roots.push({ name: basename(path), path });
    }
    return roots;
}
