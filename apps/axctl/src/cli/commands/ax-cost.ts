/**
 * `ax cost models / sessions / split / images` - model/cost analytics.
 *
 * All subcommands are read-only, use the `db` runtime, and mirror the
 * pattern from commands/costs.ts and commands/skills.ts.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { printNextLinks } from "../next-format.ts";
import {
    COST_DEFAULT_WINDOW_DAYS,
    fetchCostModels,
    fetchCostSessions,
    fetchCostSplit,
    type CostModelsResult,
    type CostSessionsResult,
    type CostSplitResult,
} from "../../queries/cost-analytics.ts";
import { fetchRoutability, type RoutabilityResult } from "../../queries/routability.ts";
import { fetchImageContext } from "../../queries/image-context.ts";
import { fetchAttributionCost, type AttributionRow } from "../../queries/attribution-cost.ts";
import { fetchCacheBustCost, relativeCostDelta, type CacheBustOffenderRow } from "../../queries/cache-bust.ts";
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

export function renderCostModelsTable(result: CostModelsResult): string {
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
        cost: r.unpriced ? "UNPRICED" : usd(r.cost_usd),
    }));

    const cols: Column<ModelRow>[] = [
        { header: "model", get: (r) => r.model, min: 20 },
        { header: "sessions", get: (r) => r.sessions, align: "right", min: 8 },
        { header: "prompt", get: (r) => r.prompt, align: "right", min: 14 },
        { header: "completion", get: (r) => r.completion, align: "right", min: 14 },
        { header: "cache_read", get: (r) => r.cache_read, align: "right", min: 12 },
        { header: "cache_create", get: (r) => r.cache_create, align: "right", min: 12 },
        { header: "cost", get: (r) => r.cost, align: "right", min: 10 },
    ];

    return renderTable({ columns: cols, rows: rendered, gap: " " });
}

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
        console.log(renderCostModelsTable(result));
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

// Legend spelling out the money/token columns so the numbers are never
// ambiguous when the wide table wraps (or when a row is copy-pasted without
// the header). Survives wrap because it is its own line.
export const COST_SESSIONS_LEGEND =
    "cols: cost = est. USD · out_tok = output (completion) tokens · cache_tok = cache-hit (read input) tokens";

export function renderCostSessionsTable(result: CostSessionsResult): string {
    type SessionRow = {
        session: string;
        project: string;
        model: string;
        started: string;
        cost: string;
        out_tok: string;
        cache_tok: string;
    };

    const rendered: SessionRow[] = result.rows.map((r) => ({
        // Strip "session:" prefix and any backtick-wrapped id, if present
        session: r.session_id.replace(/^session:/, "").replace(/^`(.*)`$/, "$1"),
        project: r.project ?? "",
        model: r.model ?? "?",
        started: r.started_at ?? "",
        cost: usd(r.cost_usd),
        out_tok: integer(r.completion_tokens),
        cache_tok: integer(r.cache_read_tokens),
    }));

    const cols: Column<SessionRow>[] = [
        { header: "session", get: (r) => r.session, width: 36 },
        { header: "project", get: (r) => r.project, width: 24, overflow: "clip" },
        { header: "model", get: (r) => r.model, width: 28, overflow: "clip" },
        { header: "started", get: (r) => r.started, width: 19, overflow: "clip" },
        { header: "cost", get: (r) => r.cost, align: "right", width: 10 },
        { header: "out_tok", get: (r) => r.out_tok, align: "right", width: 12 },
        { header: "cache_tok", get: (r) => r.cache_tok, align: "right", width: 14 },
    ];

    return renderTable({ columns: cols, rows: rendered, gap: " " });
}

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

        console.log(renderCostSessionsTable(result));
        console.log(`\n${COST_SESSIONS_LEGEND}`);
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
        "Top sessions by estimated cost: session, project, model, started, cost (USD), out_tok (output tokens), cache_tok (cache-hit tokens). " +
        "--days=N (default 14)  --model=<name>  --limit=N (default 20)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax cost split [--days=N] [--json]
// ---------------------------------------------------------------------------

export function renderCostSplitTable(result: CostSplitResult): string {
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
        cost: r.unpriced ? "UNPRICED" : usd(r.cost_usd),
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

    return renderTable({ columns: cols, rows: rendered, gap: " ", footer });
}

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

        if (result.rows.length === 0) {
            console.log("(no cost data in the requested window)");
            return;
        }

        printNextLinks(buildCostSplitNext(result));
        console.log(renderCostSplitTable(result));
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

const usdFmt = (n: number) => `$${n.toFixed(2)}`;

/** One provider's summary line + per-class table. */
function renderRoutabilityProvider(r: RoutabilityResult, label: string): string[] {
    const out: string[] = [];
    // Inline the reason a provider shows 0% - otherwise a Codex row reading
    // "0% / $0" looks broken rather than "not classified yet" (#1031).
    const zeroReason = r.routablePct === 0 && r.mainSpendUsd > 0 ? "   (no routing classes matched yet)" : "";
    out.push(`[${label}] main-agent spend: ${usdFmt(r.mainSpendUsd)}   routable: ${usdFmt(r.routableUsd)} (${r.routablePct.toFixed(0)}%)   est. savings: ${usdFmt(r.estSavingsUsd)}${zeroReason}`);
    out.push("class            runs   turns   main_cost    tier         repriced    est_savings");
    for (const row of r.rows) {
        if (row.verdict === "stays") {
            out.push(`${"stays main".padEnd(15)} ${String(row.runs).padStart(5)}  ${String(row.turns).padStart(6)}  ${usdFmt(row.mainCostUsd).padStart(10)}   ${"-".padEnd(11)} ${"-".padStart(10)}  ${"-".padStart(11)}`);
        } else {
            out.push(`${row.class.padEnd(15)} ${String(row.runs).padStart(5)}  ${String(row.turns).padStart(6)}  ${usdFmt(row.mainCostUsd).padStart(10)}   ${(row.tier ?? "").padEnd(11)} ${usdFmt(row.repricedUsd ?? 0).padStart(10)}  ${usdFmt(row.estSavingsUsd ?? 0).padStart(11)}`);
        }
    }
    return out;
}

function renderRoutability(r: RoutabilityResult): string {
    const out: string[] = [];
    const providers = r.providers.length > 0 ? r.providers : [r];

    if (providers.length > 1) {
        out.push(`total main-agent spend: ${usdFmt(r.mainSpendUsd)}   routable: ${usdFmt(r.routableUsd)} (${r.routablePct.toFixed(0)}%)   est. savings: ${usdFmt(r.estSavingsUsd)}`);
        out.push("");
    }
    for (const p of providers) {
        out.push(...renderRoutabilityProvider(p, p.provider));
        out.push("");
    }
    out.push("estimate: edit/read turns are assumed mechanically routable; thinking before an");
    out.push("edit is stripped from the transcript, so read this as an upper-ish bound, not ground");
    out.push("truth. judgment-text turns stay on frontier, and edits riding behind a judgment");
    out.push("prose turn in the same message are carried with it. claude + codex main-agent.");
    out.push("codex exec_command is split read/write via command_norm; ambiguous norms stay on main.");
    out.push("this is MAIN-agent spend; `ax dispatches --candidates` is the subagent-dispatch pool -");
    out.push("a separate, non-overlapping set of spend, so the two savings figures are not double-counted.");
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
// ax cost images [--days=N] [--limit=N] [--json]
// ---------------------------------------------------------------------------

const mb = (bytes: number): string => (bytes / 1_048_576).toFixed(2);

const cmdCostImages = (input: {
    readonly sinceDays: number;
    readonly limit: number;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const result = yield* fetchImageContext(read, { sinceDays: input.sinceDays, limit: input.limit });

        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }

        if (result.rows.length === 0) {
            console.log("(no image content in the requested window)");
            return;
        }

        type ImgRow = {
            session: string;
            origin: string;
            calls: string;
            mb: string;
            est_tok: string;
        };

        const rendered: ImgRow[] = result.rows.map((r) => ({
            // Strip "session:" prefix and any backtick-wrapped id
            session: r.session.replace(/^session:/, "").replace(/^`(.*)`$/, "$1").slice(0, 14),
            origin: r.origin,
            calls: integer(r.calls),
            mb: mb(r.bytes),
            est_tok: integer(r.estTokens),
        }));

        const cols: Column<ImgRow>[] = [
            { header: "session", get: (r) => r.session, width: 14 },
            { header: "origin", get: (r) => r.origin, width: 8 },
            { header: "calls", get: (r) => r.calls, align: "right", width: 6 },
            { header: "MB", get: (r) => r.mb, align: "right", width: 9 },
            { header: "est_tok", get: (r) => r.est_tok, align: "right", width: 10 },
        ];

        console.log(renderTable({ columns: cols, rows: rendered, gap: " " }));
        console.log();
        const t = result.totals;
        console.log(
            `main-thread image context: ${mb(t.mainBytes)} MB (${integer(t.mainCalls)} calls) - persists + re-bills across turns`,
        );
        console.log(`subagent: ${mb(t.subagentBytes)} MB (${integer(t.subagentCalls)} calls) - isolated`);
        console.log(`\n(${input.sinceDays} days)`);
    });

const costImagesCommand = Command.make(
    "images",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(COST_DEFAULT_WINDOW_DAYS)),
        limit: positiveLimit(20),
        json: jsonFlag,
    },
    ({ days, limit, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax cost images: --days must be a positive integer (got "${days}")`);
        }
        if (!Number.isInteger(limit) || limit <= 0) {
            fail(`ax cost images: --limit must be a positive integer (got "${limit}")`);
        }
        return cmdCostImages({ sinceDays: days, limit, json });
    },
).pipe(
    Command.withDescription(
        "Image-read context cost per session split by main-thread vs subagent. " +
        "--days=N (default 14)  --limit=N (default 20)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax cost attribution [--days=N] [--limit=N] [--json]
// ---------------------------------------------------------------------------

const cmdCostAttribution = (input: {
    readonly sinceDays: number;
    readonly limit: number;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const result = yield* fetchAttributionCost(read, { sinceDays: input.sinceDays, limit: input.limit });

        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }

        const cov = result.coverage;
        if (cov.attributedTurns === 0) {
            console.log("(no natively-attributed usage rows in the requested window)");
            console.log(
                "Claude Code writes attributionSkill/attributionAgent since ~2026-05; " +
                    "pre-existing sessions read null until `ax ingest --reparse=claude` backfills them.",
            );
            return;
        }

        type Row = { name: string; turns: string; sessions: string; tokens: string; cost: string };
        const render = (kind: string, rows: ReadonlyArray<AttributionRow>): void => {
            if (rows.length === 0) return;
            const rendered: Row[] = rows.map((r) => ({
                name: r.name.slice(0, 40),
                turns: integer(r.turns),
                sessions: integer(r.sessions),
                tokens: integer(r.tokens),
                cost: usd(r.costUsd),
            }));
            const cols: Column<Row>[] = [
                { header: kind, get: (r) => r.name, min: 24 },
                { header: "turns", get: (r) => r.turns, align: "right", min: 6 },
                { header: "sessions", get: (r) => r.sessions, align: "right", min: 8 },
                { header: "tokens", get: (r) => r.tokens, align: "right", min: 12 },
                { header: "cost", get: (r) => r.cost, align: "right", min: 9 },
            ];
            console.log(renderTable({ columns: cols, rows: rendered, gap: " " }));
            console.log();
        };

        render("skill (native)", result.skills);
        render("agent (native)", result.agents);

        // `pct` renders a 0-100 value (n.toFixed(1) + "%"), not a 0-1 fraction
        // (#881: 64,153/166,677 printed as "0.4%").
        const turnShare = cov.totalTurns > 0 ? (100 * cov.attributedTurns) / cov.totalTurns : 0;
        const costShare = cov.totalCostUsd > 0 ? (100 * cov.attributedCostUsd) / cov.totalCostUsd : 0;
        console.log(
            `coverage: ${integer(cov.attributedTurns)}/${integer(cov.totalTurns)} claude usage rows ` +
                `(${pct(turnShare)}) carry native attribution - ${usd(cov.attributedCostUsd)} of ${usd(cov.totalCostUsd)} (${pct(costShare)})`,
        );
        if (result.cacheMissReasons.length > 0) {
            const mix = result.cacheMissReasons.map((r) => `${r.reason}×${integer(r.turns)}`).join(", ");
            console.log(`cache misses: ${mix}`);
        }
        if (result.apiErrors.length > 0) {
            const mix = result.apiErrors.map((r) => `${r.status}×${integer(r.turns)}`).join(", ");
            console.log(`api errors: ${mix}`);
        }
        console.log(`\n(${input.sinceDays} days; native = harness-stamped, cross-check vs invoked-edge inference)`);
    });

const costAttributionCommand = Command.make(
    "attribution",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(COST_DEFAULT_WINDOW_DAYS)),
        limit: positiveLimit(20),
        json: jsonFlag,
    },
    ({ days, limit, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax cost attribution: --days must be a positive integer (got "${days}")`);
        }
        if (!Number.isInteger(limit) || limit <= 0) {
            fail(`ax cost attribution: --limit must be a positive integer (got "${limit}")`);
        }
        return cmdCostAttribution({ sinceDays: days, limit, json });
    },
).pipe(
    Command.withDescription(
        "Cost by NATIVE harness attribution (attributionSkill/attributionAgent per billing event, #867) " +
        "with cache-miss + api-error mix. --days=N (default 14)  --limit=N (default 20)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax cost cache [--days=N] [--limit=N] [--json]
// ---------------------------------------------------------------------------

const weekly = (costUsd: number, days: number): number => (costUsd * 7) / days;

const cmdCostCache = (input: {
    readonly sinceDays: number;
    readonly limit: number;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const result = yield* fetchCacheBustCost(read, { sinceDays: input.sinceDays, limit: input.limit });

        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }

        if (result.coverage.bustTurns === 0) {
            console.log("(no cache-bust events in the requested window)");
            console.log(
                "Claude Code stamps cache_miss_reason since ~2026-05; pre-existing sessions read null " +
                    "until `ax ingest --reparse=claude` backfills them, and the ledger populates at ingest.",
            );
            return;
        }

        type ReasonRow = { reason: string; busts: string; sessions: string; tokens: string; cost: string };
        const reasonRows: ReasonRow[] = result.reasons.map((r) => ({
            reason: r.reason,
            busts: integer(r.busts),
            sessions: integer(r.sessions),
            tokens: integer(r.tokens),
            cost: usd(r.costUsd),
        }));
        const reasonCols: Column<ReasonRow>[] = [
            { header: "cause", get: (r) => r.reason, min: 26 },
            { header: "busts", get: (r) => r.busts, align: "right", min: 6 },
            { header: "sessions", get: (r) => r.sessions, align: "right", min: 8 },
            { header: "tokens", get: (r) => r.tokens, align: "right", min: 12 },
            { header: "cost", get: (r) => r.cost, align: "right", min: 9 },
        ];
        console.log(renderTable({ columns: reasonCols, rows: reasonRows, gap: " " }));
        console.log();

        type OffRow = { name: string; busts: string; sessions: string; cost: string };
        const renderOffenders = (kind: string, rows: ReadonlyArray<CacheBustOffenderRow>): void => {
            if (rows.length === 0) return;
            const rendered: OffRow[] = rows.map((r) => ({
                name: r.name.slice(0, 40),
                busts: integer(r.busts),
                sessions: integer(r.sessions),
                cost: usd(r.costUsd),
            }));
            const cols: Column<OffRow>[] = [
                { header: kind, get: (r) => r.name, min: 26 },
                { header: "busts", get: (r) => r.busts, align: "right", min: 6 },
                { header: "sessions", get: (r) => r.sessions, align: "right", min: 8 },
                { header: "cost", get: (r) => r.cost, align: "right", min: 9 },
            ];
            console.log(renderTable({ columns: cols, rows: rendered, gap: " " }));
            console.log();
        };
        renderOffenders("offender (skill, native)", result.skills);
        renderOffenders("offender (agent, native)", result.agents);

        const cov = result.coverage;
        // `pct` renders a 0-100 value, not a 0-1 fraction (#881).
        const turnShare = cov.totalTurns > 0 ? (100 * cov.bustTurns) / cov.totalTurns : 0;
        const costShare =
            cov.totalCacheCreationUsd > 0 ? (100 * cov.bustCostUsd) / cov.totalCacheCreationUsd : 0;
        console.log(
            `coverage: ${integer(cov.bustTurns)}/${integer(cov.totalTurns)} claude usage rows ` +
                `(${pct(turnShare)}) carry a cache-miss reason - ${usd(cov.bustCostUsd)} of ` +
                `${usd(cov.totalCacheCreationUsd)} cache-creation spend (${pct(costShare)})`,
        );

        const corr = result.corroboration;
        if (
            corr.comparableRoots > 0
            && Number.isFinite(corr.estimatedUsd)
            && Number.isFinite(corr.otlpUsd)
            && corr.otlpUsd > 0
        ) {
            const deviation = 100 * relativeCostDelta(corr.estimatedUsd, corr.otlpUsd);
            // "differs by 0.0%" reads as identical; "agrees within 0.0%" read as
            // 0% agreement (#1031). Phrase it as the difference, not the agreement.
            const verdict = deviation <= 25 ? "differs by" : "DIVERGES by";
            console.log(
                `corroboration: OTLP root-session cost ${verdict} ${pct(deviation)} from transcript cost over ` +
                    `${integer(corr.comparableRoots)} comparable roots (<=25% is the proposal guard)`,
            );
        }

        const trims: string[] = [];
        const topSkill = result.skills[0];
        if (topSkill) trims.push(`top offender "${topSkill.name}" ≈ ${usd(weekly(topSkill.costUsd, input.sinceDays))}/week`);
        const topReason = result.reasons[0];
        if (topReason) trims.push(`top cause "${topReason.reason}" ≈ ${usd(weekly(topReason.costUsd, input.sinceDays))}/week`);
        if (trims.length > 0) console.log(`trimming: ${trims.join("; ")}`);

        console.log(
            `\n(${input.sinceDays} days; a bust = a billing event whose prompt cache missed; ` +
                "cost = the cache-creation tokens that re-established it on that turn)",
        );
    });

const costCacheCommand = Command.make(
    "cache",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(COST_DEFAULT_WINDOW_DAYS)),
        limit: positiveLimit(20),
        json: jsonFlag,
    },
    ({ days, limit, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax cost cache: --days must be a positive integer (got "${days}")`);
        }
        if (!Number.isInteger(limit) || limit <= 0) {
            fail(`ax cost cache: --limit must be a positive integer (got "${limit}")`);
        }
        return cmdCostCache({ sinceDays: days, limit, json });
    },
).pipe(
    Command.withDescription(
        "Cache-bust cost attribution (#868): bust events by cause, $ per cause, top offenders by native " +
        "attribution, and a trimming estimate. --days=N (default 14)  --limit=N (default 20)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax cost (group command)
// ---------------------------------------------------------------------------

export const costCommand = Command.make("cost").pipe(
    Command.withDescription(
        "Model/cost analytics: per-model rollup, top sessions, main-vs-subagent split, image context cost, native attribution, cache busts",
    ),
    Command.withSubcommands([
        costModelsCommand,
        costSessionsCommand,
        costSplitCommand,
        costRoutabilityCommand,
        costImagesCommand,
        costAttributionCommand,
        costCacheCommand,
    ]),
);

export const axCostRuntime: RuntimeManifest = {
    cost: "cache",
};
