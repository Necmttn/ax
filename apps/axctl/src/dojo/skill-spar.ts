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

/** Frontmatter field reader (same shape as spar.ts's helper, originally from outbox.ts). */
const field = (content: string, key: string): string | null => {
    const m = new RegExp(`^${key}:[^\\S\\n]*(.*)$`, "m").exec(content);
    const v = m?.[1]?.trim();
    return v && v.length > 0 ? v : null;
};

/** Shell-quote a path for embedding in a rendered command line (paths may contain spaces). */
const sh = (p: string): string => `"${p}"`;

/** Length of the longest consecutive backtick run inside a string (0 if none). */
const longestBacktickRun = (s: string): number => {
    let max = 0;
    const runs = s.match(/`+/g);
    if (runs) for (const run of runs) max = Math.max(max, run.length);
    return max;
};

/**
 * Render a fenced block whose fence is one backtick longer than the longest
 * backtick run inside the content (GFM nesting rule). This lets the content
 * carry its own ```bash / ```ts code fences without truncating the block.
 */
const renderFence = (info: string, content: string): string[] => {
    const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
    return [`${fence}${info}`, content, fence];
};

/**
 * Match a fenced block by info string, honoring a variable-length fence: the
 * opening fence's backtick count is captured and the closing line must be
 * exactly that many backticks. Returns the inner content, or null.
 */
const parseFence = (content: string, info: string): string | null => {
    const re = new RegExp("(`{3,})" + info + "\\n([\\s\\S]*?)\\n\\1(?=\\n|$)");
    const m = re.exec(content);
    return m?.[2] ?? null;
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
 * @param opts.snapshotPathAbs  Absolute path where the original SKILL.md snapshot is stored
 *   (swap-out restores from here). Falls back to "(snapshot path)".
 * @param opts.editedPathAbs  Absolute path of the file holding the edited SKILL.md
 *   (swap-in copies from here). MUST differ from snapshotPathAbs. Falls back to "(edited skill path)".
 */
export const renderSkillSparBrief = (
    brief: SkillSparBrief,
    opts?: {
        worktreeAAbs?: string;
        worktreeBAbs?: string;
        snapshotPathAbs?: string;
        editedPathAbs?: string;
    },
): string => {
    const worktreeAPath = opts?.worktreeAAbs ?? brief.worktreeA;
    const worktreeBPath = opts?.worktreeBAbs ?? brief.worktreeB;
    const snapshotPath = opts?.snapshotPathAbs ?? "(snapshot path)";
    const editedPath = opts?.editedPathAbs ?? "(edited skill path)";
    const skillTarget = `${brief.skillDir}/SKILL.md`;
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
        `git worktree add ${sh(worktreeAPath)} -b dojo/spar-${brief.id}-a ${brief.parentSha}`,
        `git worktree add ${sh(worktreeBPath)} -b dojo/spar-${brief.id}-b ${brief.parentSha}`,
        "```",
        "",
        "## Original skill (snapshot)",
        "",
        ...renderFence("skill-snapshot", brief.originalSkill),
        "",
        `Snapshot path: ${snapshotPath}`,
        "",
        "## Swap commands",
        "",
        "```bash",
        `# swap-in (activate edited skill for Arm B)`,
        `cp ${sh(editedPath)} ${sh(skillTarget)}`,
        `# swap-out (restore original after Arm B completes)`,
        `cp ${sh(snapshotPath)} ${sh(skillTarget)}`,
        "```",
        "",
        "## Edited skill",
        "",
        ...renderFence("skill-edit", editedContent),
        "",
        "## How to run",
        "",
        `1. Pin both worktrees (see Worktrees above).`,
        `2. **Arm A** - run the task in \`${brief.worktreeA}\` with the original skill (no swap needed).`,
        `3. **Swap in** - \`cp ${sh(editedPath)} ${sh(skillTarget)}\``,
        `4. **Arm B** - run the task in \`${brief.worktreeB}\` with the edited skill active.`,
        `5. **Swap out** - \`cp ${sh(snapshotPath)} ${sh(skillTarget)}\``,
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
 * Extract the task text from between `## Task` and the fixed-order `## Worktrees`
 * heading. Anchoring on the known next heading (rather than the first `\n\n## `)
 * lets the task body carry its own `## ` subheadings without truncation.
 */
const extractTask = (content: string): string => {
    const m = /## Task\n\n([\s\S]*?)\n\n## Worktrees/.exec(content);
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

    const originalSkill = parseFence(content, "skill-snapshot");
    if (originalSkill === null) return null;

    const editedSkillRaw = parseFence(content, "skill-edit");
    if (editedSkillRaw === null) return null;
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
