/**
 * `ax routing tune` - deterministic mining of new routing classes from the
 * user's own dispatch history.
 *
 * The agent-driven /routing-tune workflow (committed, ax-repo-only) remains
 * the tool for tuning the shipped ROUTING_CLASSES defaults; this module is the
 * user-facing deterministic subset: cluster unmatched expensive inherit
 * dispatches by two-token description prefix, propose origin:user classes.
 *
 * Honest-savings semantics (PR #312): proposals report ADDRESSABLE spend (the
 * cluster's actual child cost), not a fabricated repriced delta.
 *
 * Judgment-work clusters (review/critique/design/...) are NEVER auto-applied:
 * quality reviews stay on the main model by design; those proposals only ship
 * via --emit-brief for an agent to adversarially backtest.
 */
import { Effect } from "effect";
import {
    fetchDispatches,
    matchRoutingWith,
    EXPENSIVE_TIER_RE,
    type DispatchRow,
    type RoutingTable,
} from "./dispatch-analytics.ts";

export const JUDGMENT_RE = /\b(review|critique|design|plan|audit|judge|verif\w*|assess|architect\w*)\b/i;

const HAIKU_AGENT_TYPES = new Set(["Explore", "codebase-locator", "codebase-pattern-finder"]);

export interface TuneProposal {
    readonly id: string;
    readonly pattern: string;
    readonly flags: "i";
    readonly suggest: "sonnet" | "haiku";
    readonly reason: string;
    readonly count: number;
    readonly total_cost_usd: number;
    readonly examples: ReadonlyArray<string>;
    readonly judgment: boolean;
}

/** Two-token lowercase prefix; digit runs -> "N"; punctuation stripped. */
export const normalizeKey = (description: string | null): string | null => {
    if (!description) return null;
    const tokens = description
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((t) => t.toLowerCase().replace(/\d+/g, "N").replace(/[^a-z0-9N-]/g, ""))
        .filter((t) => t.length > 0);
    if (tokens.length === 0) return null;
    return tokens.join(" ");
};

export const clusterRows = (
    rows: ReadonlyArray<DispatchRow>,
): Map<string, DispatchRow[]> => {
    const clusters = new Map<string, DispatchRow[]>();
    for (const r of rows) {
        const key = normalizeKey(r.description);
        if (key === null) continue;
        const list = clusters.get(key) ?? [];
        list.push(r);
        clusters.set(key, list);
    }
    return clusters;
};

const MIN_CLUSTER_SIZE = 3;

const escapeToken = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "summarize the" -> "^summarize\s+the"; "task N" -> "^task\s+\d+" */
const keyToPattern = (key: string): string =>
    "^" + key.split(" ").map((t) => (t === "N" ? "\\d+" : escapeToken(t))).join("\\s+");

export const buildProposals = (
    clusters: Map<string, DispatchRow[]>,
): TuneProposal[] => {
    const proposals: TuneProposal[] = [];
    for (const [key, rows] of clusters) {
        if (rows.length < MIN_CLUSTER_SIZE) continue;
        const totalCost = rows.reduce((s, r) => s + r.child_cost_usd, 0);
        const haikuCount = rows.filter((r) => r.agent_type !== null && HAIKU_AGENT_TYPES.has(r.agent_type)).length;
        const suggest: "sonnet" | "haiku" = haikuCount * 2 >= rows.length ? "haiku" : "sonnet";
        const examples = rows
            .slice(0, 3)
            .map((r) => r.description ?? "")
            .filter((d) => d.length > 0);
        const judgment = JUDGMENT_RE.test(key) || examples.some((e) => JUDGMENT_RE.test(e));
        proposals.push({
            id: key.replace(/\s+/g, "-"),
            pattern: keyToPattern(key),
            flags: "i",
            suggest,
            reason: `mined: ${rows.length} dispatches, $${totalCost.toFixed(2)} addressable`,
            count: rows.length,
            total_cost_usd: totalCost,
            examples,
            judgment,
        });
    }
    proposals.sort((a, b) => b.total_cost_usd - a.total_cost_usd);
    return proposals;
};

/** Fetch window -> filter inherit+expensive+unmatched -> cluster -> proposals. */
export const fetchTuneProposals = Effect.fn("queries.fetchTuneProposals")(
    function* (opts: { readonly sinceDays: number; readonly table: RoutingTable }) {
        const result = yield* fetchDispatches({
            sinceDays: opts.sinceDays,
            limit: Number.MAX_SAFE_INTEGER,
        });
        const unmatched = result.rows.filter(
            (r) =>
                r.dispatch_model === "inherit" &&
                r.child_model !== null &&
                EXPENSIVE_TIER_RE.test(r.child_model) &&
                matchRoutingWith(opts.table, r.description, r.agent_type) === null,
        );
        return buildProposals(clusterRows(unmatched));
    },
);

export const renderTuneBrief = (
    proposals: ReadonlyArray<TuneProposal>,
    opts: { readonly days: number; readonly date: string },
): string => {
    const lines: string[] = [
        `# routing-tune brief - ${opts.date}`,
        "",
        `Mined from the last ${opts.days} days of dispatch history. Each proposal is a`,
        "candidate routing class for `~/.ax/hooks/routing-table.json`.",
        "",
        "## Your task (agent)",
        "",
        "For each proposal below, adversarially backtest it: search the dispatch",
        "history for descriptions that MATCH the pattern but are judgment work",
        "(quality review, design, architecture, planning) - those must stay on the",
        "main model. Kill any proposal with plausible false positives. Then apply",
        "the survivors:",
        "",
        "```bash",
        `ax routing tune --apply=<id,id,...>   # apply surviving proposals by id`,
        "```",
        "",
        "## Proposals",
        "",
        "| id | pattern | suggest | dispatches | addressable | judgment-flagged |",
        "|---|---|---|---|---|---|",
    ];
    for (const p of proposals) {
        lines.push(
            `| ${p.id} | \`${p.pattern.replace(/\|/g, "\\|")}\` | ${p.suggest} | ${p.count} | $${p.total_cost_usd.toFixed(2)} | ${p.judgment ? "YES" : "no"} |`,
        );
    }
    lines.push("", "### Examples per proposal", "");
    for (const p of proposals) {
        lines.push(`- **${p.id}**: ${p.examples.map((e) => `"${e}"`).join(", ")}`);
    }
    lines.push("");
    return lines.join("\n");
};
