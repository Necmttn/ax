/**
 * Pure render function for classify-brief task files.
 * No I/O, no Effect - purely transforms inputs to markdown string.
 */

export interface ClassifyBriefInput {
    readonly skillName: string;
    readonly invocations: number;
    readonly sessions: number;
}

/**
 * Convert a skill name to a file-system safe slug for the task file.
 * Rules:
 *   - `:` → `__`
 *   - any remaining non-`[a-zA-Z0-9_-]` → `-`
 */
export function skillNameToSlug(name: string): string {
    return name
        .replace(/:/g, "__")
        .replace(/[^a-zA-Z0-9_\-]/g, "-");
}

export function renderClassifyBrief(input: ClassifyBriefInput): string {
    const { skillName, invocations, sessions } = input;
    return `---
ax_classify: ${skillName}
primary_role:           # required, single string
secondary: []           # optional, list of strings
confidence: 1.0         # optional, float 0-1, defaults to 1.0
rationale: |            # optional, free-form text
  Explain why you picked these roles.
---

# ax classify: ${skillName}

**Action:** classify skill's primary + secondary roles for \`ax skills weighted\` (P3.6)
**Target:** edit this file, fill the frontmatter at the top, then run \`axctl skills lint\`
**Provenance:** YAML frontmatter \`ax_classify: ${skillName}\`

## Why
Skill \`${skillName}\` has ${invocations} invocations across ${sessions} sessions but no role
classification. Weighted skill ranking treats unclassified skills as
neutral (weight 1.0). Tag it once and \`ax skills weighted\` factors role
into its score.

## How to investigate
Run these to understand the skill's actual use before deciding:

- \`axctl skills stats ${skillName}\` - usage stats
- \`axctl skills recent ${skillName} --limit=10\` - recent invocations
- \`axctl recall <query> --skill=${skillName} --limit=5 --json\` - usage in turn text
- \`axctl sessions show <session-id>\` - drill into one or two recent sessions where the skill fired

Or: \`axctl skills tag ${skillName} <role>\` for a one-line override.

## Decide
Fill the YAML frontmatter at the top of this file. Valid \`primary_role\`
values are anything you choose - common ones: framing, execution,
execution-mode, producer, verification, repair. Add as many \`secondary\`
roles as you like (or none).

When done:

  axctl skills lint

…will read this file, upsert \`plays_role\` edges with \`source="brief"\`,
and remove this task file.
`;
}
