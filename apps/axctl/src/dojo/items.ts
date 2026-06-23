/**
 * ax dojo - pure row -> DojoItem mappers for every agenda source.
 * Spec: docs/superpowers/specs/2026-06-13-ax-dojo-design.md
 *
 * All mappers are pure: query outputs in, agenda items out. The Effect glue
 * that actually runs the queries lives in agenda.ts.
 */
import type { PendingVerdictRow } from "../improve/verdict-pending.ts";
import type { SessionChurnRow } from "../metrics/session-churn.ts";
import type { TuneProposal } from "../queries/routing-tune.ts";
import type { DojoItem } from "./schema.ts";

export const pendingVerdictItems = (rows: readonly PendingVerdictRow[]): DojoItem[] =>
    rows.map((r) => ({
        id: `verdict:${r.id}`,
        kind: "verdict_pending",
        title: `Lock verdict: ${r.title}`,
        commands: [
            `ax improve verdict ${r.sig}`,
            `ax improve verdict ${r.sig} --set <verdict>`,
        ],
        success: "experiment.locked_verdict set",
        cost_class: "s",
    }));

/** Judgment-flagged proposals only: non-judgment ones auto-apply via `ax routing tune`. */
export const routingBacktestItems = (
    proposals: readonly TuneProposal[],
    days: number,
): DojoItem[] =>
    proposals
        .filter((p) => p.judgment)
        .map((p) => ({
            id: `routing:${p.id}`,
            kind: "routing_backtest",
            title: `Backtest routing class ${p.pattern} (${p.count} dispatches, $${p.total_cost_usd.toFixed(2)})`,
            commands: [
                `ax routing tune --days=${days} --emit-brief`,
                `ax routing tune --apply=${p.id} --days=${days}`,
            ],
            success: "class applied to routing table (origin: user) or rejected with rationale",
            cost_class: "m",
        }));

export const MINT_THRESHOLD = 3;

export const proposalMintItem = (openProposalCount: number): DojoItem | null =>
    openProposalCount >= MINT_THRESHOLD
        ? null
        : {
            id: "mint:improve-recommend",
            kind: "proposal_mint",
            title: "Mint new improvement proposals (open pool is low)",
            commands: ["ax improve recommend", "ax improve accept <id>"],
            success: "new open proposals exist; accepted ones emitted .ax/tasks briefs",
            cost_class: "m",
        };

/** Repair LOC above this marks a session a churn hotspot even when every episode passed. */
export const REPAIR_LINE_HOTSPOT_THRESHOLD = 200;

/** Last 8 chars of the session id, sanitized to [a-z0-9-] for worktree/branch names. */
const sessionShort = (session: string): string =>
    session.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(-8);

export const churnHotspotItems = (rows: readonly SessionChurnRow[]): DojoItem[] =>
    rows
        .filter((r) => r.episodes > r.passedEpisodes || r.repairLinesAdded > REPAIR_LINE_HOTSPOT_THRESHOLD)
        .sort((a, b) => b.repairLinesAdded - a.repairLinesAdded)
        .slice(0, 2)
        .map((r) => ({
            id: `experiment:${r.session}`,
            kind: "experiment",
            title: `Worktree experiment: reduce ${r.topCheck} churn (${r.taskLabel})`,
            commands: [
                `ax sessions show ${r.session}`,
                `git worktree add .claude/worktrees/dojo-${sessionShort(r.session)} -b dojo/${sessionShort(r.session)}`,
                "ax improve recommend  # package the result as a proposal",
            ],
            success: "experiment branch + evidence captured as an improve proposal",
            cost_class: "l",
        }));

export const sparItem = (): DojoItem => ({
    id: "spar:campaign",
    kind: "spar",
    title: "Sparring: one task, one delta, scored (see skill playbook)",
    commands: [
        "ax sessions here --days=30  # pick a landed task; note its commit sha",
        "ax dojo spar-plan <sha>     # capture baseline + emit the experiment brief",
        "ax dojo spar-score <id>     # after running the variant in the worktree",
    ],
    success: "spar report appended to the dojo report; goal package updated",
    cost_class: "xl",
});

export const exploreItem = (): DojoItem => ({
    id: "explore:retro-meta",
    kind: "explore",
    title: "Agenda dry - free investigation (retro-meta style)",
    commands: ["ax recall <hunch> --scope=all", "ax sessions churn --since=30"],
    success: "at least one new outbox draft, proposal, or goal package",
    cost_class: "l",
});

/** Minimal shape of a directive candidate row consumed by the pure mapper. */
export interface DirectiveCandidate {
    readonly title?: string;
}

/**
 * Pure mapper: N unconfirmed directive candidates -> one "directives" DojoItem.
 * Returns [] when there are no candidates (self-clearing: item vanishes once
 * all open section=directives proposals are accepted/rejected).
 */
export const directiveCandidateItems = (
    candidates: readonly DirectiveCandidate[],
): DojoItem[] => {
    if (candidates.length === 0) return [];
    const n = candidates.length;
    return [
        {
            id: "directives:mine",
            kind: "directives",
            title: `Mine ${n} unconfirmed directive candidate${n === 1 ? "" : "s"} into proposals`,
            commands: ["ax directives mine --emit-brief"],
            success:
                "directive proposals accepted (section=directives open proposals cleared)",
            cost_class: "s",
        },
    ];
};
