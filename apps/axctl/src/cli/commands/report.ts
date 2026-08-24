/**
 * `ax report` / `ax insights` / `ax timeline` - one-shot read-only reporting
 * commands. Extracted from cli/index.ts (Phase 2 CLI split). Handlers take
 * typed option objects; no string-array round-trip.
 */
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { Flag } from "effect/unstable/cli";
import { LooseRowSchema } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import { prettyPrint } from "@ax/lib/json";
import { frictionTotalSql, INSIGHT_VIEWS, insightSqlForView, toolFailureTotalsSql } from "../../queries/insights.ts";
import { enrichInsightRows } from "../../queries/insights-enrich.ts";
import { formatInsightRows } from "../insights-format.ts";
import { writeDashboard } from "../../dashboard/report.ts";
import { extractSessionTimeline, SessionTimelineServiceLayer } from "../../timeline/service.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fmtCount, jsonFlag, optionValue, positiveLimit, requirePositiveInt } from "./shared.ts";

type InsightView = (typeof INSIGHT_VIEWS)[number];

const cmdInsights = (input: { readonly view: InsightView; readonly limit: number; readonly json: boolean }) =>
    Effect.gen(function* () {
        // Argument.choice("view", INSIGHT_VIEWS) already rejected unknown views
        // at parse time - the old isInsightView/exit(2) guard was dead code
        // through the CLI and is intentionally gone.
        const limit = requirePositiveInt("insights", "limit", input.limit);
        // The view is chosen at runtime out of 30 differently-shaped queries,
        // so the column set is not known here and rows decode as
        // `LooseRowSchema` - which is also what turns each view's `COUNT(*)`
        // BIGINT cells into numbers before they reach the formatter.
        const result = yield* cacheRows(
            LooseRowSchema,
            { sql: insightSqlForView(input.view, limit), params: [] },
            `insights.${input.view}`,
        );
        // Classifier views resolve their per-row context here via indexed
        // lookups (the correlated $parent.session form scanned ~1s/row).
        const rows = yield* enrichInsightRows(input.view, [...result] as Array<Record<string, unknown>>);
        // JSON stays raw; the human views (tools/friction) gain a denominator
        // header + a cap hint so a raw count reads as a rate, and a full page
        // reads as "there is more" (#1027).
        if (!input.json) {
            const header = yield* insightDenominator(input.view);
            if (header) console.log(header);
        }
        console.log(formatInsightRows(input.view, [...rows], { json: input.json }));
        if (!input.json && rows.length >= limit) {
            console.log(`\n… showing the top ${limit}; raise with --limit=<n>.`);
        }
    });

/** A one-line denominator header for the count-heavy views (#1027). Empty for
 *  every other view. Reads all-time totals so the shown counts have a scale. */
const insightDenominator = (view: InsightView) =>
    Effect.gen(function* () {
        const numberOf = (row: Record<string, unknown> | undefined, key: string): number => {
            const v = row?.[key];
            return typeof v === "number" && Number.isFinite(v) ? v : 0;
        };
        if (view === "tools") {
            const [totals] = yield* cacheRows(
                LooseRowSchema,
                { sql: toolFailureTotalsSql(), params: [] },
                "insights.tools.totals",
            );
            const total = numberOf(totals, "total_calls");
            const failing = numberOf(totals, "failing_calls");
            if (total === 0) return "";
            const pct = ((failing / total) * 100).toFixed(1);
            return `${failing.toLocaleString("en-US")} failing tool calls of ${total.toLocaleString("en-US")} total (${pct}%), all-time:\n`;
        }
        if (view === "friction") {
            const [totals] = yield* cacheRows(
                LooseRowSchema,
                { sql: frictionTotalSql(), params: [] },
                "insights.friction.totals",
            );
            const total = numberOf(totals, "total");
            if (total === 0) return "";
            return `${total.toLocaleString("en-US")} friction events, all-time:\n`;
        }
        return "";
    });

const cmdReport = (input: { readonly limit: number; readonly out: string | undefined }) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("report", "limit", input.limit);
        const result = yield* writeDashboard({ out: input.out, limit });
        console.log(`report: ${result.url}`);
        console.log(
            `evidence: tools=${fmtCount(result.data.counts.toolCalls)} plans=${fmtCount(
                result.data.counts.planSnapshots,
            )} friction=${fmtCount(
                result.data.counts.frictionEvents,
            )} sessions=${fmtCount(result.data.counts.sessions)}`,
        );
    });

const insightView = Argument.choice("view", INSIGHT_VIEWS).pipe(Argument.withDefault("repositories"));

export const insightsCommand = Command.make(
    "insights",
    {
        view: insightView,
        limit: positiveLimit(20),
        json: jsonFlag,
    },
    ({ view, limit, json }) => cmdInsights({ view, limit, json }),
).pipe(Command.withDescription("Run built-in graph insight queries"));

export const reportCommand = Command.make(
    "report",
    {
        limit: positiveLimit(12),
        out: Flag.string("out").pipe(Flag.optional),
    },
    ({ limit, out }) => cmdReport({ limit, out: optionValue(out) }),
).pipe(Command.withDescription("Write a static evidence report (one-shot HTML snapshot)"));

const cmdTimeline = (sessionId: string, json: boolean) =>
    extractSessionTimeline(sessionId).pipe(
        Effect.provide(SessionTimelineServiceLayer),
        Effect.flatMap((tl) =>
            Effect.sync(() => {
                if (json) {
                    console.log(prettyPrint(tl));
                    return;
                }
                const h = tl.highlights;
                const dur = h.duration_ms != null ? `${(h.duration_ms / 3_600_000).toFixed(1)}h` : "?";
                const total = Object.values(h.event_counts).reduce((a, b) => a + b, 0);
                console.log(`${h.model ?? "?"} · ${h.repository ?? ""} · ${dur} · ${h.turns} turns · ${h.tool_calls} tools · ${h.tool_errors} errs · ${h.files_changed} files · $${h.cost_usd?.toFixed(2) ?? "?"}`);
                console.log(`${tl.segments.length} segments · ${tl.events.length} key events (of ${total})\n`);
                for (const s of tl.segments) {
                    const r = s.rollup;
                    console.log(`  ${s.id} [${s.boundary}] ${s.title}`);
                    console.log(`     ${s.event_count} evts · ${r.tool_calls} tools · ${r.file_edits} edits · ${r.failures} fail/${r.recovered} rec · ${r.decisions} dec · ${r.checkpoints} chk · ${r.corrections} corr`);
                }
            })
        ),
    );

export const timelineCommand = Command.make(
    "timeline",
    { sessionId: Argument.string("session-id"), json: jsonFlag },
    ({ sessionId, json }) => cmdTimeline(sessionId, json),
).pipe(Command.withDescription(
    "Highlight/event timeline for a session (segments + ranked events, LLM-free). --json for the full structure.",
));

/**
 * All three are on the v2 cache runtime. An earlier chunk left `report` and
 * `insights` on the old runtime and recorded them as blocked on "~1100 lines of
 * SurrealQL across 31 views" - **that reading was wrong**. `queries/insights.ts`
 * was already DuckDB dialect (#819); what still reached the old engine was the
 * two HANDLERS, `cmdInsights` above and the five statements in
 * `dashboard/report.ts`. The throwing proxy that reported the block named a
 * FAILURE, not a layer, and the SQL was never opened before the size was
 * asserted.
 */
export const reportRuntime: RuntimeManifest = {
    report: { runtime: "cache", hidden: true },
    insights: { runtime: "cache", hidden: true },
    timeline: { runtime: "cache", hidden: true },
};
