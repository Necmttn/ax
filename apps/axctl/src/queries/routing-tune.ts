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
 *
 * Mined proposals always suggest "sonnet" (conservative tier-down). Haiku
 * routing stays the job of the agent-type rules already in the table: the
 * haiku-tier agent types are exactly the ones ROUTING_CLASSES.agentTypes
 * routes, so they never reach the unmatched set this miner clusters.
 *
 * Beyond mining, this module also WRITES the live routing table: applyProposals
 * appends surviving proposals to the stored routing-table.json as origin:user
 * classes (with the same corrupt-file guard as `ax routing compile`).
 */
import { Effect, FileSystem, Path } from "effect";
import { JUDGMENT_STRONG_RE } from "@ax/hooks-sdk/spend-mode";
import {
    fetchDispatches,
    matchRoutingWith,
    EXPENSIVE_TIER_RE,
    ROUTING_CLASSES,
    type DispatchRow,
    type RoutingTable,
} from "./dispatch-analytics.ts";
import {
    appendUserClasses,
    loadStoredRoutingTable,
    mergeRoutingTables,
    saveStoredRoutingTable,
    type StoredRoutingClass,
} from "./routing-table-io.ts";

/**
 * Re-export the shared judgment regex from hooks-sdk/spend-mode (single source of truth).
 *
 * Behavioral delta vs the former local JUDGMENT_RE:
 *   Old: matched bare "review", "plan", "verif", "assess" in addition to the
 *        qualified review forms and design/audit/architect.../critique/judg...
 *   New (JUDGMENT_STRONG_RE): matches only qualified reviews (quality/PR/final/
 *        adversarial/code review), design, audit, architect..., critique, critic..., judg...
 *
 * Effect on routing-tune: clusters whose keys contain bare "review", "plan", "verify",
 * or "assess" will no longer be auto-flagged as judgment. They will either
 * auto-apply (if non-judgment) or surface via --emit-brief for human review.
 * This is the defensible call: JUDGMENT_STRONG_RE is the authoritative signal;
 * routing-tune's --emit-brief + agent vetting is the backstop for ambiguous clusters.
 */
export const JUDGMENT_RE = JUDGMENT_STRONG_RE;

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

/**
 * "summarize the" -> "^summarize\s+the\b"; "task N" -> "^task\s+\d+\b";
 * "port vN" -> "^port\s+v\d+\b". Tokens are lowercased before N-injection
 * (normalizeKey), so the uppercase N sentinel is unambiguous - substitute
 * \d+ for every N, including digit runs embedded inside tokens.
 */
const keyToPattern = (key: string): string =>
    "^" +
    key.split(" ").map((t) => escapeToken(t).replace(/N/g, "\\d+")).join("\\s+") +
    "\\b";

export const buildProposals = (
    clusters: Map<string, DispatchRow[]>,
): TuneProposal[] => {
    const proposals: TuneProposal[] = [];
    for (const [key, rows] of clusters) {
        if (rows.length < MIN_CLUSTER_SIZE) continue;
        const totalCost = rows.reduce((s, r) => s + r.child_cost_usd, 0);
        // Always sonnet: conservative tier-down. Haiku routing is the job of
        // the agent-type rules already in the table (see module doc).
        const suggest: "sonnet" | "haiku" = "sonnet";
        const examples = rows
            .slice(0, 3)
            .map((r) => r.description ?? "")
            .filter((d) => d.length > 0);
        // Judgment scans the key and EVERY row's description (not just the
        // first-3 examples) - one judgment-work member taints the cluster.
        const judgment =
            JUDGMENT_RE.test(key) ||
            rows.some((r) => r.description !== null && JUDGMENT_RE.test(r.description));
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

/**
 * Dispatch descriptions flow verbatim into the brief - the safety-gate
 * document an agent reads. Collapse newlines and escape backticks so an
 * adversarial description can't inject markdown structure or close a fence.
 */
const sanitizeExample = (e: string): string =>
    e.replace(/[\r\n]+/g, " ").replace(/`/g, "\\`");

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
        // --days must match the mining window: a default-window re-mine could
        // miss the brief's proposals and the apply would decay silently.
        `ax routing tune --days=${opts.days} --apply=<id,id,...>   # apply surviving proposals by id`,
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
        lines.push(`- **${p.id}**: ${p.examples.map((e) => `"${sanitizeExample(e)}"`).join(", ")}`);
    }
    lines.push("");
    return lines.join("\n");
};

// ---------------------------------------------------------------------------
// applyProposals - write surviving proposals into the stored routing table
// ---------------------------------------------------------------------------

export interface ApplyResult {
    readonly path: string;
    /** Proposals that actually landed in the table (not already present). */
    readonly applied: ReadonlyArray<TuneProposal>;
    /** Selected but already present in the table by id - nothing written for these. */
    readonly skipped_existing: ReadonlyArray<TuneProposal>;
    readonly skipped_judgment: ReadonlyArray<TuneProposal>;
    /** Explicit ids with no matching proposal (always empty in auto mode). */
    readonly unknown_ids: ReadonlyArray<string>;
    /** True when the file exists but is corrupt - we refuse to overwrite. */
    readonly corrupt: boolean;
}

/**
 * Apply proposals to the stored routing table.
 * ids === null  -> auto mode: apply all NON-judgment proposals, report skips.
 * ids === [...] -> explicit mode (post-brief): apply exactly those ids;
 *                  judgment flags are ignored because an agent vetted them.
 *
 * Reporting is honest: `applied` only contains proposals that actually landed.
 * Ids already present in the table go to `skipped_existing` (appendUserClasses
 * dedupes by id, first wins); explicit ids matching no proposal surface in
 * `unknown_ids` instead of being silently dropped.
 *
 * Writing goes through mergeRoutingTables, so an apply ALSO refreshes the
 * default classes/agentTypes to current ROUTING_CLASSES - necessary because
 * the stored file is read as the whole table by the route-dispatch hook.
 *
 * Corrupt-file guard (mirrors compileRouting): if the file exists but is
 * unparseable, refuse to write and return corrupt: true. Overwriting would
 * silently destroy any previously mined user classes.
 */
export const applyProposals = (
    tablePath: string,
    proposals: ReadonlyArray<TuneProposal>,
    opts: { readonly ids: ReadonlyArray<string> | null },
): Effect.Effect<ApplyResult, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const exists = yield* fs.exists(tablePath).pipe(Effect.orElseSucceed(() => false));
        const existing = yield* loadStoredRoutingTable(tablePath);
        if (exists && existing === null) {
            // File present but corrupt/unparseable: refuse to overwrite.
            return {
                path: tablePath,
                applied: [],
                skipped_existing: [],
                skipped_judgment: [],
                unknown_ids: [],
                corrupt: true,
            };
        }
        const ids = opts.ids;
        const selected = ids === null
            ? proposals.filter((p) => !p.judgment)
            : proposals.filter((p) => ids.includes(p.id));
        const skippedJudgment = ids === null ? proposals.filter((p) => p.judgment) : [];
        const unknownIds = ids === null
            ? []
            : ids.filter((id) => !proposals.some((p) => p.id === id));
        const base = mergeRoutingTables(ROUTING_CLASSES, existing);
        const baseIds = new Set(base.classes.map((c) => c.id));
        const landed = selected.filter((p) => !baseIds.has(p.id));
        const skippedExisting = selected.filter((p) => baseIds.has(p.id));
        const additions: StoredRoutingClass[] = landed.map((p) => ({
            id: p.id,
            pattern: p.pattern,
            flags: p.flags,
            suggest: p.suggest,
            reason: p.reason,
            origin: "user" as const,
        }));
        // No-op applies (typo'd --apply, all-judgment auto run, everything
        // already present) must leave the file untouched - don't rewrite it
        // and don't create one that didn't exist.
        if (landed.length > 0) {
            const next = appendUserClasses(base, additions);
            yield* saveStoredRoutingTable(tablePath, next);
        }
        return {
            path: tablePath,
            applied: landed,
            skipped_existing: skippedExisting,
            skipped_judgment: skippedJudgment,
            unknown_ids: unknownIds,
            corrupt: false,
        };
    });
