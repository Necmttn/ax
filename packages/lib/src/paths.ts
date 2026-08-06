import { homedir } from "node:os";
import { posixPath } from "@ax/lib/shared/path";

export const HOME = homedir();
export const TRANSCRIPTS_DIR =
    process.env.AX_TRANSCRIPTS_DIR ?? posixPath.join(HOME, ".claude", "projects");

export const SKILL_DIRS = (process.env.AX_SKILLS_DIRS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Returns the parsed list of skill dirs from AX_SKILLS_DIRS, re-read at call
 * time so tests can override the env var after module load.
 */
function liveSkillDirList(): string[] {
    return (process.env.AX_SKILLS_DIRS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Returns true when AX_SKILLS_DIRS is set and non-empty, indicating that the
 * env var fully overrides skill discovery (plugin + project dirs are skipped).
 * Re-read at call time so tests can override the env var after module load.
 */
export const skillDirsOverridden = (): boolean => liveSkillDirList().length > 0;

/**
 * OpenCode's own skill folders (#746).
 *
 * OpenCode discovers skills from two places: the shared `~/.claude/skills` +
 * `~/.agents/skills` dirs (already covered above) AND its own config dir, where
 * it globs `{skill,skills}/**` + `/SKILL.md`. An OpenCode-only user keeps every
 * skill in the latter, so ax saw an empty catalog - `ax skills weighted` said
 * "no skill invocations found" and `ax skills stats <name>` said "missing".
 *
 * The config dir follows XDG (`$XDG_CONFIG_HOME`, else `~/.config`), matching
 * how OpenCode itself resolves it, so a non-default XDG home is honored rather
 * than silently missed.
 */
export function opencodeSkillDirs(): { dir: string; scope: string }[] {
    const configHome = process.env.XDG_CONFIG_HOME?.trim() || posixPath.join(HOME, ".config");
    const base = posixPath.join(configHome, "opencode");
    // Both spellings: OpenCode accepts `skill/` and `skills/`.
    return [
        { dir: posixPath.join(base, "skills"), scope: "opencode" },
        { dir: posixPath.join(base, "skill"), scope: "opencode" },
    ];
}

export function defaultSkillDirs(): { dir: string; scope: string }[] {
    // Re-read at call time so tests can override AX_SKILLS_DIRS after module load.
    const fromEnv = liveSkillDirList().map((dir) => ({ dir, scope: "user" }));
    if (fromEnv.length > 0) return fromEnv;
    return [
        { dir: posixPath.join(HOME, ".claude", "skills"), scope: "user" },
        { dir: posixPath.join(HOME, ".agents", "skills"), scope: "agents-shared" },
        ...opencodeSkillDirs(),
    ];
}
