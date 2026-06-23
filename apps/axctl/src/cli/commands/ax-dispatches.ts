/**
 * `ax dispatches` - subagent dispatch analytics.
 *
 * Subcommands:
 *   ax dispatches [--days=N] [--limit=N] [--json]
 *     Table of dispatches sorted by child cost desc. Summary: count, % inherit,
 *     total subagent cost.
 *
 *   ax dispatches --candidates [--days=N] [--json]
 *     Dispatches where model=inherit, child model is expensive (fable/opus),
 *     and description/agentType matches a routing class. Shows suggested model
 *     + est savings. Footer: total est savings, top 3 classes by savings.
 *
 *   ax dispatches --economy [--days=N] [--json]
 *     Spend-mode-aware measurement lens: of the inherit dispatches matching a
 *     route-down class, how many ran cheap (sonnet/haiku) vs expensive (fable/
 *     opus)? Plus the route-dispatch Advise hook-fire count (unlinked).
 *     By-class breakdown sorted by overspend. Advice→outcome attribution is
 *     deferred (no clean join - PreToolUse fires before the child session id
 *     exists).
 *
 *   ax dispatches compile-routing [--out=PATH] [--json]
 *     Write ~/.ax/hooks/routing-table.json from ROUTING_CLASSES. Idempotent
 *     regenerate. --out overrides the default path (tests use tmp dirs).
 *     ONLY write operation - to filesystem, not DB.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { printNextLinks } from "../next-format.ts";
import {
    fetchDispatches,
    fetchDispatchCandidates,
    fetchDispatchEconomy,
    compileRouting,
    compileRoutingSkillMd,
} from "../../queries/dispatch-analytics.ts";
import { fetchAdviceLedger } from "../../queries/advice-ledger.ts";
import { loadEffectiveRoutingTable } from "../../queries/routing-table-io.ts";
import { buildDispatchesNext, buildCandidatesNext } from "../../nav/next-links.ts";
import { pct, usd } from "../render.ts";
import { renderTable } from "../table.js";
import type { Column } from "../table.js";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, optionValue, positiveLimit } from "./shared.ts";

// ---------------------------------------------------------------------------
// ax dispatches [--days=N] [--limit=N] [--candidates] [--economy] [--json]
// ---------------------------------------------------------------------------

const cmdDispatches = (input: {
    readonly sinceDays: number;
    readonly limit: number;
    readonly candidates: boolean;
    readonly economy: boolean;
    readonly advice: boolean;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        if (input.economy) {
            const table = yield* loadEffectiveRoutingTable();
            const result = yield* fetchDispatchEconomy({ sinceDays: input.sinceDays, table });

            if (input.json) {
                console.log(prettyPrint(result));
                return;
            }

            // Economy summary header
            console.log(`dispatch economy lens  (${input.sinceDays} days)\n`);

            if (result.total_routable === 0) {
                console.log("(no routable inherit dispatches in the requested window)");
                console.log("  tip: widen with --days=30 or run ax dispatches --candidates to see per-dispatch view");
                return;
            }

            // Totals summary
            const cheapPct = result.total_routable > 0
                ? ((result.ran_cheap / result.total_routable) * 100).toFixed(1)
                : "0.0";
            const expensivePct = result.total_routable > 0
                ? ((result.ran_expensive / result.total_routable) * 100).toFixed(1)
                : "0.0";

            console.log(`routable inherit dispatches: ${result.total_routable}`);
            console.log(`  ran cheap    (sonnet/haiku): ${result.ran_cheap.toString().padStart(4)}  (${cheapPct}%)`);
            console.log(`  ran expensive (fable/opus):  ${result.ran_expensive.toString().padStart(4)}  (${expensivePct}%)  ← addressable overspend`);
            console.log(`\noverspend cost: ${usd(result.overspend_usd)}  est savings if re-routed: ${usd(result.total_est_savings_usd)}`);

            if (result.advise_fires_available) {
                console.log(`route-dispatch Advise fires: ${result.advise_fires}  (advice→outcome attribution deferred - no clean join)`);
            } else {
                console.log(`route-dispatch Advise fires: (no hook_command_invocation rows in window)`);
            }

            // By-class table
            if (result.by_class.length > 0) {
                console.log("");

                type EconRow = {
                    classId: string;
                    count: string;
                    ran_cheap: string;
                    ran_expensive: string;
                    overspend: string;
                    est_savings: string;
                };

                const econRows: EconRow[] = result.by_class.map((row) => ({
                    classId: row.classId,
                    count: row.count.toString(),
                    ran_cheap: row.ran_cheap.toString(),
                    ran_expensive: row.ran_expensive.toString(),
                    overspend: usd(row.overspend_usd),
                    est_savings: usd(row.est_savings_usd),
                }));

                const econCols: Column<EconRow>[] = [
                    { header: "class", get: (r) => r.classId, width: 28, overflow: "ellipsis" },
                    { header: "total", get: (r) => r.count, align: "right", width: 6 },
                    { header: "cheap", get: (r) => r.ran_cheap, align: "right", width: 6 },
                    { header: "expensive", get: (r) => r.ran_expensive, align: "right", width: 9 },
                    { header: "overspend", get: (r) => r.overspend, align: "right", width: 10 },
                    { header: "est_savings", get: (r) => r.est_savings, align: "right", width: 11 },
                ];

                console.log(renderTable({ columns: econCols, rows: econRows }));
            }

            console.log(`\ntip: ax dispatches --candidates  for per-dispatch view of the expensive-tier rows`);
            return;
        }

        if (input.candidates) {
            const table = yield* loadEffectiveRoutingTable();
            const result = yield* fetchDispatchCandidates({ sinceDays: input.sinceDays, table });

            if (input.json) {
                console.log(prettyPrint(result));
                return;
            }

            if (result.candidates.length === 0) {
                console.log("(no routing candidates in the requested window)");
                return;
            }

            printNextLinks(buildCandidatesNext(result));

            type CandRow = {
                ts: string;
                agent_type: string;
                description: string;
                suggest: string;
                child_cost: string;
                est_savings: string;
            };

            const candRows: CandRow[] = result.candidates.map((row) => ({
                ts: row.ts,
                agent_type: row.agent_type ?? "",
                description: row.description ?? "",
                suggest: row.suggested_model,
                child_cost: usd(row.child_cost_usd),
                est_savings: usd(row.est_savings_usd),
            }));

            const candCols: Column<CandRow>[] = [
                { header: "ts", get: (r) => r.ts, width: 19, overflow: "clip" },
                { header: "agent_type", get: (r) => r.agent_type, width: 24, overflow: "ellipsis" },
                { header: "description", get: (r) => r.description, width: 48, overflow: "ellipsis" },
                { header: "suggest", get: (r) => r.suggest, width: 28, overflow: "clip" },
                { header: "child_cost", get: (r) => r.child_cost, align: "right", width: 10 },
                { header: "est_savings", get: (r) => r.est_savings, align: "right", width: 11 },
            ];

            console.log(renderTable({ columns: candCols, rows: candRows }));

            console.log(`\ntotal est savings: ${usd(result.total_est_savings_usd)}`);
            if (result.top_classes.length > 0) {
                const classLine = result.top_classes
                    .map((c) => `${c.classId} (${usd(c.savings_usd)})`)
                    .join(", ");
                console.log(`top classes: ${classLine}`);
            }
            return;
        }

        if (input.advice) {
            const result = yield* fetchAdviceLedger({ sinceDays: input.sinceDays, limit: input.limit });

            if (input.json) {
                console.log(prettyPrint(result));
                return;
            }

            const s = result.summary;
            console.log(`route advice -> outcome  (${input.sinceDays} days)\n`);
            if (s.advised === 0) {
                console.log("(no advise rows in the window - the advice ledger lights up as ~/.ax/hooks/advise-log.jsonl fills)");
                console.log("ensure the tap is wired: bun ~/.ax/hooks/advise-tap.ts <hook> in the PreToolUse[Agent] command.");
                return;
            }

            type AdvRow = { ts: string; description: string; suggested: string; child: string; followed: string };
            const advRows: AdvRow[] = result.rows.slice(0, input.limit).map((r) => ({
                ts: r.ts.slice(0, 19),
                description: r.description ?? "",
                suggested: r.suggested_model ?? "",
                child: r.child_model ?? "(unmatched)",
                followed: r.followed === null ? "-" : r.followed ? "yes" : "NO",
            }));
            const advCols: Column<AdvRow>[] = [
                { header: "ts", get: (r) => r.ts, width: 19, overflow: "clip" },
                { header: "description", get: (r) => r.description, width: 44, overflow: "ellipsis" },
                { header: "suggested", get: (r) => r.suggested, width: 10, overflow: "clip" },
                { header: "child_model", get: (r) => r.child, width: 26, overflow: "ellipsis" },
                { header: "followed", get: (r) => r.followed, align: "right", width: 8 },
            ];
            console.log(renderTable({ columns: advCols, rows: advRows }));

            console.log(
                `\nadvised ${s.advised}  matched ${s.matched}  followed ${s.followed}  not-followed ${s.notFollowed}  unmatched ${s.unmatched}`,
            );
            console.log(`follow-through: ${pct(s.followThroughPct / 100)} (of judgeable matches)`);
            console.log(`note: advice text lives ONLY in ~/.ax/hooks/advise-log.jsonl - CC never logs PreToolUse additionalContext.`);
            return;
        }

        // Default: full dispatch table
        const result = yield* fetchDispatches({ sinceDays: input.sinceDays, limit: input.limit });

        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }

        if (result.rows.length === 0) {
            console.log("(no dispatches in the requested window)");
            return;
        }

        printNextLinks(buildDispatchesNext(result));

        type DispatchRow = {
            ts: string;
            agent_type: string;
            description: string;
            dispatch_model: string;
            child_model: string;
            child_cost: string;
        };

        const dispRows: DispatchRow[] = result.rows.map((row) => ({
            ts: row.ts,
            agent_type: row.agent_type ?? "",
            description: row.description ?? "",
            dispatch_model: row.dispatch_model,
            // "!" marks a routed dispatch whose child ran legs on another model
            // (Claude Code drops the model override on continuations).
            child_model: `${row.model_dropped ? "!" : ""}${row.child_model ?? "?"}`,
            child_cost: usd(row.child_cost_usd),
        }));

        const dispCols: Column<DispatchRow>[] = [
            { header: "ts", get: (r) => r.ts, width: 19, overflow: "clip" },
            { header: "agent_type", get: (r) => r.agent_type, width: 24, overflow: "ellipsis" },
            { header: "description", get: (r) => r.description, width: 48, overflow: "ellipsis" },
            { header: "dispatch_model", get: (r) => r.dispatch_model, width: 16, overflow: "clip" },
            { header: "child_model", get: (r) => r.child_model, width: 28, overflow: "clip" },
            { header: "child_cost", get: (r) => r.child_cost, align: "right", width: 10 },
        ];

        console.log(renderTable({ columns: dispCols, rows: dispRows }));

        console.log(
            `\n${result.total_dispatches} dispatches  ${pct(result.inherit_pct)} inherit  ` +
            `total subagent cost: ${usd(result.total_child_cost_usd)}  (${input.sinceDays} days)`,
        );
        if (result.dropped_count > 0) {
            console.log(
                `model drops: ${result.dropped_count} routed dispatches continued on a different model ` +
                `(${usd(result.dropped_cost_usd)} on dropped legs, marked "!")  - the harness drops the ` +
                `model override on SendMessage/compact continuations`,
            );
        }
    });

const dispatchesMainCommand = Command.make(
    "dispatches",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(14)),
        limit: positiveLimit(30),
        candidates: Flag.boolean("candidates").pipe(Flag.withDefault(false)),
        economy: Flag.boolean("economy").pipe(Flag.withDefault(false)),
        advice: Flag.boolean("advice").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ days, limit, candidates, economy, advice, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax dispatches: --days must be a positive integer (got "${days}")`);
        }
        return cmdDispatches({ sinceDays: days, limit, candidates, economy, advice, json });
    },
).pipe(
    Command.withDescription(
        "Subagent dispatch analytics: table of dispatches sorted by child cost, with dispatch model, child model, cost. " +
        "--days=N (default 14)  --limit=N (default 30)  --candidates (inherit + expensive + routing match)  " +
        "--economy (spend-mode effectiveness lens: cheap vs expensive for routable dispatches + Advise fire count)  " +
        "--advice (route advice -> dispatch outcome: did advised dispatches run the suggested cheaper model?)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax dispatches compile-routing [--out=PATH] [--json]
// ---------------------------------------------------------------------------

const compileRoutingCommand = Command.make(
    "compile-routing",
    {
        out: Flag.string("out").pipe(Flag.optional),
        skillMd: Flag.string("skill-md").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ out, skillMd, json }) => Effect.gen(function* () {
        const skillPath = optionValue(skillMd);
        if (skillPath !== undefined) {
            const result = yield* compileRoutingSkillMd(skillPath);
            if (result.error) {
                fail(`compile-routing --skill-md: ${result.error} in ${result.path}`);
            }
            if (json) {
                console.log(prettyPrint(result));
            } else {
                console.log(result.written
                    ? `skill routing table regenerated: ${result.path}`
                    : `skill routing table already current: ${result.path}`);
            }
            return;
        }
        const outPath = optionValue(out);
        const result = yield* compileRouting(outPath);
        if (result.corrupt) {
            fail(`routing-table NOT written: ${result.path} is unparseable - fix or delete it, then re-run`);
        }
        if (json) {
            console.log(prettyPrint(result));
        } else {
            console.log(
                result.preserved_user_classes > 0
                    ? `routing-table written: ${result.path} (${result.preserved_user_classes} user classes preserved)`
                    : `routing-table written: ${result.path}`,
            );
        }
    }),
).pipe(
    Command.withDescription(
        "Write ~/.ax/hooks/routing-table.json from the built-in ROUTING_CLASSES constant, " +
        "preserving origin:user classes (alias of `ax routing compile`). " +
        "Idempotent regenerate. --out=PATH overrides default path. " +
        "--skill-md=PATH instead regenerates the ax:routing-table section of a skill markdown. --json",
    ),
);

// ---------------------------------------------------------------------------
// ax dispatches (group)
// ---------------------------------------------------------------------------

export const dispatchesCommand = Command.make("dispatches").pipe(
    Command.withDescription(
        "Subagent dispatch analytics + routing optimisation. Sub-commands: compile-routing",
    ),
    Command.withSubcommands([compileRoutingCommand]),
);

// Attach flags directly to the group command so `ax dispatches` works without
// a subcommand. We re-declare the main handler on the group command itself
// via Command.make with flags, then add subcommands.
//
// Effect CLI v4 groups need a parent command to hold subcommands. The actual
// dispatch table view lives on the parent command itself (not a subcommand).
// We achieve this by making `dispatchesMainCommand` the parent and hanging
// `compile-routing` off it.
export const dispatchesRootCommand = dispatchesMainCommand.pipe(
    Command.withSubcommands([compileRoutingCommand]),
);

export const axDispatchesRuntime: RuntimeManifest = {
    dispatches: {
        runtime: {
            kind: "db-conditional",
            fallback: "db",
            subcommands: {
                "compile-routing": "none",
            },
        },
        hidden: false,
    },
};
