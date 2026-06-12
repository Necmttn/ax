/**
 * Pure card builders for the /api/next-actions panel.
 *
 * Each builder takes its data source rows and returns NextActionCard[],
 * sorted by impact descending and capped at PER_SOURCE_CAP.
 *
 * These are PURE functions - no DB access. The Effect aggregator
 * fetchNextActions (below) orchestrates fetching and calls these builders.
 */

import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type {
    NextActionCard,
    NextActionKind,
    NextActionsPayload,
    NextActionsSourceNote,
    ProposalDto,
    ToolFailureEntry,
    ToolFailuresResponse,
} from "@ax/lib/shared/dashboard-types";
import type { SessionChurnSummary } from "../metrics/session-churn.ts";
import { fetchSessionChurnSummary } from "../metrics/session-churn.ts";
import type { CandidatesResult } from "../queries/dispatch-analytics.ts";
import { fetchDispatchCandidates } from "../queries/dispatch-analytics.ts";
import type { SkillHygieneRow } from "../queries/skill-hygiene.ts";
import { fetchSkillHygiene } from "../queries/skill-hygiene.ts";
import { fetchImproveProposals, proposalReviewBrief } from "./improve-proposals.ts";
import { fetchToolFailures } from "./tool-failures.ts";
import { renderAgentBrief } from "./agent-brief.ts";

// ---------------------------------------------------------------------------
// Ranking constants
// ---------------------------------------------------------------------------

const KIND_WEIGHT: Record<NextActionKind, number> = {
    verdict: 90,
    proposal: 80,
    tool_failure: 70,
    routing: 60,
    churn: 50,
    skill_hygiene: 40,
};

const CONFIDENCE_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** Clamp a raw per-source score to [0, 9] for the bonus component. */
const bonus = (n: number): number => Math.max(0, Math.min(9, Math.round(n)));

/** Maximum cards returned per source builder. */
const PER_SOURCE_CAP = 5;

/** Shared builder trailer: sort by impact descending, cap at PER_SOURCE_CAP. */
const capByImpact = (cards: NextActionCard[]): NextActionCard[] =>
    cards.sort((a, b) => b.impact - a.impact).slice(0, PER_SOURCE_CAP);

/** Null-safe interpolation: nullable DB strings must never render "null". */
const nn = (v: string | null, fallback = "unknown"): string => v ?? fallback;

// ---------------------------------------------------------------------------
// proposalCards
// ---------------------------------------------------------------------------

/**
 * Cards for open improve proposals: review + accept or reject each one.
 */
export const proposalCards = (
    proposals: ReadonlyArray<ProposalDto>,
): NextActionCard[] =>
    capByImpact(
        proposals
            .filter((p) => p.status === "open")
            .map((p): NextActionCard => {
                const cw = CONFIDENCE_WEIGHT[p.confidence] ?? 1;
                return {
                    id: `proposal:${p.dedupe_sig}`,
                    kind: "proposal",
                    title: `Decide proposal: ${p.title}`,
                    evidence: `${p.form} proposal, confidence ${p.confidence}, seen ${p.frequency}x`,
                    impact: KIND_WEIGHT.proposal + bonus(cw * Math.log2(p.frequency + 1)),
                    brief: proposalReviewBrief(p),
                    link: null,
                    inline_action: {
                        type: "accept",
                        sig: p.dedupe_sig,
                        skill: null,
                        suggested_verdict: null,
                    },
                };
            }),
    );

// ---------------------------------------------------------------------------
// verdictCards
// ---------------------------------------------------------------------------

/**
 * Cards for accepted proposals whose experiment needs a verdict locked.
 * Only includes proposals where:
 * - status === "accepted"
 * - experiment exists
 * - experiment.locked_verdict is null/undefined (not yet decided)
 */
export const verdictCards = (
    proposals: ReadonlyArray<ProposalDto>,
): NextActionCard[] =>
    capByImpact(
        proposals
            .filter(
                (p) =>
                    p.status === "accepted" &&
                    p.experiment != null &&
                    (p.experiment.locked_verdict == null),
            )
            .map((p): NextActionCard => {
                const experiment = p.experiment!;
                const suggested = experiment.latest_checkpoint?.suggested ?? null;
                const evidenceLine = suggested != null
                    ? `experiment scaffolded, suggested verdict: ${suggested}`
                    : "experiment scaffolded, no checkpoint yet";

                return {
                    id: `verdict:${p.dedupe_sig}`,
                    kind: "verdict",
                    title: `Lock verdict: ${p.title}`,
                    evidence: evidenceLine,
                    impact: KIND_WEIGHT.verdict + bonus(suggested != null ? 3 : 0),
                    brief: renderAgentBrief({
                        title: `Lock verdict for experiment: ${p.title}`,
                        evidence: `experiment status: ${experiment.status ?? "unknown"}; ${evidenceLine}`,
                        ask: `Lock the verdict (suggested: ${suggested ?? "none"}) via the Improve dashboard or \`ax improve\` CLI; if evidence is thin, check retro notes first.`,
                        verify: "`ax improve show` reports a locked verdict for this experiment.",
                        source: `ax improve proposal sig=${p.dedupe_sig}`,
                    }),
                    link: null,
                    inline_action: {
                        type: "verdict",
                        sig: p.dedupe_sig,
                        skill: null,
                        suggested_verdict: suggested as string | null,
                    },
                };
            }),
    );

// ---------------------------------------------------------------------------
// toolFailureCards
// ---------------------------------------------------------------------------

/**
 * Cards for tool failure clusters that warrant fixing.
 */
export const toolFailureCards = (
    failures: ReadonlyArray<ToolFailureEntry>,
): NextActionCard[] =>
    capByImpact(
        failures
            .filter((f) => f.recommendation === "fix")
            .map((f): NextActionCard => {
                const extraEvidence: string[] = [];
                if (f.last_error_text != null) extraEvidence.push(`last error: ${f.last_error_text}`);
                if (f.last_project != null) extraEvidence.push(`project: ${f.last_project}`);

                return {
                    id: `tool_failure:${f.label}`,
                    kind: "tool_failure",
                    title: `Fix \`${f.label}\` failure cluster`,
                    evidence: `${f.failure_count} failures / ${f.distinct_sessions} sessions, exits [${f.exit_codes.join(", ")}]`,
                    impact: KIND_WEIGHT.tool_failure + bonus(Math.log2(f.failure_count)),
                    brief: renderAgentBrief({
                        title: `Fix \`${f.label}\` failure cluster`,
                        evidence: [
                            `${f.failure_count} failures across ${f.distinct_sessions} sessions`,
                            ...extraEvidence,
                        ].join("; "),
                        ask: "Diagnose the dominant failure mode and fix root cause (env, flag, or guard).",
                        verify: `failure_count for this label stops growing in /api/tool-failures over the next 7d`,
                        source: `ax tool-failure label=${f.label}`,
                    }),
                    link: "/tools",
                    inline_action: null,
                };
            }),
    );

// ---------------------------------------------------------------------------
// churnCards
// ---------------------------------------------------------------------------

/**
 * Cards for churny sessions: sessions with high repair LOC or many verification failures.
 *
 * Outlier criteria (either):
 *   - repair >= 100 AND repair >= 50% of landed LOC
 *   - verificationFailures >= 5
 */
export const churnCards = (summary: SessionChurnSummary): NextActionCard[] =>
    capByImpact(
        summary.hotSessions.flatMap((row): NextActionCard[] => {
            const repair = row.repairLinesAdded + row.repairLinesRemoved;
            const landed = row.landedLinesAdded + row.landedLinesRemoved;
            const repairOutlier = repair >= 100 && repair >= 0.5 * Math.max(landed, 1);
            const failureOutlier = row.verificationFailures >= 5;
            if (!repairOutlier && !failureOutlier) return [];

            const label = row.taskLabel ?? row.source ?? "unknown";
            return [{
                id: `churn:${row.session}`,
                kind: "churn",
                title: `Investigate churny session ${row.session}`,
                evidence: `${row.session} (${label}): ${repair} repair LOC vs ${landed} landed, ${row.verificationFailures} failed checks`,
                impact: KIND_WEIGHT.churn + bonus(row.verificationFailures),
                brief: renderAgentBrief({
                    title: `Churny session: ${row.session}`,
                    evidence: `${repair} repair LOC vs ${landed} landed; ${row.verificationFailures} verification failures; top check: ${row.topCheck ?? "unknown"}`,
                    ask: "Reconstruct what kept failing (ax sessions show <id>) and turn the recurring failure into a proposal (guidance/hook/skill).",
                    verify: "the same failure family does not reopen in `ax sessions churn` next window.",
                    source: `ax sessions churn session=${row.session}`,
                }),
                link: `/sessions/${row.session}`,
                inline_action: null,
            }];
        }),
    );

// ---------------------------------------------------------------------------
// routingCards
// ---------------------------------------------------------------------------

/**
 * Cards for dispatch routing opportunities: inherit+expensive dispatches that match
 * a routing class and could save money by routing to a cheaper model.
 *
 * Dedupes by routing class id - keeps the highest-savings candidate per class.
 */
export const routingCards = (result: CandidatesResult): NextActionCard[] => {
    // Dedupe by classId - keep highest est_savings_usd per class
    const byClass = new Map<string, (typeof result.candidates)[number]>();
    for (const candidate of result.candidates) {
        const classId = candidate.routing_match.classId;
        const existing = byClass.get(classId);
        if (existing == null || candidate.est_savings_usd > existing.est_savings_usd) {
            byClass.set(classId, candidate);
        }
    }

    return capByImpact(
        [...byClass.values()]
            .filter((c) => c.est_savings_usd >= 0.01)
            .map((c): NextActionCard => {
                const classId = c.routing_match.classId;
                return {
                    id: `routing:${classId}`,
                    kind: "routing",
                    title: `Route ${classId} dispatches to ${c.suggested_model}`,
                    evidence: `$${c.est_savings_usd.toFixed(2)} est savings - "${nn(c.description)}" went to ${nn(c.child_model)}`,
                    impact: KIND_WEIGHT.routing + bonus(c.est_savings_usd),
                    brief: renderAgentBrief({
                        title: `Route ${classId} dispatches to ${c.suggested_model}`,
                        evidence: `${c.routing_match.reason}; child ran on ${nn(c.child_model)}; est savings $${c.est_savings_usd.toFixed(2)}`,
                        ask: "Add an explicit model to this dispatch pattern (or extend the routing class) so it stops inheriting the frontier model.",
                        verify: "`ax dispatches --candidates` no longer lists this class.",
                        source: `ax dispatches class=${classId}`,
                    }),
                    link: null,
                    inline_action: null,
                };
            }),
    );
};

// ---------------------------------------------------------------------------
// skillHygieneCards
// ---------------------------------------------------------------------------

/**
 * Cards for unclassified skills that have enough invocations to warrant tagging.
 */
export const skillHygieneCards = (
    rows: ReadonlyArray<SkillHygieneRow>,
): NextActionCard[] =>
    capByImpact(
        rows.map((row): NextActionCard => ({
            id: `skill_hygiene:${row.name}`,
            kind: "skill_hygiene",
            title: `Classify skill ${row.name}`,
            evidence: `${row.invocations} invocations, no role`,
            impact: KIND_WEIGHT.skill_hygiene + bonus(Math.log2(row.invocations)),
            brief: renderAgentBrief({
                title: `Classify skill: ${row.name}`,
                evidence: `${row.invocations} invocations, no role assigned`,
                ask: `Run \`ax skills classify ${row.name}\` and fill the emitted brief, or \`ax skills tag ${row.name} <role>\`.`,
                verify: "`ax skills roles` lists a role for it; it leaves the unclassified pool.",
                source: `ax skills classify candidate=${row.name}`,
            }),
            link: "/skills",
            inline_action: {
                type: "decide",
                sig: null,
                skill: row.name,
                suggested_verdict: null,
            },
        })),
    );

// ---------------------------------------------------------------------------
// aggregator
// ---------------------------------------------------------------------------

const CHURN_WINDOW_DAYS = 14;
const ROUTING_WINDOW_DAYS = 14;

/**
 * Per-source timeout: a slow source degrades to a note instead of blocking
 * the panel. The churn leg currently exceeds this (~9s fixed cost - see
 * https://github.com/Necmttn/ax/issues/326); routing and others are typically
 * fast but may spike.
 */
const SOURCE_TIMEOUT_MS = 4_000;

/**
 * Fan-out to 5 data sources (proposals, tool failures, churn, routing, skill
 * hygiene), merge and sort all cards by impact descending.
 *
 * Each leg is fail-open: a DB error or timeout becomes a NextActionsSourceNote,
 * never a typed failure. The returned Effect has error type `never` for source
 * failures; only truly unexpected defects (bugs) can still escape.
 */
export const fetchNextActions = Effect.fn("dashboard.fetchNextActions")(function* (
    opts?: { readonly sourceTimeoutMs?: number },
) {
    const timeoutMs = opts?.sourceTimeoutMs ?? SOURCE_TIMEOUT_MS;

    // Mutated from concurrent legs; safe because JS fibers interleave only at
    // yield points - the push inside Effect.sync runs atomically.
    const notes: Array<NextActionsSourceNote> = [];

    /** Wrap an effect so errors (including timeouts) become notes + an empty fallback value.
     *
     * The timeout is applied BEFORE the catch. Effect.timeoutOrElse interrupts
     * the inner fiber and fails with a timeout error; that error is then caught
     * by our Effect.catch and lands in notes. This works even when the inner
     * effect has its own internal swallow (e.g. runQuery's Effect.catch for
     * DbErrors): fiber interruption from timeoutOrElse bypasses inner catches,
     * so the orElse failure propagates to our outer catch. Consequently all 5
     * sources - including tool_failure which normally swallows DB errors
     * internally - will add a note when the DB hangs.
     */
    const guarded = <A>(
        source: NextActionKind,
        eff: Effect.Effect<A, unknown, SurrealClient>,
        empty: A,
    ): Effect.Effect<A, never, SurrealClient> =>
        eff.pipe(
            Effect.timeoutOrElse({
                duration: `${timeoutMs} millis`,
                orElse: () =>
                    Effect.fail(new Error(`source ${source} timed out after ${timeoutMs}ms`)),
            }),
            Effect.catch((err) =>
                Effect.sync(() => {
                    notes.push({ source, note: String(err) });
                    return empty;
                }),
            ),
        );

    const [proposals, failures, churn, routing, hygiene] = yield* Effect.all(
        [
            guarded("proposal", fetchImproveProposals(), [] as ReadonlyArray<ProposalDto>),
            guarded("tool_failure", fetchToolFailures(), null as ToolFailuresResponse | null),
            guarded(
                "churn",
                fetchSessionChurnSummary({
                    since: new Date(Date.now() - CHURN_WINDOW_DAYS * 86_400_000),
                    limit: 20,
                }),
                null as SessionChurnSummary | null,
            ),
            guarded("routing", fetchDispatchCandidates({ sinceDays: ROUTING_WINDOW_DAYS }), null as CandidatesResult | null),
            guarded("skill_hygiene", fetchSkillHygiene({ minInvocations: 3, limit: 10 }), [] as ReadonlyArray<SkillHygieneRow>),
        ] as const,
        { concurrency: 3 },
    );

    const cards: NextActionCard[] = [
        ...proposalCards(proposals),
        ...verdictCards(proposals),
        ...(failures != null ? toolFailureCards(failures.failures) : []),
        ...(churn != null ? churnCards(churn) : []),
        ...(routing != null ? routingCards(routing) : []),
        ...skillHygieneCards(hygiene),
    ].sort((a, b) => b.impact - a.impact);

    return { generatedAt: new Date().toISOString(), cards, notes } satisfies NextActionsPayload;
});
