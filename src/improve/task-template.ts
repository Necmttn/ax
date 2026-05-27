/**
 * Render a self-contained `.ax/tasks/<shortId>.md` brief that the user's
 * primary agent can act on. v0 covers guidance + skill forms; subagent /
 * hook / automation are stubs that throw until their phase lands.
 */

export type TaskForm = "guidance" | "skill" | "subagent" | "hook" | "automation";

export interface TaskInput {
    readonly form: TaskForm;
    readonly experimentId: string;
    readonly proposalId: string;
    readonly shortId: string;
    readonly title: string;
    readonly targetPath: string;
    readonly section: string | null;
    readonly suggestedBody: string;
    readonly proposedBehavior: string | null;
    readonly confidence: string;
    readonly frequency: number;
    readonly evidence: string;
}

const guidance = (i: TaskInput): string => `# ax task: ${i.shortId} (form=guidance)

**Action:** insert guidance block
**Target:** \`${i.targetPath}\`${i.section ? ` → \`## ${i.section}\`` : ""}
**Marker:** \`<!--ax:${i.shortId}-->...<!--/ax:${i.shortId}-->\`

## Why
${i.evidence}.
Proposal: ${i.proposalId}
Experiment: ${i.experimentId}
Confidence: ${i.confidence}. Frequency: ${i.frequency}/wk.

## Apply
1. Open \`${i.targetPath}\`.${i.section ? ` Locate \`## ${i.section}\`. If the section does not exist, create it near related content.` : ""}
2. Insert the marker block below. You may reword the body but keep the
   \`<!--ax:${i.shortId}-->\` and \`<!--/ax:${i.shortId}-->\` tags untouched.
3. Run \`axctl improve lint ${i.targetPath}\`. Resolve any warnings.
4. Commit. This task file is removed automatically by \`axctl improve lint\`
   once it sees the marker land in the target.

## Suggested block

\`\`\`md
<!--ax:${i.shortId}-->
${i.suggestedBody}
<!--/ax:${i.shortId}-->
\`\`\`

## References
- proposal: ${i.proposalId}
- experiment: ${i.experimentId}
- evidence-cmd: \`axctl improve show ${i.shortId}\`
`;

const skill = (i: TaskInput): string => {
    const body = (i.proposedBehavior ?? i.suggestedBody).trim();
    return `# ax task: ${i.shortId} (form=skill)

**Action:** create skill file
**Target:** \`${i.targetPath}\`
**Provenance:** YAML frontmatter \`ax_id: ${i.shortId}\`

## Why
${i.evidence}.
Proposal: ${i.proposalId}
Experiment: ${i.experimentId}
Confidence: ${i.confidence}. Frequency: ${i.frequency}/wk.

## Apply
1. Create \`${i.targetPath}\`. The frontmatter MUST contain \`ax_id\` and
   \`ax_experiment\` exactly as shown below - \`axctl improve lint\` keys
   off them to reconcile the experiment.
2. Edit the body freely; the trigger pattern and behavior below are a
   starting point.
3. Run \`axctl improve lint\`. The task file is removed automatically
   once the lint pass sees the frontmatter.

## Suggested content

\`\`\`md
---
name: ${i.title}
description: ${i.title}
ax_id: ${i.shortId}
ax_experiment: ${i.experimentId}
---

# ${i.title}

${body}
\`\`\`

## References
- proposal: ${i.proposalId}
- experiment: ${i.experimentId}
- evidence-cmd: \`axctl improve show ${i.shortId}\`
`;
};

export const renderTaskFile = (input: TaskInput): string => {
    switch (input.form) {
        case "guidance":
            return guidance(input);
        case "skill":
            return skill(input);
        case "subagent":
        case "hook":
        case "automation":
            throw new Error(`task template for form=${input.form} not yet implemented (v1+)`);
    }
};
