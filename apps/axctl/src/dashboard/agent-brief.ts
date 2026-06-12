/** Pure renderer for copy-pasteable agent task briefs (spec: improve-first dashboard). */

export interface AgentBrief {
    readonly title: string;
    readonly evidence: string;
    readonly ask: string;
    readonly verify: string;
    readonly source: string;
}

/** Renders an AgentBrief as a copy-pasteable markdown task block. */
export const renderAgentBrief = (b: AgentBrief): string =>
    [
        `## Task: ${b.title}`,
        "",
        `**Evidence:** ${b.evidence}`,
        "",
        `**Ask:** ${b.ask}`,
        "",
        `**Verify:** ${b.verify}`,
        "",
        `_source: ${b.source}_`,
    ].join("\n");
