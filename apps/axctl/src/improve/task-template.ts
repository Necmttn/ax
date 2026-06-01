/**
 * Render a self-contained `.ax/tasks/<shortId>.md` brief that the user's
 * primary agent can act on. Hook and automation forms are manual-only task
 * briefs; ax never edits user harness files directly for those forms.
 */

import type { InterventionSafetyContract } from "./lifecycle.ts";

export type TaskForm = "guidance" | "skill" | "harness_check" | "subagent" | "hook" | "automation";

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
    readonly safety?: InterventionSafetyContract | null;
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
3. Run \`axctl improve lint\`. Resolve any warnings.
   (If your edit is outside ~/.claude or this repo root, add \`--root <dir>\`.)
4. Commit. This task file is removed automatically by \`axctl improve lint\`
   once it sees the marker land in the target.

## Suggested block

Copy the lines BETWEEN the fences, NOT the fences themselves.

\`\`\`text
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

const harnessCheck = (i: TaskInput): string => `# ax task: ${i.shortId} (form=harness_check)

**Action:** add harness check
**Target:** \`${i.targetPath}\`
**Provenance:** YAML frontmatter \`ax_id: ${i.shortId}\`
**Title:** ${i.title}

## Why
${i.evidence}.
Proposal: ${i.proposalId}
Experiment: ${i.experimentId}
Confidence: ${i.confidence}. Frequency: ${i.frequency}/wk.

## Apply
1. Create or update the smallest executable check that proves this workflow
   expectation before changing guidance.
2. Preserve the proposal id, experiment id, and evidence refs in the test,
   fixture, or task notes. If you create a markdown harness artifact, include:
   \`ax_id: ${i.shortId}\` and \`ax_experiment: ${i.experimentId}\`.
3. Run the focused check and any nearby regression tests.
4. Run \`axctl improve lint\`. Resolve any warnings.

## Expected Check

${(i.proposedBehavior ?? i.suggestedBody).trim() || i.suggestedBody}

## References
- proposal: ${i.proposalId}
- experiment: ${i.experimentId}
- evidence-cmd: \`axctl improve show ${i.shortId}\`
`;

const subagent = (i: TaskInput): string => `# ax task: ${i.shortId} (form=subagent)

**Action:** create subagent prompt
**Target:** \`${i.targetPath}\`
**Provenance:** YAML frontmatter \`ax_id: ${i.shortId}\`

## Why
${i.evidence}.
Proposal: ${i.proposalId}
Experiment: ${i.experimentId}
Confidence: ${i.confidence}. Frequency: ${i.frequency}/wk.

## Apply
1. Create \`${i.targetPath}\` with the frontmatter below.
2. Edit the prompt body freely while preserving \`ax_id\` and \`ax_experiment\`.
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

${i.suggestedBody}
\`\`\`

## References
- proposal: ${i.proposalId}
- experiment: ${i.experimentId}
- evidence-cmd: \`axctl improve show ${i.shortId}\`
`;

const safetyLines = (i: TaskInput): string => {
    const safety = i.safety ?? {};
    return [
        `Recovery Path: ${safety.recoveryPath ?? "(missing)"}`,
        `Smoke Test: ${safety.smokeTestCommand ?? "(missing)"}`,
        `Disable Switch: ${safety.disableCommand ?? "(missing)"}`,
        `Failure Mode: ${safety.failureMode ?? "(missing)"}`,
    ].join("\n");
};

const hook = (i: TaskInput): string => `# ax task: ${i.shortId} (form=hook)

**Action:** add manual hook entry
**Target:** \`${i.targetPath}\`
**Marker:** command prefix \`echo 'ax:${i.shortId}'\`

## Why
${i.evidence}.
Proposal: ${i.proposalId}
Experiment: ${i.experimentId}
Confidence: ${i.confidence}. Frequency: ${i.frequency}/wk.

## Safety Contract
${safetyLines(i)}

## Apply
1. Open \`${i.targetPath}\`.
2. Add or update the hook entry below. The command MUST keep the
   \`echo 'ax:${i.shortId}'\` prefix so \`axctl improve lint\` can reconcile it.
3. Run the Smoke Test from the safety contract.
4. Run \`axctl improve lint\`. Resolve any warnings.

## Suggested hook entry

\`\`\`json
{
  "hooks": {
    "${i.section ?? "PreToolUse"}": [
      { "command": "echo 'ax:${i.shortId}' && ${i.suggestedBody}" }
    ]
  }
}
\`\`\`

## References
- proposal: ${i.proposalId}
- experiment: ${i.experimentId}
- evidence-cmd: \`axctl improve show ${i.shortId}\`
`;

const automation = (i: TaskInput): string => `# ax task: ${i.shortId} (form=automation)

**Action:** create manual automation artifact
**Target:** \`${i.targetPath}\`
**Marker:** \`ax:${i.shortId} experiment:${i.experimentId}\`

## Why
${i.evidence}.
Proposal: ${i.proposalId}
Experiment: ${i.experimentId}
Confidence: ${i.confidence}. Frequency: ${i.frequency}/wk.

## Safety Contract
${safetyLines(i)}

## Apply
1. Create the automation only after reviewing the action below.
2. Add one of the marker headers below to the artifact.
3. Run the Smoke Test from the safety contract.
4. Run \`axctl improve lint\`. Resolve any warnings.

## Suggested action

\`\`\`text
${i.suggestedBody}
\`\`\`

## Plist marker

\`\`\`xml
<!-- ax:${i.shortId} experiment:${i.experimentId} -->
\`\`\`

## Cron marker

\`\`\`cron
# ax:${i.shortId} experiment:${i.experimentId}
\`\`\`

## References
- proposal: ${i.proposalId}
- experiment: ${i.experimentId}
- evidence-cmd: \`axctl improve show ${i.shortId}\`
`;

export const renderTaskFile = (input: TaskInput): string => {
    switch (input.form) {
        case "guidance":
            return guidance(input);
        case "skill":
            return skill(input);
        case "harness_check":
            return harnessCheck(input);
        case "subagent":
            return subagent(input);
        case "hook":
            return hook(input);
        case "automation":
            return automation(input);
    }
};
