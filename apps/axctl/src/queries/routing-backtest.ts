/**
 * Pure backtest utility: partition a dispatch history by a candidate routing regex.
 *
 * No DB access - callers supply the rows and catalog so this is trivially testable
 * and reusable from both the CLI (`ax routing tune`) and the studio cost view.
 *
 * `runRoutingBacktest` is the DB-backed Effect entry-point for the dashboard
 * handler: it fetches dispatch rows + agent_model pricing, then delegates to the
 * pure `backtestPattern` function above.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { reprice, MODEL_ALIASES, type RepriceUsage } from "./reprice.ts";
import type { ModelPricing } from "../ingest/model-pricing.ts";
import { fetchDispatches } from "./dispatch-analytics.ts";

/** Regex that matches model names considered "expensive" for routing purposes. */
const EXPENSIVE_RE = /fable|opus/i;

export interface BacktestDispatch {
    description: string | null;
    agent_type: string | null;
    child_model: string | null;
    child_cost_usd: number;
    dispatch_model: string;
    usage?: RepriceUsage | null;
}

export interface BacktestPattern {
    pattern: string;
    flags?: string;
    suggest: string;
    exclude?: readonly string[];
}

export interface BacktestRow {
    description: string | null;
    childModel: string | null;
    costUsd: number;
    estSavingsUsd: number;
}

export interface BacktestResult {
    matched: BacktestRow[];
    excluded: BacktestRow[];
    missed: BacktestRow[];
    estSavingsUsd: number;
    matchedCount: number;
}

/**
 * Partition `rows` into matched / excluded / missed buckets given a candidate
 * routing pattern `p`.
 *
 * - **matched**: description matches `p.pattern` AND does NOT match any exclude regex.
 * - **excluded**: description matches `p.pattern` but also matches an exclude regex.
 * - **missed**: does NOT match `p.pattern`, is an `inherit` dispatch, and ran on an
 *   expensive model (fable/opus) - i.e. a dispatch the pattern should have caught.
 *
 * `estSavingsUsd` is the sum of per-row savings for matched rows only. Savings
 * are computed via `reprice` when `row.usage` is present; 0 otherwise.
 *
 * An invalid `p.pattern` is caught silently - all rows land in `missed`.
 */
export function backtestPattern(
    rows: ReadonlyArray<BacktestDispatch>,
    p: BacktestPattern,
    pricingCatalog: ReadonlyMap<string, ModelPricing>,
): BacktestResult {
    // Compile main pattern - null on syntax error (fail-safe).
    let re: RegExp | null = null;
    try { re = new RegExp(p.pattern, p.flags ?? ""); } catch { re = null; }

    // Compile exclude patterns, skip invalid ones.
    const excludeRes = (p.exclude ?? [])
        .map((ex) => { try { return new RegExp(ex, p.flags ?? ""); } catch { return null; } })
        .filter((x): x is RegExp => x !== null);

    const target = MODEL_ALIASES[p.suggest] ?? p.suggest;

    const matched: BacktestRow[] = [];
    const excluded: BacktestRow[] = [];
    const missed: BacktestRow[] = [];
    let estSavingsUsd = 0;

    for (const row of rows) {
        const desc = row.description ?? "";
        const hit = re ? re.test(desc) : false;
        const expensiveInherit =
            row.dispatch_model === "inherit" &&
            !!row.child_model &&
            EXPENSIVE_RE.test(row.child_model);

        // Compute per-row savings: only meaningful when token usage is present.
        const repriced = row.usage
            ? reprice(row.usage, target, pricingCatalog)
            : row.child_cost_usd; // no usage → can't reprice, treat as equal
        const saving = row.usage
            ? Math.max(0, row.child_cost_usd - Math.min(repriced, row.child_cost_usd))
            : 0;

        const out: BacktestRow = {
            description: row.description,
            childModel: row.child_model,
            costUsd: row.child_cost_usd,
            estSavingsUsd: saving,
        };

        if (hit && excludeRes.some((ex) => ex.test(desc))) {
            excluded.push(out);
            continue;
        }
        if (hit) {
            matched.push(out);
            estSavingsUsd += saving;
            continue;
        }
        // Not matched - only surface in missed when it's an expensive inherit dispatch.
        if (expensiveInherit) {
            missed.push(out);
        }
    }

    return { matched, excluded, missed, estSavingsUsd, matchedCount: matched.length };
}

// ---------------------------------------------------------------------------
// DB-backed Effect entry-point (used by the dashboard /api/routing/backtest
// handler).  Fetches dispatch rows + agent_model pricing catalog, then
// delegates to the pure backtestPattern above.
// ---------------------------------------------------------------------------

const AGENT_MODELS_SQL = `
SELECT name, input_per_million_usd, output_per_million_usd,
       cache_read_per_million_usd, cache_creation_per_million_usd
FROM agent_model;
`;

export const runRoutingBacktest = Effect.fn("queries.runRoutingBacktest")(
    function* (payload: BacktestPattern & { readonly days?: number }) {
        const db = yield* SurrealClient;
        const sinceDays = Math.max(1, Math.trunc(payload.days ?? 14));

        // Fetch dispatch rows (includes per-dispatch token usage).
        const result = yield* fetchDispatches({ sinceDays, limit: 2000 });

        // Build pricingCatalog from agent_model - same pattern as
        // fetchDispatchCandidates in dispatch-analytics.ts.
        const agentModelRows = yield* db
            .query<[Array<Record<string, unknown>>]>(AGENT_MODELS_SQL)
            .pipe(Effect.map((r) => r?.[0] ?? []));

        const pricingCatalog = new Map<string, ModelPricing>();
        for (const am of agentModelRows) {
            const name = String(am.name ?? "");
            if (!name) continue;
            pricingCatalog.set(name, {
                provider: "anthropic",
                inputPerMillionUsd: am.input_per_million_usd == null ? null : Number(am.input_per_million_usd),
                outputPerMillionUsd: am.output_per_million_usd == null ? null : Number(am.output_per_million_usd),
                cacheCreationPerMillionUsd: am.cache_creation_per_million_usd == null ? null : Number(am.cache_creation_per_million_usd),
                cacheReadPerMillionUsd: am.cache_read_per_million_usd == null ? null : Number(am.cache_read_per_million_usd),
                fastMultiplier: 1,
                pricingSource: "agent_model",
            });
        }

        // Map DispatchRow[] → BacktestDispatch[].
        const backtestRows: BacktestDispatch[] = result.rows.map((row) => ({
            description: row.description,
            agent_type: row.agent_type,
            child_model: row.child_model,
            child_cost_usd: row.child_cost_usd,
            dispatch_model: row.dispatch_model,
            usage:
                row.prompt_tokens > 0 || row.completion_tokens > 0
                    ? {
                        prompt_tokens: row.prompt_tokens,
                        completion_tokens: row.completion_tokens,
                        cache_read_tokens: row.cache_read_tokens,
                        cache_create_tokens: row.cache_create_tokens,
                        cost_usd: row.child_cost_usd,
                    }
                    : null,
        }));

        return backtestPattern(backtestRows, payload, pricingCatalog);
    },
);
