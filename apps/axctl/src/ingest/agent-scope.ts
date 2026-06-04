/**
 * Agent skill-scoping: Claude Code subagent definition files
 * (`~/.claude/agents/<name>.md`) may declare a `skills:` frontmatter list.
 * Those skills load ONLY when that subagent is spawned - they are not part of
 * the main thread's global skill surface. ax ingests skills from disk and is
 * otherwise blind to this, so `ax skills unused` wrongly flags agent-scoped
 * skills as global dead weight. This module recovers the skill → agent(s)
 * mapping straight from the agent files (read-side, no DB round-trip).
 */
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { Effect, FileSystem, Path } from "effect";
import { posixPath } from "@ax/lib/shared/path";
import { orAbsent } from "@ax/lib/shared/fs-error";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/** Skill names declared in one agent file's `skills:` frontmatter list. Pure. */
export function skillsForAgent(content: string): string[] {
    const m = content.match(FRONTMATTER_RE);
    if (!m) return [];
    let fm: Record<string, unknown>;
    try {
        fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
    } catch {
        return [];
    }
    const raw = fm.skills;
    if (!Array.isArray(raw)) return [];
    return raw.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/** skill-name → sorted agent-names that scope it. Pure. */
export function buildScopeMap(
    agents: ReadonlyArray<{ name: string; content: string }>,
): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const a of agents) {
        for (const skill of skillsForAgent(a.content)) {
            const arr = map.get(skill) ?? [];
            if (!arr.includes(a.name)) arr.push(a.name);
            map.set(skill, arr);
        }
    }
    for (const arr of map.values()) arr.sort();
    return map;
}

/** Agent definition roots. `AX_AGENT_DIRS` (comma list) overrides for tests. */
export function defaultAgentDirs(): string[] {
    const fromEnv = (process.env.AX_AGENT_DIRS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (fromEnv.length > 0) return fromEnv;
    return [posixPath.join(homedir(), ".claude", "agents")];
}

/**
 * Read agent dirs from disk and build the skill → agent(s) scope map.
 * Missing dirs and unreadable files are skipped (a missing `~/.claude/agents`
 * just means no scoping), so the effect cannot fail.
 */
export const loadAgentScopeMap = (
    dirs: string[] = defaultAgentDirs(),
): Effect.Effect<Map<string, string[]>, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const agents: { name: string; content: string }[] = [];
        for (const dir of dirs) {
            // OLD: readdir(dir).catch(() => []) tolerated ANY error (a missing
            // `~/.claude/agents` just means no scoping), so recover ANY
            // PlatformError to [] - orAbsent, not skipNotFound.
            const entries = yield* fs.readDirectory(dir).pipe(orAbsent([] as string[]));
            for (const entry of entries) {
                if (!entry.endsWith(".md")) continue;
                // OLD: readFile(...).catch(() => null) tolerated ANY error
                // (unreadable files are skipped), so recover ANY PlatformError
                // to null - orAbsent.
                const content = yield* fs
                    .readFileString(path.join(dir, entry))
                    .pipe(orAbsent(null as string | null));
                if (content != null) {
                    agents.push({ name: entry.replace(/\.md$/, ""), content });
                }
            }
        }
        return buildScopeMap(agents);
    });
