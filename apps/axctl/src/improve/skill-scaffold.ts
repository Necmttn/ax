/**
 * Skill scaffolding for `axctl improve accept` (Phase C3).
 *
 * Writes a SKILL.md stub to ~/.claude/skills/<kebab-name>/ from a proposal's
 * hypothesis + proposed_behavior. The scaffold-on-accept design fixes the
 * manual-step-dropout problem flagged in adversarial review: without it,
 * "accept" + "write the skill yourself" + "remember to invoke it" is a
 * 3-step chain across days with ~15% completion, dominating verdict signal
 * with user dropout instead of artifact efficacy.
 *
 * Idempotent + non-clobbering: if the target file already exists, refuse
 * unless `force=true`. The caller (CLI handler) decides whether to surface
 * the existing path or error.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ScaffoldInput {
    readonly title: string;
    readonly hypothesis: string;
    readonly proposedBehavior: string;
    readonly triggerPattern?: string | null;
    readonly expectedImpact?: string | null;
    readonly dedupeSig: string;
    readonly nowIso: string;
}

export interface ScaffoldResult {
    readonly path: string;
    readonly dir: string;
    readonly created: boolean;
    readonly skipped: boolean;
}

export const kebabCase = (raw: string): string =>
    raw
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-+|-+$)/g, "")
        .slice(0, 60);

export const defaultSkillBaseDir = (): string =>
    process.env.AX_SKILLS_SCAFFOLD_DIR ?? join(homedir(), ".claude", "skills");

export const skillScaffoldDir = (name: string, baseDir = defaultSkillBaseDir()): string =>
    join(baseDir, kebabCase(name));

export const skillScaffoldFile = (name: string, baseDir = defaultSkillBaseDir()): string =>
    join(skillScaffoldDir(name, baseDir), "SKILL.md");

export const scaffoldContent = (input: ScaffoldInput): string => {
    const nameKebab = kebabCase(input.title);
    const description = input.hypothesis.trim().replaceAll("\n", " ");
    const trigger = input.triggerPattern?.trim();
    const impact = input.expectedImpact?.trim();
    return `---
name: ${nameKebab}
description: ${description}
---

# ${input.title}

${input.proposedBehavior.trim()}

${trigger ? `## When to apply\n\n${trigger}\n\n` : ""}${impact ? `## Expected impact\n\n${impact}\n\n` : ""}---

<!-- Scaffolded by ax from proposal ${input.dedupeSig} on ${input.nowIso}. -->
<!-- Edit freely. Removing this file leaves the experiment in the DB; -->
<!-- run \`axctl improve verdict ${input.dedupeSig}\` once you've seen real usage. -->
`;
};

export interface ScaffoldOptions {
    readonly input: ScaffoldInput;
    readonly baseDir?: string;
    readonly force?: boolean;
}

export const scaffoldSkill = (opts: ScaffoldOptions): ScaffoldResult => {
    const dir = skillScaffoldDir(opts.input.title, opts.baseDir);
    const path = join(dir, "SKILL.md");
    if (existsSync(path) && !opts.force) {
        return { path, dir, created: false, skipped: true };
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, scaffoldContent(opts.input), { encoding: "utf-8" });
    return { path, dir, created: true, skipped: false };
};
