// apps/axctl/src/dojo/items.test.ts
import { describe, expect, test } from "bun:test";
import type { SessionChurnRow } from "../metrics/session-churn.ts";
import type { TuneProposal } from "../queries/routing-tune.ts";
import {
    churnHotspotItems,
    exploreItem,
    MINT_THRESHOLD,
    pendingVerdictItems,
    proposalMintItem,
    routingBacktestItems,
    sparItem,
} from "./items.ts";

const tune = (
    id: string,
    pattern: string,
    count: number,
    cost: number,
    judgment: boolean,
): TuneProposal => ({
    id,
    pattern,
    flags: "i",
    suggest: "sonnet",
    reason: `mined: ${count} dispatches, $${cost.toFixed(2)} addressable`,
    count,
    total_cost_usd: cost,
    examples: [],
    judgment,
});

const churnRow = (
    session: string,
    episodes: number,
    passed: number,
    repair: number,
): SessionChurnRow => ({
    session,
    source: "claude",
    taskLabel: `task ${session}`,
    landedLinesAdded: 0,
    landedLinesRemoved: 0,
    editLinesAdded: 0,
    editLinesRemoved: 0,
    repairLinesAdded: repair,
    repairLinesRemoved: 0,
    editEvents: 0,
    verificationFailures: episodes,
    verificationPasses: passed,
    episodes,
    passedEpisodes: passed,
    topCheck: "typecheck",
    otlp_cost_usd: null,
    otlp_tokens: null,
});

describe("item mappers", () => {
    test("pending verdicts -> verdict_pending items with improve verdict commands", () => {
        const items = pendingVerdictItems([
            { id: "experiment:aaa", sig: "sig-aaa", title: "Stop bare bun test", status: "scaffolded" },
        ]);
        expect(items).toEqual([
            {
                id: "verdict:experiment:aaa",
                kind: "verdict_pending",
                title: "Lock verdict: Stop bare bun test",
                commands: ["ax improve verdict sig-aaa", "ax improve verdict sig-aaa --set <verdict>"],
                success: "experiment.locked_verdict set",
                cost_class: "s",
            },
        ]);
    });

    test("judgment-flagged tune proposals -> routing_backtest items; non-judgment skipped", () => {
        const items = routingBacktestItems(
            [
                tune("rt1", "^review", 5, 4.2, true),
                tune("rt2", "^fmt", 3, 0.4, false),
            ],
            30,
        );
        expect(items).toHaveLength(1);
        expect(items[0]?.id).toBe("routing:rt1");
        expect(items[0]?.commands).toEqual([
            "ax routing tune --days=30 --emit-brief",
            "ax routing tune --apply=rt1 --days=30",
        ]);
    });

    test("churn hotspots: only sessions with failed episodes, top 2, cost l", () => {
        const items = churnHotspotItems([
            churnRow("s1", 4, 1, 500),
            churnRow("s2", 0, 0, 0), // clean - skipped
            churnRow("s3", 6, 2, 900),
            churnRow("s4", 2, 1, 100),
        ]);
        expect(items.map((i) => i.id)).toEqual(["experiment:s3", "experiment:s1"]); // by repair desc, top 2
        expect(items[0]?.kind).toBe("experiment");
        expect(items[0]?.cost_class).toBe("l");
        // worktree path/branch are session-derived so the two items never collide
        expect(items[0]?.commands).toContain("git worktree add .claude/worktrees/dojo-s3 -b dojo/s3");
        expect(items[1]?.commands).toContain("git worktree add .claude/worktrees/dojo-s1 -b dojo/s1");
    });

    test("churn hotspots: repair-only branch - all episodes passed but repair LOC over threshold", () => {
        const items = churnHotspotItems([
            churnRow("s5", 2, 2, 300), // episodes === passedEpisodes, repair > threshold -> included
            churnRow("s6", 2, 2, 100), // episodes === passedEpisodes, repair under threshold -> excluded
        ]);
        expect(items.map((i) => i.id)).toEqual(["experiment:s5"]);
    });

    test("proposal mint emitted only when open proposals are scarce", () => {
        expect(proposalMintItem(0)).not.toBeNull();
        expect(proposalMintItem(2)).not.toBeNull();
        expect(proposalMintItem(MINT_THRESHOLD)).toBeNull();
    });

    test("spar + explore singletons", () => {
        expect(sparItem().kind).toBe("spar");
        expect(sparItem().cost_class).toBe("xl");
        expect(exploreItem().kind).toBe("explore");
    });
});
