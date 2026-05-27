/**
 * Lint walker for grounded agent files. v0 discovers:
 *   - <root>/AGENTS.md, <root>/CLAUDE.md       → form=guidance
 *   - <root>/skills/<slug>/SKILL.md            → form=skill
 *   - <root>/agents/<slug>.md                  → form=subagent  (v1 reads only)
 *
 * The default roots are `process.cwd()` (walking up to the git root) and
 * `~/.claude`. Override via `discoverFiles({ roots: [...] })`.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LintForm = "guidance" | "skill" | "subagent";

export interface LintTarget {
    readonly path: string;
    readonly form: LintForm;
}

export interface DiscoverOptions {
    readonly roots?: ReadonlyArray<string>;
}

const tryAddFile = (out: LintTarget[], path: string, form: LintForm): void => {
    if (existsSync(path)) out.push({ path, form });
};

const walkSkillsDir = (out: LintTarget[], skillsDir: string): void => {
    if (!existsSync(skillsDir)) return;
    for (const entry of readdirSync(skillsDir)) {
        const full = join(skillsDir, entry);
        try {
            if (!statSync(full).isDirectory()) continue;
        } catch { continue; }
        tryAddFile(out, join(full, "SKILL.md"), "skill");
    }
};

const walkAgentsDir = (out: LintTarget[], agentsDir: string): void => {
    if (!existsSync(agentsDir)) return;
    for (const entry of readdirSync(agentsDir)) {
        if (!entry.endsWith(".md")) continue;
        tryAddFile(out, join(agentsDir, entry), "subagent");
    }
};

export const defaultRoots = (): string[] => [
    process.cwd(),
    join(homedir(), ".claude"),
];

export const discoverFiles = (opts: DiscoverOptions = {}): LintTarget[] => {
    const roots = opts.roots ?? defaultRoots();
    const out: LintTarget[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
        for (const name of ["CLAUDE.md", "AGENTS.md"]) {
            tryAddFile(out, join(root, name), "guidance");
        }
        walkSkillsDir(out, join(root, "skills"));
        walkAgentsDir(out, join(root, "agents"));
    }
    return out.filter((t) => {
        if (seen.has(t.path)) return false;
        seen.add(t.path);
        return true;
    });
};
