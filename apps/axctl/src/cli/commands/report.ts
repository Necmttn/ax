/**
 * `ax report` / `ax insights` / `ax timeline` - one-shot read-only reporting
 * commands. Extracted from cli/index.ts (Phase 2 CLI split). Handlers take
 * typed option objects; no string-array round-trip.
 */
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { Flag } from "effect/unstable/cli";
import { SurrealClient } from "@ax/lib/db";
import { prettyPrint } from "@ax/lib/json";
import { INSIGHT_VIEWS, insightSqlForView } from "../../queries/insights.ts";
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
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(
            insightSqlForView(input.view, limit),
        );
        // Classifier views resolve their per-row context here via indexed
        // lookups (the correlated $parent.session form scanned ~1s/row).
        const rows = yield* enrichInsightRows(input.view, result?.[0] ?? []);
        console.log(formatInsightRows(input.view, [...rows], { json: input.json }));
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

export const reportRuntime: RuntimeManifest = {
    report: "db",
    insights: "db",
    timeline: "db",
};
