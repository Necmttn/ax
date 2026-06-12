/**
 * ax dojo - agenda assembly. Spec: docs/superpowers/specs/2026-06-13-ax-dojo-design.md
 *
 * `assembleAgenda` is the pure, tested core: budget + flat item list -> ordered
 * agenda (priority sort, spar gate, explore fallback). `collectAgendaItems` is
 * the Effect glue that runs every source with per-source failure isolation: a
 * broken source logs to stderr and contributes nothing - it must never kill
 * the whole agenda.
 */
import { Effect, type FileSystem } from "effect";
import type { SurrealClient } from "@ax/lib/db";
import { listProposals } from "../improve/list.ts";
import { listPendingVerdicts } from "../improve/verdict-pending.ts";
import { fetchSessionChurnSummary, type SessionChurnRow } from "../metrics/session-churn.ts";
import { loadEffectiveRoutingTable } from "../queries/routing-table-io.ts";
import { fetchTuneProposals, type TuneProposal } from "../queries/routing-tune.ts";
import { defaultTaskDir, scanTaskDir } from "./briefs.ts";
import {
    churnHotspotItems,
    exploreItem,
    pendingVerdictItems,
    proposalMintItem,
    routingBacktestItems,
    sparItem,
} from "./items.ts";
import type { BudgetEnvelope, DojoAgenda, DojoItem } from "./schema.ts";
import { compareByPriority } from "./schema.ts";

export const SPAR_MIN_SPENDABLE_PCT = 30;

export interface AssembleOptions {
    readonly nowMs: number;
    readonly spar: boolean;
}

/** Pure: budget + flat item list -> ordered agenda. */
export const assembleAgenda = (
    budget: BudgetEnvelope,
    items: readonly DojoItem[],
    opts: AssembleOptions,
): DojoAgenda => {
    const sorted = [...items].sort(compareByPriority);
    if (opts.spar && budget.spendable_pct >= SPAR_MIN_SPENDABLE_PCT) sorted.push(sparItem());
    if (sorted.length === 0) sorted.push(exploreItem());
    return {
        v: 1,
        generated_at: new Date(opts.nowMs).toISOString(),
        budget,
        items: sorted,
    };
};

export interface CollectOptions {
    readonly nowMs: number;
    /** lookback window (days) for churn + routing tune */
    readonly days: number;
    readonly spar: boolean;
    /** override for tests; defaults to AX_TASK_DIR ?? $PWD/.ax/tasks */
    readonly taskDir?: string;
    /** override for tests; defaults to ~/.ax/hooks/routing-table.json */
    readonly routingTablePath?: string;
}

const DAY_MS = 86_400_000;

/** Hot-session rows to consider before churnHotspotItems trims to its top 2. */
const CHURN_SESSION_LIMIT = 20;

/** Per-source failure isolation: log the failure, contribute the empty value. */
const soft = <A, E, R>(
    label: string,
    eff: Effect.Effect<A, E, R>,
    empty: A,
): Effect.Effect<A, never, R> =>
    eff.pipe(
        Effect.catch((e) =>
            Effect.sync(() => {
                console.error(`dojo: source ${label} failed: ${String(e)}`);
                return empty;
            }),
        ),
    );

/**
 * Run every agenda source and flatten into items. Sources soft-fail
 * independently, so the error channel is `never`; requirements are exactly
 * what the underlying queries need (DB reads + task-dir/routing-table reads).
 */
export const collectAgendaItems = (
    opts: CollectOptions,
): Effect.Effect<DojoItem[], never, SurrealClient | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const verdicts = yield* soft("verdicts", listPendingVerdicts(), []);
        const briefs = yield* soft("briefs", scanTaskDir(opts.taskDir ?? defaultTaskDir()), []);
        const churnRows = yield* soft(
            "churn",
            fetchSessionChurnSummary({
                since: new Date(opts.nowMs - opts.days * DAY_MS),
                limit: CHURN_SESSION_LIMIT,
            }).pipe(Effect.map((summary): readonly SessionChurnRow[] => summary.hotSessions)),
            [],
        );
        const open = yield* soft("proposals", listProposals({ status: "open" }), []);
        const tune = yield* soft(
            "routing",
            Effect.gen(function* () {
                const table = yield* loadEffectiveRoutingTable(opts.routingTablePath);
                return yield* fetchTuneProposals({ sinceDays: opts.days, table });
            }),
            [] as TuneProposal[],
        );

        const items: DojoItem[] = [
            ...pendingVerdictItems(verdicts),
            ...briefs,
            ...routingBacktestItems(tune, opts.days),
            ...churnHotspotItems(churnRows),
        ];
        const mint = proposalMintItem(open.length);
        if (mint) items.push(mint);
        return items;
    });
