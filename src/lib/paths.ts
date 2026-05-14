import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const TRANSCRIPTS_DIR =
    process.env.AX_TRANSCRIPTS_DIR ?? process.env.AGENTCTL_TRANSCRIPTS_DIR ?? join(HOME, ".claude", "projects");

export const SKILL_DIRS = (process.env.AX_SKILLS_DIRS ?? process.env.AGENTCTL_SKILLS_DIRS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function defaultSkillDirs(): { dir: string; scope: string }[] {
    const fromEnv = SKILL_DIRS.map((dir) => ({ dir, scope: "user" }));
    if (fromEnv.length > 0) return fromEnv;
    return [
        { dir: join(HOME, ".claude", "skills"), scope: "user" },
        { dir: join(HOME, ".agents", "skills"), scope: "agents-shared" },
    ];
}
