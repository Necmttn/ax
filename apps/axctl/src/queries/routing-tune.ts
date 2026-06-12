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
 */
import { Effect, FileSystem, Path } from "effect";
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

export const JUDGMENT_RE =
    /\b(review\w*|critique\w*|critic\w*|design\w*|plan(s|ned|ning)?|audit\w*|judg\w*|verif\w*|assess\w*|architect\w*)\b/i;

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
    readonly applied: ReadonlyArray<TuneProposal>;
    readonly skipped_judgment: ReadonlyArray<TuneProposal>;
    /** True when the file exists but is corrupt - we refuse to overwrite. */
    readonly corrupt: boolean;
}

/**
 * Apply proposals to the stored routing table.
 * ids === null  -> auto mode: apply all NON-judgment proposals, report skips.
 * ids === [...] -> explicit mode (post-brief): apply exactly those ids;
 *                  judgment flags are ignored because an agent vetted them.
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
            return { path: tablePath, applied: [], skipped_judgment: [], corrupt: true };
        }
        const selected = opts.ids === null
            ? proposals.filter((p) => !p.judgment)
            : proposals.filter((p) => opts.ids!.includes(p.id));
        const skipped = opts.ids === null ? proposals.filter((p) => p.judgment) : [];
        const base = mergeRoutingTables(ROUTING_CLASSES, existing);
        const additions: StoredRoutingClass[] = selected.map((p) => ({
            id: p.id,
            pattern: p.pattern,
            flags: p.flags,
            suggest: p.suggest,
            reason: p.reason,
            origin: "user" as const,
        }));
        const next = appendUserClasses(base, additions);
        yield* saveStoredRoutingTable(tablePath, next);
        return { path: tablePath, applied: selected, skipped_judgment: skipped, corrupt: false };
    });
