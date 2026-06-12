import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { ImpactEstimate, ProposalDto } from "@ax/lib/shared/dashboard-types";
import { fetchDispatchCandidates } from "../queries/dispatch-analytics.ts";

/**
 * Projected impact per proposal - the "what is this worth" engine
 * (spec: improve loop v2). Estimators reuse existing analytics; every
 * estimate states its basis and an honesty tier. Post-accept, checkpoint
 * measurements supersede these (rendered side by side in the UI).
 */

/** Stable mined-routing proposal title (derive-proposals.ts:191). */
export const ROUTING_PROPOSAL_TITLE = "Route mechanical subagent dispatches to cheaper models";

const ROUTING_WINDOW_DAYS = 30;
const HOOK_WINDOW_DAYS = 30;

export const parseBaseline = (p: ProposalDto): Record<string, unknown> => {
    const raw = (p as { baseline?: unknown }).baseline;
    if (typeof raw !== "string" || raw.length === 0) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
};

const usd = (n: number): string =>
    `$${n >= 100 ? Math.round(n).toLocaleString("en") : n.toFixed(2)}`;

const isRoutingProposal = (p: ProposalDto): boolean =>
    p.form === "hook" && p.title === ROUTING_PROPOSAL_TITLE;

const routingImpact = Effect.fn("improve.routingImpact")(function* () {
    const result = yield* fetchDispatchCandidates({ sinceDays: ROUTING_WINDOW_DAYS });
    const total = result.total_est_savings_usd;
    const top = result.top_classes
        .slice(0, 3)
        .map((c) => `${c.classId} (${usd(c.savings_usd)})`)
        .join(", ");
    return {
        kind: "savings_usd",
        headline: `~${usd(total)} redirectable over ${ROUTING_WINDOW_DAYS}d`,
        detail: `${result.candidates.length} model-less dispatches on expensive models matched mechanical routing classes${top ? `. Top classes: ${top}` : ""}.`,
        basis: `recomputed from your last ${ROUTING_WINDOW_DAYS}d of dispatch history (est_savings = actual child cost repriced at the suggested model)`,
        confidence: "estimated",
    } satisfies ImpactEstimate;
});

const TOOL_STATS_SQL = (
    tool: string,
) => `SELECT count() AS n FROM tool_call WHERE name = ${JSON.stringify(tool)} AND ts > time::now() - ${HOOK_WINDOW_DAYS}d GROUP ALL;
SELECT count() AS n FROM tool_call WHERE name = ${JSON.stringify(tool)} AND status = "error" AND ts > time::now() - ${HOOK_WINDOW_DAYS}d GROUP ALL;`;

const hookImpact = Effect.fn("improve.hookImpact")(function* (tool: string) {
    const db = yield* SurrealClient;
    const [totalRows, failRows] = yield* db.query<
        [Array<{ n: number }>, Array<{ n: number }>]
    >(TOOL_STATS_SQL(tool));
    const total = Number(totalRows?.[0]?.n ?? 0);
    const failures = Number(failRows?.[0]?.n ?? 0);
    return {
        kind: "addressable_failures",
        headline: `intersects ${failures.toLocaleString("en")} failures (of ${total.toLocaleString("en")} ${tool} calls) in ${HOOK_WINDOW_DAYS}d`,
        detail: failures > 0
            ? `A guard on ${tool} sits in front of every one of those calls - the ${failures} that failed are its addressable surface.`
            : `No recent ${tool} failures - this guard would be insurance, not triage.`,
        basis: `your last ${HOOK_WINDOW_DAYS}d of tool_call history; addressable surface, not a replay (the hook isn't built yet)`,
        confidence: "indicative",
    } satisfies ImpactEstimate;
});

/** The HEADLINE always uses the live frequency (matches the card chip);
 *  the frozen baseline frequency becomes a growth note when it differs. */
const growthNote = (p: ProposalDto, baseline: Record<string, unknown>): string => {
    const frozen = Number(baseline.frequency ?? 0);
    return frozen > 0 && frozen !== p.frequency
        ? ` It was ${frozen}x when first proposed - still recurring.`
        : "";
};

const guidanceImpact = (p: ProposalDto, baseline: Record<string, unknown>): ImpactEstimate => {
    const evidence = typeof baseline.evidence === "string" ? baseline.evidence : null;
    return {
        kind: "correction_pressure",
        headline: `${p.frequency}× repeated correction pressure`,
        detail: (evidence
            ?? "The same correction keeps recurring across sessions; durable guidance removes the repeat-explanation tax.")
            + growthNote(p, baseline),
        basis: "correction clusters mined from your transcripts (frequency is the live count; growth vs the frozen baseline noted)",
        confidence: "indicative",
    };
};

const skillImpact = (p: ProposalDto, baseline: Record<string, unknown>): ImpactEstimate => {
    const tool = typeof baseline.tool === "string" ? baseline.tool : null;
    return {
        kind: "frequency",
        headline: `${p.frequency}× recurring friction${tool ? ` on ${tool}` : ""}`,
        detail: p.hypothesis + growthNote(p, baseline),
        basis: "failure/correction clusters mined from your transcripts (frequency is the live count; growth vs the frozen baseline noted)",
        confidence: "indicative",
    };
};

const fallbackImpact = (p: ProposalDto): ImpactEstimate => ({
    kind: "frequency",
    headline: `seen ${p.frequency}× in your history`,
    detail: p.hypothesis,
    basis: "signal frequency at proposal creation",
    confidence: "indicative",
});

export const estimateImpact = Effect.fn("improve.estimateImpact")(function* (
    p: ProposalDto,
) {
    if (isRoutingProposal(p)) return yield* routingImpact();
    if (p.form === "hook" && p.hook_payload?.target_tool) {
        return yield* hookImpact(p.hook_payload.target_tool);
    }
    const baseline = parseBaseline(p);
    if (p.form === "guidance") return guidanceImpact(p, baseline);
    if (p.form === "skill") return skillImpact(p, baseline);
    return fallbackImpact(p);
});

// ---------------------------------------------------------------------------
// Per-sig TTL cache. Failures are never stored (the lesson from ttl-cache).
// ---------------------------------------------------------------------------

const IMPACT_TTL_MS = 10 * 60_000;
const cache = new Map<string, { estimate: ImpactEstimate; at: number }>();

export const estimateImpactCached = Effect.fn("improve.estimateImpactCached")(
    function* (p: ProposalDto, nowMs: number) {
        const hit = cache.get(p.dedupe_sig);
        if (hit && nowMs - hit.at < IMPACT_TTL_MS) return hit.estimate;
        const estimate = yield* estimateImpact(p);
        cache.set(p.dedupe_sig, { estimate, at: nowMs });
        return estimate;
    },
);

export function resetImpactCacheForTest(): void {
    cache.clear();
}
