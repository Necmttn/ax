/**
 * Pure renderer for `ax directives mine --emit-brief` task files.
 * No I/O, no Effect - transforms inputs to markdown string only.
 * Modeled on renderTuneBrief (queries/routing-tune.ts) and
 * renderClassifyBrief (cli/skills-classify-template.ts).
 */

import type { ScoredDirectiveCandidate } from "../ingest/directives.ts";

export type { ScoredDirectiveCandidate };

export interface DirectivesBriefOpts {
    readonly date: string;
    readonly days: number;
}

/**
 * Render a `.ax/tasks/directives-<date>.md` brief for agent review.
 *
 * For each candidate the agent must decide:
 *   - is_directive: true/false  (is this a genuine standing instruction?)
 *   - canonical_text: the best one-liner wording
 *   - landing: memory | guidance | hook  (where it should be codified)
 *   - rationale: why
 *
 * Accepted candidates land via `ax improve accept` / `ax improve lint`
 * (the guidance-form proposal row already exists in the proposal table;
 * the brief is the agent's vetting gate before that).
 */
export const renderDirectivesBrief = (
    candidates: ReadonlyArray<ScoredDirectiveCandidate>,
    opts: DirectivesBriefOpts,
): string => {
    const { date, days } = opts;
    const lines: string[] = [
        `# directives brief - ${date}`,
        "",
        `Mined from the last ${days} days of user turns. Each entry is a candidate`,
        "standing instruction detected by the directive miner.",
        "",
        "## Your task (agent)",
        "",
        "For each candidate below, judge whether it is a genuine standing directive",
        "(a 'from now on / always / remember to' rule the user wants applied",
        "consistently) vs. incidental phrasing in a task description. Then fill in",
        "the decision block for each one and accept the real directives:",
        "",
        "```bash",
        "ax improve list --form=guidance   # see open guidance proposals",
        "ax improve accept <id>            # accept a directive proposal",
        "```",
        "",
    ];

    if (candidates.length === 0) {
        lines.push("(no directive candidates found in the last", `${days} days)`);
        lines.push("");
        return lines.join("\n");
    }

    lines.push("## Candidates", "");
    lines.push(
        `| # | pattern | score | source | ts | session |`,
        `|---|---|---|---|---|---|`,
    );
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        const score = c.source === "lift" ? c.score.toFixed(2) : "seed";
        lines.push(
            `| ${i + 1} | ${c.pattern} | ${score} | ${c.source} | ${c.ts.slice(0, 10)} | ${c.sessionId} |`,
        );
    }

    lines.push("", "### Candidate texts + decision blocks", "");
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        const score = c.source === "lift" ? c.score.toFixed(2) : "seed";
        lines.push(
            `#### ${i + 1}. \`${c.pattern}\` (lift/score: ${score})`,
            "",
            `> ${c.text}`,
            `> session: ${c.sessionId}  ts: ${c.ts}`,
            "",
            "```yaml",
            "is_directive:    # true or false",
            "canonical_text:  # clean one-liner if true",
            "landing:         # memory | guidance | hook",
            "rationale:       # why",
            "```",
            "",
        );
    }

    return lines.join("\n");
};
