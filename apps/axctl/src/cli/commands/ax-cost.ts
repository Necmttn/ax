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
import { renderTable } from "../table.js";
import type { Column, FooterLine } from "../table.js";
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

        type ModelRow = {
            model: string;
            sessions: string;
            prompt: string;
            completion: string;
            cache_read: string;
            cache_create: string;
            cost: string;
        };

        const rendered: ModelRow[] = result.rows.map((r) => ({
            model: r.model,
            sessions: integer(r.sessions),
            prompt: integer(r.prompt_tokens),
            completion: integer(r.completion_tokens),
            cache_read: integer(r.cache_read_tokens),
            cache_create: integer(r.cache_create_tokens),
            cost: usd(r.cost_usd),
        }));

        const cols: Column<ModelRow>[] = [
            { header: "model", get: (r) => r.model, min: 20 },
            { header: "sessions", get: (r) => r.sessions, align: "right", width: 8 },
            { header: "prompt", get: (r) => r.prompt, align: "right", width: 14 },
            { header: "completion", get: (r) => r.completion, align: "right", width: 14 },
            { header: "cache_read", get: (r) => r.cache_read, align: "right", width: 12 },
            { header: "cache_create", get: (r) => r.cache_create, align: "right", width: 12 },
            { header: "cost", get: (r) => r.cost, align: "right", width: 10 },
        ];

        console.log(renderTable({ columns: cols, rows: rendered, gap: " " }));
        console.log(`\ntotal: ${usd(result.total_cost_usd)}  (${input.sinceDays} days)`);
    });

const costModelsCommand = Command.make(
    "models",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(14)),
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

        type SessionRow = {
            session: string;
            project: string;
            model: string;
            started: string;
            cost: string;
            completion: string;
            cache_read: string;
        };

        const rendered: SessionRow[] = result.rows.map((r) => ({
            // Strip "session:" prefix and optional SurrealDB backtick wrapping (`uuid`)
            session: r.session_id.replace(/^session:/, "").replace(/^`(.*)`$/, "$1"),
            project: r.project ?? "",
            model: r.model ?? "?",
            started: r.started_at ?? "",
            cost: usd(r.cost_usd),
            completion: integer(r.completion_tokens),
            cache_read: integer(r.cache_read_tokens),
        }));

        const cols: Column<SessionRow>[] = [
            { header: "session", get: (r) => r.session, width: 36 },
            { header: "project", get: (r) => r.project, width: 24, overflow: "clip" },
            { header: "model", get: (r) => r.model, width: 28, overflow: "clip" },
            { header: "started", get: (r) => r.started, width: 19, overflow: "clip" },
            { header: "cost", get: (r) => r.cost, align: "right", width: 10 },
            { header: "completion", get: (r) => r.completion, align: "right", width: 12 },
            { header: "cache_read", get: (r) => r.cache_read, align: "right", width: 12 },
        ];

        console.log(renderTable({ columns: cols, rows: rendered, gap: " " }));
    });

const costSessionsCommand = Command.make(
    "sessions",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(14)),
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

        type SplitRow = {
            origin: string;
            model: string;
            sessions: string;
            prompt: string;
            completion: string;
            cost: string;
            share: string;
        };

        const rendered: SplitRow[] = result.rows.map((r) => ({
            origin: r.origin,
            model: r.model,
            sessions: integer(r.sessions),
            prompt: integer(r.prompt_tokens),
            completion: integer(r.completion_tokens),
            cost: usd(r.cost_usd),
            share: pct(r.share_pct),
        }));

        const t = result.totals;
        const footer: FooterLine[] = [
            {
                cells: [
                    "TOTAL",
                    null,
                    integer(t.sessions),
                    integer(t.prompt_tokens),
                    integer(t.completion_tokens),
                    usd(t.cost_usd),
                    "100.0%",
                ],
            },
        ];

        const modelW = Math.max(20, ...result.rows.map((r) => r.model.length));

        const cols: Column<SplitRow>[] = [
            { header: "origin", get: (r) => r.origin, width: 8 },
            { header: "model", get: (r) => r.model, min: modelW },
            { header: "sessions", get: (r) => r.sessions, align: "right", width: 8 },
            { header: "prompt", get: (r) => r.prompt, align: "right", width: 14 },
            { header: "completion", get: (r) => r.completion, align: "right", width: 14 },
            { header: "cost", get: (r) => r.cost, align: "right", width: 10, footerRule: true },
            { header: "share", get: (r) => r.share, align: "right", width: 7, footerRule: true },
        ];

        console.log(renderTable({ columns: cols, rows: rendered, gap: " ", footer }));
        console.log(`\n(${input.sinceDays} days)`);
    });

const costSplitCommand = Command.make(
    "split",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(14)),
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
