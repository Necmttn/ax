/**
 * `ax routing` - routing-table operations (the tune side of the cost loop).
 *
 *   ax routing tune [--days=N] [--dry-run] [--emit-brief] [--apply=id,id] [--out=PATH] [--json]
 *     Mine dispatch history for new routing classes. Default: apply non-judgment
 *     proposals to ~/.ax/hooks/routing-table.json (origin: user) and print what
 *     landed; judgment-flagged proposals are listed but never auto-applied.
 *     --dry-run prints proposals only. --emit-brief writes
 *     .ax/tasks/routing-tune-<date>.md for an agent to adversarially backtest.
 *     --apply=ids applies exactly those proposal ids (post-brief).
 *
 *   ax routing compile [--out=PATH] [--json]
 *     Merge-preserving regenerate (same engine as `ax dispatches compile-routing`).
 *
 *   ax routing show [--out=PATH] [--json]
 *     Print the effective table with origins.
 */
import { Effect, FileSystem, Path } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { compileRouting, ROUTING_CLASSES } from "../../queries/dispatch-analytics.ts";
import {
    defaultRoutingTablePath,
    loadEffectiveRoutingTable,
    loadStoredRoutingTable,
    mergeRoutingTables,
} from "../../queries/routing-table-io.ts";
import {
    applyProposals,
    fetchTuneProposals,
    renderTuneBrief,
    type TuneProposal,
} from "../../queries/routing-tune.ts";
import { usd } from "../render.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, optionValue, parseCsvFlag } from "./shared.ts";

const printProposals = (proposals: ReadonlyArray<TuneProposal>) => {
    console.log(
        `${"id".padEnd(28)}  ${"pattern".padEnd(32)}  ${"suggest".padEnd(8)}  ${"count".padStart(5)}  ${"addressable".padStart(11)}  judgment`,
    );
    for (const p of proposals) {
        console.log(
            `${p.id.padEnd(28)}  ${p.pattern.padEnd(32)}  ${p.suggest.padEnd(8)}  ` +
            `${String(p.count).padStart(5)}  ${usd(p.total_cost_usd, 2).padStart(11)}  ${p.judgment ? "YES" : "no"}`,
        );
    }
};

// ---------------------------------------------------------------------------
// ax routing tune
// ---------------------------------------------------------------------------

const tuneCommand = Command.make(
    "tune",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(30)),
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        emitBrief: Flag.boolean("emit-brief").pipe(Flag.withDefault(false)),
        apply: Flag.string("apply").pipe(Flag.optional),
        out: Flag.string("out").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ days, dryRun, emitBrief, apply, out, json }) =>
        Effect.gen(function* () {
            if (!Number.isInteger(days) || days <= 0) {
                fail(`ax routing tune: --days must be a positive integer (got "${days}")`);
            }
            const tablePath = optionValue(out) ?? defaultRoutingTablePath();
            const table = yield* loadEffectiveRoutingTable(tablePath);
            const proposals = yield* fetchTuneProposals({ sinceDays: days, table });

            // Parse --apply before the empty-proposals check: an explicit apply
            // against an empty re-mine must fail loudly, not "keep up" silently.
            const applyRaw = optionValue(apply);
            const ids = applyRaw === undefined ? null : parseCsvFlag(applyRaw);

            if (proposals.length === 0) {
                if (ids !== null) {
                    fail(
                        `ax routing tune: none of the requested ids (${ids.join(", ")}) were re-mined in the last ${days} days - re-run with the --days window the brief was mined with`,
                    );
                }
                if (json) {
                    console.log(prettyPrint({ proposals: [] }));
                    return;
                }
                console.log(
                    `(no unmatched expensive inherit clusters in the last ${days} days - table is keeping up)`,
                );
                return;
            }

            if (dryRun) {
                if (json) {
                    console.log(prettyPrint({ proposals }));
                    return;
                }
                printProposals(proposals);
                console.log(
                    `\n${proposals.length} proposals  addressable spend: ${usd(proposals.reduce((s, p) => s + p.total_cost_usd, 0), 2)}  (${days} days)`,
                );
                console.log(
                    `apply non-judgment: ax routing tune --days=${days}   brief: ax routing tune --emit-brief`,
                );
                return;
            }

            if (emitBrief) {
                const date = new Date().toISOString().slice(0, 10);
                const briefPath = `.ax/tasks/routing-tune-${date}.md`;
                const fs = yield* FileSystem.FileSystem;
                const p = yield* Path.Path;
                yield* fs.makeDirectory(p.dirname(briefPath), { recursive: true }).pipe(Effect.orDie);
                yield* fs.writeFileString(briefPath, renderTuneBrief(proposals, { days, date })).pipe(Effect.orDie);
                if (json) {
                    console.log(prettyPrint({ brief: briefPath, proposals }));
                    return;
                }
                console.log(`brief written: ${briefPath} (${proposals.length} proposals)`);
                console.log(
                    `hand it to your agent; survivors apply with: ax routing tune --days=${days} --apply=<ids>`,
                );
                return;
            }

            const result = yield* applyProposals(tablePath, proposals, { ids });
            if (result.corrupt) {
                fail(
                    `ax routing tune: ${result.path} is unparseable - fix or delete it, then re-run`,
                );
            }
            if (json) {
                console.log(prettyPrint(result));
                return;
            }
            if (result.applied.length > 0) {
                console.log(`applied ${result.applied.length} classes to ${result.path}:`);
                printProposals(result.applied);
            } else {
                console.log("(nothing newly applied)");
            }
            if (result.skipped_existing.length > 0) {
                console.log(
                    `\n${result.skipped_existing.length} already in the table (unchanged): ${result.skipped_existing.map((p) => p.id).join(", ")}`,
                );
            }
            if (result.skipped_judgment.length > 0) {
                console.log(
                    `\nskipped ${result.skipped_judgment.length} judgment-flagged proposals (reviews/design stay on the main model):`,
                );
                printProposals(result.skipped_judgment);
                console.log(`vet them via: ax routing tune --emit-brief`);
            }
            if (result.unknown_ids.length > 0) {
                console.log(
                    `\nwarning: unknown proposal ids ignored: ${result.unknown_ids.join(", ")}`,
                );
            }
        }),
).pipe(
    Command.withDescription(
        "Mine dispatch history for new routing classes and apply them to the routing table. " +
        "--days=N (default 30)  --dry-run  --emit-brief (agent backtest handoff)  --apply=id,id  --out=PATH  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax routing compile
// ---------------------------------------------------------------------------

const compileCommand = Command.make(
    "compile",
    {
        out: Flag.string("out").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ out, json }) =>
        Effect.gen(function* () {
            const result = yield* compileRouting(optionValue(out));
            if (result.corrupt) {
                fail(
                    `ax routing compile: routing-table NOT written: ${result.path} is unparseable - fix or delete it, then re-run`,
                );
            }
            if (json) {
                console.log(prettyPrint(result));
                return;
            }
            console.log(
                result.preserved_user_classes > 0
                    ? `routing-table written: ${result.path} (${result.preserved_user_classes} user classes preserved)`
                    : `routing-table written: ${result.path}`,
            );
        }),
).pipe(
    Command.withDescription(
        "Regenerate the routing table from built-in defaults, preserving origin:user classes " +
        "(alias of `ax dispatches compile-routing`). --out=PATH  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax routing show
// ---------------------------------------------------------------------------

const showCommand = Command.make(
    "show",
    {
        out: Flag.string("out").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ out, json }) =>
        Effect.gen(function* () {
            const tablePath = optionValue(out) ?? defaultRoutingTablePath();
            const stored = yield* loadStoredRoutingTable(tablePath);
            // Re-merge for display: legacy origin-less rows show as "user" -
            // intentional (previews what compile would produce).
            const merged = mergeRoutingTables(ROUTING_CLASSES, stored);
            if (json) {
                console.log(
                    prettyPrint({ path: tablePath, stored: stored !== null, table: merged }),
                );
                return;
            }
            if (stored === null) {
                console.log(
                    `(no ${tablePath} - showing built-in defaults; seed it with: ax routing compile)`,
                );
            }
            console.log(`${"id".padEnd(28)}  ${"pattern".padEnd(40)}  ${"suggest".padEnd(8)}  origin`);
            for (const c of merged.classes) {
                console.log(
                    `${c.id.padEnd(28)}  ${c.pattern.padEnd(40)}  ${c.suggest.padEnd(8)}  ${c.origin}`,
                );
            }
            for (const [agentType, model] of Object.entries(merged.agentTypes)) {
                console.log(
                    `${("agent-type:" + agentType).padEnd(28)}  ${"".padEnd(40)}  ${String(model).padEnd(8)}  default`,
                );
            }
        }),
).pipe(
    Command.withDescription(
        "Print the effective routing table with class origins. --out=PATH  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax routing (group)
// ---------------------------------------------------------------------------

export const routingRootCommand = Command.make("routing").pipe(
    Command.withDescription(
        "Routing-table operations: tune (mine your dispatch history), compile (regenerate defaults), show.",
    ),
    Command.withSubcommands([tuneCommand, compileCommand, showCommand]),
);

export const axRoutingRuntime: RuntimeManifest = {
    routing: {
        runtime: {
            kind: "db-conditional",
            fallback: "db",
            subcommands: {
                tune: "db",
                compile: "none",
                show: "none",
            },
        },
        hidden: false,
    },
};
