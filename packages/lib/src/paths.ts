import { homedir } from "node:os";
import { posixPath } from "@ax/lib/shared/path";

export const HOME = homedir();
export const TRANSCRIPTS_DIR =
    process.env.AX_TRANSCRIPTS_DIR ?? posixPath.join(HOME, ".claude", "projects");

export const SKILL_DIRS = (process.env.AX_SKILLS_DIRS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function defaultSkillDirs(): { dir: string; scope: string }[] {
    // Re-read at call time so tests can override AX_SKILLS_DIRS after module load.
    const liveSkillDirs = (process.env.AX_SKILLS_DIRS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const fromEnv = liveSkillDirs.map((dir) => ({ dir, scope: "user" }));
    if (fromEnv.length > 0) return fromEnv;
    return [
        { dir: posixPath.join(HOME, ".claude", "skills"), scope: "user" },
        { dir: posixPath.join(HOME, ".agents", "skills"), scope: "agents-shared" },
    ];
}
