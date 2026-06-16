/**
 * ax dojo skill-spar - brief format for skill-edit spar runs.
 *
 * Mirrors the code-delta spar (spar.ts) but benchmarks a SKILL.md edit
 * instead of a code delta. Two arms share the same parent SHA: Arm A runs
 * with the original skill, Arm B runs with the edited skill active (global
 * swap during Arm B only, restored immediately after).
 */

// ---------------------------------------------------------------------------
// Helpers (mirrors of spar.ts module-private helpers)
// ---------------------------------------------------------------------------

/** Collapse CR/LF to a space so an interpolated value can't break its line. */
const oneLine = (v: string): string => v.replace(/[\r\n]/g, " ");

/** Mirror of spar.ts frontmatter field reader. */
const field = (content: string, key: string): string | null => {
    const m = new RegExp(`^${key}:[^\\S\\n]*(.*)$`, "m").exec(content);
    const v = m?.[1]?.trim();
    return v && v.length > 0 ? v : null;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillSparBrief {
    id: string;
    createdAt: string;
    skill: string;
    skillDir: string;
    originalHash: string;
    parentSha: string;
    baselineSession: string;
    worktreeA: string;
    worktreeB: string;
    task: string;
    originalSkill: string;
    /** filled by the agent; "" when unfilled */
    editedSkill: string;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Placeholder text in the ## Edited skill block until the agent fills it in. */
const EDITED_PLACEHOLDER = "FILL: paste the edited SKILL.md here";

/**
 * Render a SkillSparBrief to a markdown doc.
 *
 * @param opts.worktreeAAbs  Absolute path for the Arm A worktree command (falls back to worktreeA).
 * @param opts.worktreeBAbs  Absolute path for the Arm B worktree command (falls back to worktreeB).
 * @param opts.snapshotPathAbs  Absolute path where the original SKILL.md snapshot is stored.
 *   The edited-skill path is derived by replacing "snapshot" with "edited" in this path.
 *   Falls back to "(snapshot path)" / "(edited-skill-path)" when not provided.
 */
export const renderSkillSparBrief = (
    brief: SkillSparBrief,
    opts?: { worktreeAAbs?: string; worktreeBAbs?: string; snapshotPathAbs?: string },
): string => {
    const worktreeAPath = opts?.worktreeAAbs ?? brief.worktreeA;
    const worktreeBPath = opts?.worktreeBAbs ?? brief.worktreeB;
    const snapshotPath = opts?.snapshotPathAbs ?? "(snapshot path)";
    const editedPath = opts?.snapshotPathAbs
        ? opts.snapshotPathAbs.replace("snapshot", "edited")
        : "(edited-skill-path)";
    const editedContent = brief.editedSkill.trim().length > 0 ? brief.editedSkill : EDITED_PLACEHOLDER;

    return [
        "---",
        `id: ${oneLine(brief.id)}`,
        `created_at: ${oneLine(brief.createdAt)}`,
        `kind: skill`,
        `skill: ${oneLine(brief.skill)}`,
        `skill_dir: ${oneLine(brief.skillDir)}`,
        `original_hash: ${oneLine(brief.originalHash)}`,
        `parent_sha: ${oneLine(brief.parentSha)}`,
        `baseline_session: ${oneLine(brief.baselineSession)}`,
        `worktree_a: ${oneLine(brief.worktreeA)}`,
        `worktree_b: ${oneLine(brief.worktreeB)}`,
        "---",
        "",
        `# Skill spar: ${brief.id}`,
        "",
        "## Task",
        "",
        brief.task,
        "",
        "## Worktrees",
        "",
        "```bash",
        `git worktree add ${worktreeAPath} -b dojo/spar-${brief.id}-a ${brief.parentSha}`,
        `git worktree add ${worktreeBPath} -b dojo/spar-${brief.id}-b ${brief.parentSha}`,
        "```",
        "",
        "## Original skill (snapshot)",
        "",
        "```skill-snapshot",
        brief.originalSkill,
        "```",
        "",
        `Snapshot path: ${snapshotPath}`,
        "",
        "## Swap commands",
        "",
        "```bash",
        `# swap-in (activate edited skill for Arm B)`,
        `cp ${editedPath} ${brief.skillDir}/SKILL.md`,
        `# swap-out (restore original after Arm B completes)`,
        `cp ${snapshotPath} ${brief.skillDir}/SKILL.md`,
        "```",
        "",
        "## Edited skill",
        "",
        "```skill-edit",
        editedContent,
        "```",
        "",
        "## How to run",
        "",
        `1. Pin both worktrees (see Worktrees above).`,
        `2. **Arm A** - run the task in \`${brief.worktreeA}\` with the original skill (no swap needed).`,
        `3. **Swap in** - \`cp ${editedPath} ${brief.skillDir}/SKILL.md\``,
        `4. **Arm B** - run the task in \`${brief.worktreeB}\` with the edited skill active.`,
        `5. **Swap out** - \`cp ${snapshotPath} ${brief.skillDir}/SKILL.md\``,
        `6. Score: \`ax dojo spar-score ${brief.id}\``,
        "",
        "> **Concurrency caveat**: do not run other Claude sessions while the swap is active - the skill swap is global.",
        "",
    ].join("\n");
};

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Unique fence delimiters so skill content (which may contain ordinary code
 * fences) can never produce a false-positive match.
 */
const SNAPSHOT_BLOCK_RE = /```skill-snapshot\n([\s\S]*?)\n```/;
const EDITED_BLOCK_RE = /```skill-edit\n([\s\S]*?)\n```/;

/**
 * Extract the task text from between `## Task` and the next `## ` heading.
 * Uses double-newline boundaries rather than the `$` assertion to avoid
 * premature termination on the first blank line in multiline tasks.
 */
const extractTask = (content: string): string => {
    const m = /## Task\n\n([\s\S]*?)\n\n## /.exec(content);
    return m?.[1]?.trim() ?? "";
};

/**
 * Round-trip parser for a SkillSparBrief produced by renderSkillSparBrief.
 * Returns null if the content is not a skill-spar brief or any required field
 * is absent.
 */
export const parseSkillSparBrief = (content: string): SkillSparBrief | null => {
    if (!content.startsWith("---")) return null;

    const id = field(content, "id");
    const createdAt = field(content, "created_at");
    const skill = field(content, "skill");
    const skillDir = field(content, "skill_dir");
    const originalHash = field(content, "original_hash");
    const parentSha = field(content, "parent_sha");
    const baselineSession = field(content, "baseline_session");
    const worktreeA = field(content, "worktree_a");
    const worktreeB = field(content, "worktree_b");

    if (
        !id || !createdAt || !skill || !skillDir || !originalHash ||
        !parentSha || !baselineSession || !worktreeA || !worktreeB
    ) {
        return null;
    }

    const task = extractTask(content);

    const snapshotMatch = SNAPSHOT_BLOCK_RE.exec(content);
    if (!snapshotMatch?.[1]) return null;
    const originalSkill = snapshotMatch[1];

    const editedMatch = EDITED_BLOCK_RE.exec(content);
    if (!editedMatch?.[1]) return null;
    const editedSkillRaw = editedMatch[1];
    const editedSkill = editedSkillRaw === EDITED_PLACEHOLDER ? "" : editedSkillRaw;

    return {
        id,
        createdAt,
        skill,
        skillDir,
        originalHash,
        parentSha,
        baselineSession,
        worktreeA,
        worktreeB,
        task,
        originalSkill,
        editedSkill,
    };
};

// ---------------------------------------------------------------------------
// Discriminator
// ---------------------------------------------------------------------------

/**
 * True iff the frontmatter has `kind: skill`.
 * Used to distinguish skill-spar briefs from code-delta spar briefs (which
 * have no `kind:` line).
 */
export const isSkillSparBrief = (content: string): boolean => {
    if (!content.startsWith("---")) return false;
    return field(content, "kind") === "skill";
};
