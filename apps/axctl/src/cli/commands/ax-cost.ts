/**
 * `ax cost models / sessions / split` - model/cost analytics.
 *
 * All three subcommands are read-only, use the `db` runtime, and mirror
 * the pattern from commands/costs.ts and commands/skills.ts.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { printNextLinks } from "../next-format.ts";
import {
    COST_DEFAULT_WINDOW_DAYS,
    fetchCostModels,
    fetchCostSessions,
    fetchCostSplit,
} from "../../queries/cost-analytics.ts";
import { fetchRoutability, type RoutabilityResult } from "../../queries/routability.ts";
import {
    buildCostModelsNext,
    buildCostSplitNext,
} from "../../nav/next-links.ts";
import { integer, pct, usd } from "../render.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, optionValue, positiveLimit } from "./shared.ts";

// ---------------------------------------------------------------------------
// ax cost models [--days=N] [--json]
// ---------------------------------------------------------------------------

const cmdCostModels = (input: {
    readonly sinceDays: number;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const result = yield* fetchCostModels({ sinceDays: input.sinceDays });

        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }

        if (result.rows.length === 0) {
            console.log("(no session token usage in the requested window)");
            return;
        }

        printNextLinks(buildCostModelsNext(result));

        const colWidths = {
            model: Math.max(20, ...result.rows.map((r) => r.model.length)),
        };

        console.log(
            `${"model".padEnd(colWidths.model)}  ${"sessions".padStart(8)}  ${"prompt".padStart(14)}  ${"completion".padStart(14)}  ${"cache_read".padStart(12)}  ${"cache_create".padStart(12)}  ${"cost".padStart(10)}`,
        );
        for (const row of result.rows) {
            console.log(
                `${row.model.padEnd(colWidths.model)}  ` +
                `${integer(row.sessions).padStart(8)}  ` +
                `${integer(row.prompt_tokens).padStart(14)}  ` +
                `${integer(row.completion_tokens).padStart(14)}  ` +
                `${integer(row.cache_read_tokens).padStart(12)}  ` +
                `${integer(row.cache_create_tokens).padStart(12)}  ` +
                `${usd(row.cost_usd).padStart(10)}`,
            );
        }
        console.log(`\ntotal: ${usd(result.total_cost_usd)}  (${input.sinceDays} days)`);
    });

const costModelsCommand = Command.make(
    "models",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(COST_DEFAULT_WINDOW_DAYS)),
        json: jsonFlag,
    },
    ({ days, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax cost models: --days must be a positive integer (got "${days}")`);
        }
        return cmdCostModels({ sinceDays: days, json });
    },
).pipe(
    Command.withDescription(
        "Per-model rollup: sessions, prompt/completion/cache tokens, estimated cost. " +
        "--days=N (default 14)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax cost sessions [--days=N] [--model=<name>] [--limit=N] [--json]
// ---------------------------------------------------------------------------

const cmdCostSessions = (input: {
    readonly sinceDays: number;
    readonly limit: number;
    readonly model: string | null;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const result = yield* fetchCostSessions({
            sinceDays: input.sinceDays,
            limit: input.limit,
            model: input.model,
        });

        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }

        if (result.rows.length === 0) {
            console.log("(no priced sessions in the requested window)");
            return;
        }

        console.log(
            `${"session".padEnd(36)}  ${"project".padEnd(24)}  ${"model".padEnd(28)}  ${"started".padEnd(19)}  ${"cost".padStart(10)}  ${"completion".padStart(12)}  ${"cache_read".padStart(12)}`,
        );
        for (const row of result.rows) {
            // Strip "session:" prefix and optional SurrealDB backtick wrapping (`uuid`)
            const sid = row.session_id.replace(/^session:/, "").replace(/^`(.*)`$/, "$1").slice(0, 36);
            const proj = (row.project ?? "").slice(0, 24);
            const mdl = (row.model ?? "?").slice(0, 28);
            const ts = (row.started_at ?? "").slice(0, 19);
            console.log(
                `${sid.padEnd(36)}  ` +
                `${proj.padEnd(24)}  ` +
                `${mdl.padEnd(28)}  ` +
                `${ts.padEnd(19)}  ` +
                `${usd(row.cost_usd).padStart(10)}  ` +
                `${integer(row.completion_tokens).padStart(12)}  ` +
                `${integer(row.cache_read_tokens).padStart(12)}`,
            );
        }
    });

const costSessionsCommand = Command.make(
    "sessions",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(COST_DEFAULT_WINDOW_DAYS)),
        model: Flag.string("model").pipe(Flag.optional),
        limit: positiveLimit(20),
        json: jsonFlag,
    },
    ({ days, model, limit, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax cost sessions: --days must be a positive integer (got "${days}")`);
        }
        return cmdCostSessions({
            sinceDays: days,
            limit,
            model: optionValue(model) ?? null,
            json,
        });
    },
).pipe(
    Command.withDescription(
        "Top sessions by estimated cost: id, project, model, started_at, cost, completion tokens, cache-read tokens. " +
        "--days=N (default 14)  --model=<name>  --limit=N (default 20)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax cost split [--days=N] [--json]
// ---------------------------------------------------------------------------

const cmdCostSplit = (input: {
    readonly sinceDays: number;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const result = yield* fetchCostSplit({ sinceDays: input.sinceDays });

        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }

        if (result.totals.cost_usd === 0) {
            console.log("(no cost data in the requested window)");
            return;
        }

        printNextLinks(buildCostSplitNext(result));

        const colWidths = {
            origin: 8,
            model: Math.max(20, ...result.rows.map((r) => r.model.length)),
        };

        console.log(
            `${"origin".padEnd(colWidths.origin)}  ${"model".padEnd(colWidths.model)}  ${"sessions".padStart(8)}  ${"prompt".padStart(14)}  ${"completion".padStart(14)}  ${"cost".padStart(10)}  ${"share".padStart(7)}`,
        );
        for (const row of result.rows) {
            console.log(
                `${row.origin.padEnd(colWidths.origin)}  ` +
                `${row.model.padEnd(colWidths.model)}  ` +
                `${integer(row.sessions).padStart(8)}  ` +
                `${integer(row.prompt_tokens).padStart(14)}  ` +
                `${integer(row.completion_tokens).padStart(14)}  ` +
                `${usd(row.cost_usd).padStart(10)}  ` +
                `${pct(row.share_pct).padStart(7)}`,
        );
        }

        // Totals row
        const t = result.totals;
        const totalLabel = "TOTAL";
        console.log(
            `\n${"".padEnd(colWidths.origin)}  ${"".padEnd(colWidths.model)}  ` +
            `${"".padStart(8)}  ${"".padStart(14)}  ${"".padStart(14)}  ` +
            `${"─".repeat(10)}  ${"─".repeat(7)}`,
        );
        console.log(
            `${totalLabel.padEnd(colWidths.origin)}  ${"".padEnd(colWidths.model)}  ` +
            `${integer(t.sessions).padStart(8)}  ` +
            `${integer(t.prompt_tokens).padStart(14)}  ` +
            `${integer(t.completion_tokens).padStart(14)}  ` +
            `${usd(t.cost_usd).padStart(10)}  ` +
            `${"100.0%".padStart(7)}`,
        );
        console.log(`\n(${input.sinceDays} days)`);
    });

const costSplitCommand = Command.make(
    "split",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(COST_DEFAULT_WINDOW_DAYS)),
        json: jsonFlag,
    },
    ({ days, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax cost split: --days must be a positive integer (got "${days}")`);
        }
        return cmdCostSplit({ sinceDays: days, json });
    },
).pipe(
    Command.withDescription(
        "Cost matrix: origin (main vs subagent) x model with cost, tokens, and share-of-total. " +
        "--days=N (default 14)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax cost routability [--days=N] [--min-run=N] [--json]
// ---------------------------------------------------------------------------

function renderRoutability(r: RoutabilityResult): string {
    const usdFmt = (n: number) => `$${n.toFixed(2)}`;
    const out: string[] = [];
    out.push(`main-agent spend: ${usdFmt(r.mainSpendUsd)}   routable: ${usdFmt(r.routableUsd)} (${r.routablePct.toFixed(0)}%)   est. savings: ${usdFmt(r.estSavingsUsd)}`);
    out.push("");
    out.push("class            runs   turns   main_cost    tier     repriced    est_savings");
    for (const row of r.rows) {
        if (row.verdict === "stays") {
            out.push(`${"stays main".padEnd(15)} ${String(row.runs).padStart(5)}  ${String(row.turns).padStart(6)}  ${usdFmt(row.mainCostUsd).padStart(10)}   ${"-".padEnd(7)} ${"-".padStart(10)}  ${"-".padStart(11)}`);
        } else {
            out.push(`${row.class.padEnd(15)} ${String(row.runs).padStart(5)}  ${String(row.turns).padStart(6)}  ${usdFmt(row.mainCostUsd).padStart(10)}   ${(row.tier ?? "").padEnd(7)} ${usdFmt(row.repricedUsd ?? 0).padStart(10)}  ${usdFmt(row.estSavingsUsd ?? 0).padStart(11)}`);
        }
    }
    out.push("");
    out.push("estimate: edit/read turns are assumed mechanically routable; reasoning before an");
    out.push("edit isn't visible in the transcript, so read this as an upper-ish bound, not ground");
    out.push("truth. judgment-text turns stay on frontier by design. claude main-agent only.");
    out.push("next: ax dispatches --candidates   # the subagent-side leak");
    return out.join("\n");
}

const cmdCostRoutability = (input: {
    readonly days: number;
    readonly minRun: number;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const result = yield* fetchRoutability({ days: input.days, minRun: input.minRun });

        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }

        console.log(renderRoutability(result));
    });

const costRoutabilityCommand = Command.make(
    "routability",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(30)),
        minRun: Flag.integer("min-run").pipe(Flag.withDefault(1)),
        json: jsonFlag,
    },
    ({ days, minRun, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax cost routability: --days must be a positive integer (got "${days}")`);
        }
        if (!Number.isInteger(minRun) || minRun <= 0) {
            fail(`ax cost routability: --min-run must be a positive integer (got "${minRun}")`);
        }
        return cmdCostRoutability({ days, minRun, json });
    },
).pipe(
    Command.withDescription(
        "Estimate how much main-agent spend was routable to a cheaper subagent. " +
        "--days=N (default 30)  --min-run=N (default 1)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax cost (group command)
// ---------------------------------------------------------------------------

export const costCommand = Command.make("cost").pipe(
    Command.withDescription(
        "Model/cost analytics: per-model rollup, top sessions, main-vs-subagent split",
    ),
    Command.withSubcommands([
        costModelsCommand,
        costSessionsCommand,
        costSplitCommand,
        costRoutabilityCommand,
    ]),
);

export const axCostRuntime: RuntimeManifest = {
    cost: "db",
};
