import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { ProposalDto } from "@ax/lib/shared/dashboard-types";
import {
    estimateImpactCached,
    type ImpactEstimateCache,
    ROUTING_PROPOSAL_TITLE,
} from "../improve/impact.ts";
import { renderAgentBrief } from "./agent-brief.ts";

// Experiment-loop shortlist + verdict state. Reads proposal +
// per-form payloads + the active experiment + newest checkpoint.
// See docs/superpowers/plans/2026-05-25-experiment-loop-cleanup-and-rebuild.md
// (Phase C10). Moved verbatim from server.ts queryApi (166-182).
const PROPOSALS_SQL = `
SELECT id, form, title, hypothesis, hypothesis_template, evidence_query, dedupe_sig, frequency, confidence, status, origin, baseline, reject_reason,
    type::string(created_at) AS created_at,
    (SELECT trigger_pattern, suspected_gap, proposed_behavior, expected_impact FROM skill_proposal      WHERE proposal = $parent.id LIMIT 1)[0] AS skill_payload,
    (SELECT bounded_role, delegation_trigger, example_task_patterns FROM subagent_proposal   WHERE proposal = $parent.id LIMIT 1)[0] AS subagent_payload,
    (SELECT event_name, target_tool, hook_command, recovery_path, smoke_test_command, disable_command, failure_mode FROM hook_proposal       WHERE proposal = $parent.id LIMIT 1)[0] AS hook_payload,
    (SELECT file_target, section, suggested_text FROM guidance_proposal   WHERE proposal = $parent.id LIMIT 1)[0] AS guidance_payload,
    (SELECT trigger_signal, schedule, action, recovery_path, smoke_test_command, disable_command, failure_mode FROM automation_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS automation_payload,
    (SELECT id, artifact_path, status, task_path, locked_verdict,
        type::string(created_at) AS created_at,
        type::string(scaffolded_at) AS scaffolded_at,
        (SELECT kind, suggested, user_verdict, measured, type::string(observed_at) AS observed_at FROM checkpoint WHERE experiment = $parent.id ORDER BY observed_at DESC LIMIT 1)[0] AS latest_checkpoint,
        (SELECT kind, suggested, user_verdict, measured, type::string(observed_at) AS observed_at FROM checkpoint WHERE experiment = $parent.id ORDER BY observed_at ASC) AS checkpoints
        FROM experiment WHERE proposal = $parent.id LIMIT 1)[0] AS experiment
FROM proposal
ORDER BY frequency DESC, created_at DESC
LIMIT 100;`;

/** Brief shown for an open proposal - shared by /api/improve rows and next-action cards. */
export const proposalReviewBrief = (p: ProposalDto): string =>
    renderAgentBrief({
        title: p.title,
        evidence: `hypothesis: ${p.hypothesis} (seen ${p.frequency}x, confidence ${p.confidence})`,
        ask: "Review this proposal; if sound, run `ax improve accept` and act on the emitted .ax/tasks brief.",
        verify: "`ax improve show` reflects the new status; follow the experiment checkpoints.",
        source: `ax improve proposal sig=${p.dedupe_sig}`,
    });

const withBrief = (p: ProposalDto): ProposalDto => ({
    ...p,
    // Rows created before the origin field exist read NONE.
    origin: p.origin ?? "mined",
    brief:
        p.status === "open"
            ? proposalReviewBrief(p)
            : renderAgentBrief({
                  title: p.title,
                  evidence: `hypothesis: ${p.hypothesis} (seen ${p.frequency}x, confidence ${p.confidence})`,
                  ask: "Act on the experiment for this proposal - check its artifact/task and lock a verdict via the Improve dashboard or `ax improve` CLI.",
                  verify: "`ax improve show` reflects the new status; follow the experiment checkpoints.",
                  source: `ax improve proposal sig=${p.dedupe_sig}`,
              }),
});

/** Fill {{placeholders}} from a result row; unknown keys stay literal so a
 *  template bug is visible, not silently blank. */
export const renderHypothesisTemplate = (
    template: string,
    row: Record<string, unknown>,
): string =>
    template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
        const v = row[key];
        if (v === undefined || v === null) return whole;
        return typeof v === "number" ? v.toLocaleString("en") : String(v);
    });

/** Hydrate proposals that carry a live evidence query: the template's
 *  numbers are recomputed at serve time, so mined/agent prose never
 *  expires. Fail-open per proposal - a broken query keeps the frozen
 *  hypothesis. Hydration results cache per sig for 5 minutes. */
const HYDRATE_TTL_MS = 5 * 60_000;

export interface HypothesisHydrationCache {
    readonly get: (dedupeSig: string, nowMs: number) => string | null;
    readonly set: (dedupeSig: string, hypothesis: string, nowMs: number) => void;
}

export const createHypothesisHydrationCache = (
    opts: { readonly ttlMs?: number } = {},
): HypothesisHydrationCache => {
    const ttlMs = opts.ttlMs ?? HYDRATE_TTL_MS;
    const cache = new Map<string, { hypothesis: string; at: number }>();
    return {
        get: (dedupeSig, nowMs) => {
            const hit = cache.get(dedupeSig);
            return hit && nowMs - hit.at < ttlMs ? hit.hypothesis : null;
        },
        set: (dedupeSig, hypothesis, nowMs) => {
            cache.set(dedupeSig, { hypothesis, at: nowMs });
        },
    };
};

export interface ImproveProposalHydrationDeps {
    readonly hydrationCache?: HypothesisHydrationCache;
    readonly impactCache?: ImpactEstimateCache;
    readonly nowMs?: () => number;
}

const defaultHydrationCache = createHypothesisHydrationCache();

const currentMs = (deps: ImproveProposalHydrationDeps): number =>
    deps.nowMs?.() ?? Date.now();

/** The mined routing proposal predates hypothesis_template/evidence_query,
 *  so its dollar figure freezes at mine time while the impact endpoint
 *  recomputes live. Builtin hydrator: rebuild the hypothesis from the SAME
 *  cached estimate the drawer serves - card chip, card body, brief, and
 *  drawer impact then cannot disagree. Fail-open: any error keeps the
 *  frozen text. */
const hydrateRoutingHypothesis = Effect.fn("dashboard.hydrateRoutingHypothesis")(
    function* (p: ProposalDto, deps: ImproveProposalHydrationDeps) {
        const est = yield* estimateImpactCached(p, currentMs(deps), deps.impactCache).pipe(
            Effect.catch(() => Effect.succeed(null)),
        );
        if (est === null || est.kind !== "savings_usd") return p;
        // the frozen "Apply: ..." tail is the action, not a measurement - keep it
        const apply = / Apply: .*$/.exec(p.hypothesis)?.[0] ?? "";
        // "~$608 redirectable over 30d" -> "est $608 ..." (the card chip parses "est $")
        const headline = est.headline.replace(/^~\$/, "est $");
        return { ...p, hypothesis: `${est.detail} ${headline}.${apply}` };
    },
);

const hydrateHypothesis = Effect.fn("dashboard.hydrateHypothesis")(function* (
    p: ProposalDto,
    deps: ImproveProposalHydrationDeps,
) {
    if (p.form === "hook" && p.title === ROUTING_PROPOSAL_TITLE) {
        return yield* hydrateRoutingHypothesis(p, deps);
    }
    const template = p.hypothesis_template;
    const query = p.evidence_query;
    if (!template || !query || !/^(SELECT|RETURN)\b/i.test(query.trim())) return p;
    const cache = deps.hydrationCache ?? defaultHydrationCache;
    const nowMs = currentMs(deps);
    const hit = cache.get(p.dedupe_sig, nowMs);
    if (hit !== null) {
        return { ...p, hypothesis: hit };
    }
    const db = yield* SurrealClient;
    const hydrated = yield* db.query<[Array<Record<string, unknown>>]>(query).pipe(
        Effect.map((result) => {
            const row = result[0]?.[0];
            return row ? renderHypothesisTemplate(template, row) : null;
        }),
        Effect.catch(() => Effect.succeed(null)),
    );
    if (hydrated === null) return p;
    cache.set(p.dedupe_sig, hydrated, nowMs);
    return { ...p, hypothesis: hydrated };
});

/** Raw proposal rows, loosely typed at the edge like the legacy queryApi endpoints. */
export const fetchImproveProposals = Effect.fn("dashboard.fetchImproveProposals")(
    function* (deps: ImproveProposalHydrationDeps = {}) {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(PROPOSALS_SQL);
        // TODO: replace with schema decode when the proposal wire shape stabilizes
        const rows = (result[0] ?? []) as unknown as ReadonlyArray<ProposalDto>;
        const hydrated = yield* Effect.all(rows.map((p) => hydrateHypothesis(p, deps)), {
            concurrency: 4,
        });
        return hydrated.map(withBrief);
    },
);
