/**
 * Pure renderer for `ax directives workflows --emit-brief` task files.
 * No I/O, no Effect - transforms inputs to markdown string only.
 * Modeled on renderDirectivesBrief (cli/directives-brief-template.ts).
 */

import type { ArcCandidate } from "../queries/workflow-sequences.ts";

export type { ArcCandidate };

export interface WorkflowsBriefOpts {
    readonly date: string;
    readonly days: number;
}

/**
 * Render a `.ax/tasks/workflows-<date>.md` brief for agent review.
 *
 * For each arc the agent must decide:
 *   - is_workflow: true/false  (is this a genuine recurring workflow worth a skill?)
 *   - skill_name: proposed name if yes
 *   - landing: skill | guidance | memory  (where it should be codified)
 *   - rationale: why
 *
 * Accepted candidates can be codified via `ax improve accept` (guidance-form proposal)
 * or by creating a new skill (skill-form proposal, see ax directives workflows docs).
 */
export const renderWorkflowsBrief = (
    arcs: ReadonlyArray<ArcCandidate>,
    opts: WorkflowsBriefOpts,
): string => {
    const { date, days } = opts;
    const lines: string[] = [
        `# workflows brief - ${date}`,
        "",
        `Recurring skill-arc candidates mined from the last ${days} days of sessions.`,
        "Each entry is an ordered sequence of skills that co-occurred across ≥ 3 sessions.",
        "",
        "## Your task (agent)",
        "",
        "For each arc below, judge whether it represents a genuine reusable workflow",
        "(a repeatable sequence of steps worth codifying as a skill or guidance entry)",
        "vs. incidental co-occurrence. Is this a workflow worth codifying as a skill?",
        "Name it if yes. Then fill in the decision block for each arc.",
        "",
    ];

    if (arcs.length === 0) {
        lines.push(`(no workflow arc candidates found in the last ${days} days)`);
        lines.push("");
        return lines.join("\n");
    }

    lines.push("## Arc Candidates", "");
    lines.push(
        `| # | steps | support |`,
        `|---|---|---|`,
    );
    for (let i = 0; i < arcs.length; i++) {
        const arc = arcs[i]!;
        lines.push(
            `| ${i + 1} | ${arc.steps.join(" → ")} | ${arc.support} |`,
        );
    }

    lines.push("", "### Arc details + decision blocks", "");
    for (let i = 0; i < arcs.length; i++) {
        const arc = arcs[i]!;
        lines.push(
            `#### ${i + 1}. \`${arc.steps.join(" → ")}\` (support: ${arc.support})`,
            "",
            `Steps: ${arc.steps.join(" → ")}`,
            `Sessions: ${arc.support}`,
            "",
            "```yaml",
            "is_workflow:   # true or false",
            "skill_name:    # proposed skill name if true",
            "landing:       # skill | guidance | memory",
            "rationale:     # why (or why not)",
            "```",
            "",
        );
    }

    return lines.join("\n");
};
