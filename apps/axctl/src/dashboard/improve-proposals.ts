import { Effect } from "effect";
import { CacheRead } from "@ax/lib/duckdb/seam";
import type { ProposalDto } from "@ax/lib/shared/dashboard-types";
import {
    estimateImpactCached,
    type ImpactEstimateCache,
    ROUTING_PROPOSAL_TITLE,
} from "../improve/impact.ts";
import { renderAgentBrief } from "./agent-brief.ts";
import { listStoredProposals, type StoredCheckpoint, type StoredProposal } from "../improve/judgment-proposals.ts";

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
    if (!template || !query || !/^SELECT\b/i.test(query.trim())) return p;
    const cache = deps.hydrationCache ?? defaultHydrationCache;
    const nowMs = currentMs(deps);
    const hit = cache.get(p.dedupe_sig, nowMs);
    if (hit !== null) {
        return { ...p, hypothesis: hit };
    }
    const read = yield* CacheRead;
    const hydrated = yield* read.raw(query).pipe(
        Effect.map((result) => {
            const row = result.rows[0];
            return row ? renderHypothesisTemplate(template, row) : null;
        }),
        Effect.catch(() => Effect.succeed(null)),
    );
    if (hydrated === null) return p;
    cache.set(p.dedupe_sig, hydrated, nowMs);
    return { ...p, hypothesis: hydrated };
});

const checkpointDto = (checkpoint: StoredCheckpoint) => {
    const measured = checkpoint.measured;
    const typedMeasured =
        typeof measured.opportunities === "number" &&
        typeof measured.addressed === "number" &&
        typeof measured.ratio === "number" &&
        typeof measured.built === "boolean"
            ? {
                opportunities: measured.opportunities,
                addressed: measured.addressed,
                ratio: measured.ratio,
                built: measured.built,
            }
            : null;
    return {
        kind: checkpoint.kind,
        suggested: checkpoint.suggested,
        user_verdict: checkpoint.user_verdict,
        measured: typedMeasured,
        observed_at: checkpoint.observed_at.toISOString(),
    };
};

const proposalDto = (proposal: StoredProposal): ProposalDto => {
    const checkpoints = proposal.experiment?.checkpoints.map(checkpointDto) ?? [];
    return {
        id: proposal.id,
        form: proposal.form,
        title: proposal.title,
        hypothesis: proposal.hypothesis,
        hypothesis_template: proposal.hypothesis_template,
        evidence_query: proposal.evidence_query,
        dedupe_sig: proposal.dedupe_sig,
        frequency: proposal.frequency,
        confidence: proposal.confidence,
        status: proposal.status,
        origin: proposal.origin,
        baseline: proposal.baseline,
        reject_reason: proposal.reject_reason,
        created_at: proposal.created_at.toISOString(),
        skill_payload: proposal.skill_payload,
        subagent_payload: proposal.subagent_payload,
        hook_payload: proposal.hook_payload,
        guidance_payload: proposal.guidance_payload,
        automation_payload: proposal.automation_payload,
        experiment: proposal.experiment === null ? null : {
            id: proposal.experiment.id,
            artifact_path: proposal.experiment.artifact_path,
            status: proposal.experiment.status,
            task_path: proposal.experiment.task_path,
            locked_verdict: proposal.experiment.locked_verdict,
            created_at: proposal.experiment.created_at.toISOString(),
            scaffolded_at: proposal.experiment.scaffolded_at?.toISOString() ?? null,
            latest_checkpoint: checkpoints.at(-1) ?? null,
            checkpoints,
        },
    };
};

/** Raw proposal rows, loosely typed at the edge like the legacy queryApi endpoints. */
export const fetchImproveProposals = Effect.fn("dashboard.fetchImproveProposals")(
    function* (deps: ImproveProposalHydrationDeps = {}) {
        const rows = (yield* listStoredProposals()).map(proposalDto);
        const hydrated = yield* Effect.all(rows.map((p) => hydrateHypothesis(p, deps)), {
            concurrency: 4,
        });
        return hydrated.map(withBrief);
    },
);
