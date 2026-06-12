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
    compileRouting,
    compileRoutingSkillMd,
} from "../../queries/dispatch-analytics.ts";
import { loadEffectiveRoutingTable } from "../../queries/routing-table-io.ts";
import { buildDispatchesNext, buildCandidatesNext } from "../../nav/next-links.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, optionValue, positiveLimit } from "./shared.ts";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const usd = (n: number): string =>
    Number.isFinite(n) ? `$${n.toFixed(4)}` : "$0.0000";

const pct = (n: number): string =>
    Number.isFinite(n) ? `${n.toFixed(1)}%` : "0.0%";

const truncate = (s: string | null, len: number): string => {
    if (!s) return "";
    return s.length <= len ? s : `${s.slice(0, len - 1)}…`;
};

// ---------------------------------------------------------------------------
// ax dispatches [--days=N] [--limit=N] [--candidates] [--json]
// ---------------------------------------------------------------------------

const cmdDispatches = (input: {
    readonly sinceDays: number;
    readonly limit: number;
    readonly candidates: boolean;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
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

            // Header
            const descW = 48;
            const modelW = 28;
            console.log(
                `${"ts".padEnd(19)}  ${"agent_type".padEnd(24)}  ${"description".padEnd(descW)}  ` +
                `${"suggest".padEnd(modelW)}  ${"child_cost".padStart(10)}  ${"est_savings".padStart(11)}`,
            );

            for (const row of result.candidates) {
                const ts = row.ts.slice(0, 19);
                const at = truncate(row.agent_type, 24);
                const desc = truncate(row.description, descW);
                const suggest = row.suggested_model.slice(0, modelW);
                console.log(
                    `${ts.padEnd(19)}  ${at.padEnd(24)}  ${desc.padEnd(descW)}  ` +
                    `${suggest.padEnd(modelW)}  ${usd(row.child_cost_usd).padStart(10)}  ` +
                    `${usd(row.est_savings_usd).padStart(11)}`,
                );
            }

            console.log(`\ntotal est savings: ${usd(result.total_est_savings_usd)}`);
            if (result.top_classes.length > 0) {
                const classLine = result.top_classes
                    .map((c) => `${c.classId} (${usd(c.savings_usd)})`)
                    .join(", ");
                console.log(`top classes: ${classLine}`);
            }
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

        const descW = 48;
        const dmW = 16; // dispatch model column
        const cmW = 28; // child model column

        console.log(
            `${"ts".padEnd(19)}  ${"agent_type".padEnd(24)}  ${"description".padEnd(descW)}  ` +
            `${"dispatch_model".padEnd(dmW)}  ${"child_model".padEnd(cmW)}  ${"child_cost".padStart(10)}`,
        );

        for (const row of result.rows) {
            const ts = row.ts.slice(0, 19);
            const at = truncate(row.agent_type, 24);
            const desc = truncate(row.description, descW);
            const dm = row.dispatch_model.slice(0, dmW);
            // "!" marks a routed dispatch whose child ran legs on another model
            // (Claude Code drops the model override on continuations).
            const cm = `${row.model_dropped ? "!" : ""}${row.child_model ?? "?"}`.slice(0, cmW);
            console.log(
                `${ts.padEnd(19)}  ${at.padEnd(24)}  ${desc.padEnd(descW)}  ` +
                `${dm.padEnd(dmW)}  ${cm.padEnd(cmW)}  ${usd(row.child_cost_usd).padStart(10)}`,
            );
        }

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
        json: jsonFlag,
    },
    ({ days, limit, candidates, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax dispatches: --days must be a positive integer (got "${days}")`);
        }
        return cmdDispatches({ sinceDays: days, limit, candidates, json });
    },
).pipe(
    Command.withDescription(
        "Subagent dispatch analytics: table of dispatches sorted by child cost, with dispatch model, child model, cost. " +
        "--days=N (default 14)  --limit=N (default 30)  --candidates (inherit + expensive + routing match)  --json",
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
